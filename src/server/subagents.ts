/**
 * Subagent history: read the per-agent transcripts the CLI writes beside a
 * session file, and present them in the SAME shape as the main transcript route
 * so the UI's existing renderer works unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The task described `listSubagents(sessionId, {dir})` / `getSubagentMessages(…)`
 * as already exported from `src/lib/session-history.ts`. They are not — that
 * file exports 20 functions and neither is among them (verified against the
 * unmodified 1074-line file). Its header comment mentions the on-disk layout and
 * then says `<- subagent logs (ignored)`, i.e. it deliberately skips them:
 * `listSessionFiles` is documented as "excludes subagents/".
 *
 * The DATA is real, though, so this module reads it directly rather than
 * modifying the carried-over file.
 *
 * ---------------------------------------------------------------------------
 * ON-DISK FORMAT (verified against the real store on this machine)
 * ---------------------------------------------------------------------------
 *   <root>/<encodedDir>/<sessionId>/subagents/agent-<agentId>.jsonl
 *   <root>/<encodedDir>/<sessionId>/subagents/agent-<agentId>.meta.json
 *
 * meta.json is a single object, no trailing newline:
 *   { agentType, description, toolUseId, spawnDepth, model }
 *
 * The .jsonl is one JSON object per line, same grammar as a main transcript but
 * every entry carries `isSidechain: true` and `agentId`. Observed `type` values:
 * user / assistant / attachment.
 *
 * Neither file records status, timestamps-as-such, or usage totals, so those are
 * DERIVED here and each derivation is documented at its site. Nothing is
 * invented: a field that cannot be derived is reported as null.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as hist from '../lib/session-history.ts';

export interface SubagentUsage {
  /** Sum of assistant `usage` across the agent's own messages. Null if none carried usage. */
  total_tokens: number | null;
  /** Count of tool_use blocks in the agent's assistant messages. */
  tool_uses: number;
  /** last timestamp - first timestamp. Null when fewer than two entries carry one. */
  duration_ms: number | null;
}

export interface SubagentSummary {
  agentId: string;
  subagentType: string | null;
  description: string | null;
  /**
   * 'completed' | 'failed' — the parent session recorded a tool_result for this
   * agent's toolUseId (is_error decides which).
   * 'running'   — this is a LIVE session and the bridge still has it running.
   * 'unknown'   — no tool_result found and no live state. Not guessed.
   */
  status: 'completed' | 'failed' | 'running' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  usage: SubagentUsage;
  messageCount: number;
  fileBytes: number;
  toolUseId: string | null;
  model: string | null;
  spawnDepth: number | null;
}

export class SubagentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SubagentError';
    this.status = status;
  }
}

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

function safeSegment(s: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s.includes('..')) {
    throw new SubagentError(400, `${what} ${JSON.stringify(s)} contains characters that are not allowed in a path segment`);
  }
  return s;
}

/** `<root>/<encodedDir>/<sessionId>/subagents`, or null when absent. */
export function subagentsDir(encodedDir: string, sessionId: string, root = hist.defaultRoot()): string | null {
  safeSegment(encodedDir, 'encodedDir');
  safeSegment(sessionId, 'sessionId');
  const dir = path.join(root, encodedDir, sessionId, 'subagents');
  // Containment check, same discipline as resolveSessionFile.
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Find the encoded dir holding a session, when the caller did not say.
 * Deliberately NOT a guess-fest: it returns every dir that has the session's
 * subagents directory, and the caller decides. The store contains byte-identical
 * duplicates of the same session id across OS dirs, so "first match" is fine
 * only because we then read a specific agent file from that same dir.
 */
export function findDirsForSession(sessionId: string, root = hist.defaultRoot()): string[] {
  safeSegment(sessionId, 'sessionId');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (subagentsDir(e.name, sessionId, root)) out.push(e.name);
  }
  return out.sort();
}

interface AgentMeta {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
  spawnDepth?: unknown;
  model?: unknown;
}

function readMeta(dir: string, agentId: string): AgentMeta {
  try {
    const raw = fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8');
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as AgentMeta) : {};
  } catch {
    // A missing/corrupt sidecar is not fatal — the transcript is still readable.
    return {};
  }
}

function parseLines(file: string, maxBytes: number): { entries: Record<string, any>[]; malformed: number; bytesRead: number; truncated: boolean } {
  const size = fs.statSync(file).size;
  const cap = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, 0);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  const truncated = cap < size;
  if (truncated) {
    // Drop the partial final line rather than counting it as malformed.
    const nl = text.lastIndexOf('\n');
    text = nl >= 0 ? text.slice(0, nl) : '';
  }
  const entries: Record<string, any>[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { entries, malformed, bytesRead: cap, truncated };
}

/** 64 MiB per agent file — these are far smaller than main transcripts. */
const AGENT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Statuses recorded by the PARENT session: agent toolUseId -> completed|failed.
 * The subagent files themselves record no outcome, so this is the only on-disk
 * source of truth for whether an agent finished cleanly.
 */
function parentToolResults(encodedDir: string, sessionId: string, root: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const file = hist.resolveSessionFile(encodedDir, sessionId, { root });
  if (!file) return out;
  let text: string;
  try {
    // Tail-only: tool_results for subagents are interleaved throughout, so read
    // the whole file but cap it — a 286 MB session must not be slurped.
    const size = fs.statSync(file).size;
    const cap = Math.min(size, 64 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, 0);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('tool_result')) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') out.set(b.tool_use_id, b.is_error === true);
    }
  }
  return out;
}

/** Summarise every subagent of a session. */
export function listSubagents(
  encodedDir: string,
  sessionId: string,
  opts: { root?: string } = {},
): SubagentSummary[] {
  const root = opts.root ?? hist.defaultRoot();
  const dir = subagentsDir(encodedDir, sessionId, root);
  if (!dir) return [];
  const results = parentToolResults(encodedDir, sessionId, root);
  const out: SubagentSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = AGENT_FILE.exec(name);
    if (!m) continue;
    const agentId = m[1]!;
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    const { entries } = parseLines(file, AGENT_MAX_BYTES);
    const meta = readMeta(dir, agentId);

    const stamps = entries.map((e) => (typeof e.timestamp === 'string' ? e.timestamp : null)).filter((s): s is string => !!s);
    const startedAt = stamps[0] ?? null;
    const endedAt = stamps.length ? stamps[stamps.length - 1]! : null;

    let tokens = 0;
    let sawUsage = false;
    let toolUses = 0;
    let messageCount = 0;
    for (const e of entries) {
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      /*
       * Count what the messages endpoint will actually RENDER, not raw entries.
       * Counting entries reported 37 for an agent whose transcript route returns
       * 23, because tool_result-only user turns carry no renderable block at the
       * default `tools=0`. A count the UI cannot reconcile with what it draws is
       * a bug report waiting to happen.
       */
      const c = e.message?.content;
      const renderable =
        typeof c === 'string'
          ? c.length > 0
          : Array.isArray(c) && (c as Record<string, any>[]).some((b) => b?.type && b.type !== 'tool_result');
      if (renderable) messageCount++;
      if (e.type !== 'assistant') continue;
      const u = e.message?.usage;
      if (u && typeof u === 'object') {
        sawUsage = true;
        // Same components the SDK's own token totals use.
        tokens +=
          Number(u.input_tokens ?? 0) +
          Number(u.output_tokens ?? 0) +
          Number(u.cache_creation_input_tokens ?? 0) +
          Number(u.cache_read_input_tokens ?? 0);
      }
      for (const b of (e.message?.content ?? []) as Record<string, any>[]) if (b?.type === 'tool_use') toolUses++;
    }

    const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
    let status: SubagentSummary['status'] = 'unknown';
    if (toolUseId && results.has(toolUseId)) status = results.get(toolUseId) ? 'failed' : 'completed';

    out.push({
      agentId,
      subagentType: typeof meta.agentType === 'string' ? meta.agentType : null,
      description: typeof meta.description === 'string' ? meta.description : null,
      status,
      startedAt,
      endedAt,
      usage: {
        total_tokens: sawUsage ? tokens : null,
        tool_uses: toolUses,
        duration_ms: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
      },
      messageCount,
      fileBytes: st.size,
      toolUseId,
      model: typeof meta.model === 'string' ? meta.model : null,
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
    });
  }
  out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.agentId.localeCompare(b.agentId));
  return out;
}

export interface SubagentTranscript {
  sessionId: string;
  encodedDir: string;
  agentId: string;
  filePath: string;
  messages: hist.TranscriptMessage[];
  offset: number;
  scannedMessages: number;
  hasMore: boolean;
  budgetExhausted: boolean;
  bytesRead: number;
  malformedLines: number;
  warnings: string[];
}

export interface ReadSubagentOptions {
  root?: string;
  offset?: number;
  limit?: number;
  maxTextChars?: number;
  includeToolResults?: boolean;
}

/**
 * One subagent's transcript, in the SAME `TranscriptMessage` shape the main
 * transcript route returns, so the UI renderer needs no changes.
 */
export function getSubagentMessages(
  encodedDir: string,
  sessionId: string,
  agentId: string,
  opts: ReadSubagentOptions = {},
): SubagentTranscript {
  const root = opts.root ?? hist.defaultRoot();
  safeSegment(agentId, 'agentId');
  const dir = subagentsDir(encodedDir, sessionId, root);
  if (!dir) throw new SubagentError(404, `no subagents directory for session ${sessionId} in ${encodedDir}`);
  const filePath = path.join(dir, `agent-${agentId}.jsonl`);
  if (!fs.existsSync(filePath)) throw new SubagentError(404, `no subagent ${agentId} in ${dir}`);

  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit ?? 200)));
  const maxTextChars = Math.max(0, Math.floor(opts.maxTextChars ?? 4000));
  const includeToolResults = opts.includeToolResults === true;

  const { entries, malformed, bytesRead, truncated } = parseLines(filePath, AGENT_MAX_BYTES);
  const messages: hist.TranscriptMessage[] = [];
  const warnings: string[] = [];
  let scanned = 0;

  const clip = (s: string): { text: string; truncated?: boolean } =>
    s.length > maxTextChars ? { text: s.slice(0, maxTextChars), truncated: true } : { text: s };

  /*
   * Two passes. Blocks are built BEFORE an index is assigned, because an entry
   * that yields no renderable block must not consume an index — otherwise
   * `offset` would silently skip real messages and `hasMore` would lie. Agent
   * files are small (capped at AGENT_MAX_BYTES), so holding them is fine.
   */
  const built: { e: Record<string, any>; blocks: hist.TranscriptBlock[] }[] = [];
  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;

    const blocks: hist.TranscriptBlock[] = [];
    const content = e.message?.content;
    if (typeof content === 'string') {
      blocks.push({ type: 'text', ...clip(content) });
    } else if (Array.isArray(content)) {
      for (const b of content as Record<string, any>[]) {
        if (b?.type === 'text') blocks.push({ type: 'text', ...clip(String(b.text ?? '')) });
        else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') blocks.push({ type: 'thinking', ...clip(String(b.thinking ?? '')) });
        else if (b?.type === 'tool_use') blocks.push({ type: 'tool_use', toolName: String(b.name ?? ''), toolUseId: String(b.id ?? '') });
        else if (b?.type === 'tool_result') {
          if (!includeToolResults) continue;
          const flat =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : `[${c?.type ?? 'block'}]`)).join('\n')
                : JSON.stringify(b.content ?? null);
          blocks.push({ type: 'tool_result', toolUseId: String(b.tool_use_id ?? ''), isError: b.is_error === true, ...clip(flat) });
        } else if (b?.type) blocks.push({ type: String(b.type) });
      }
    }

    /*
     * Drop entries that produced no renderable block. These are tool_result-only
     * user turns, filtered out above when `includeToolResults` is false; keeping
     * them renders an empty bubble. (Cross-checked against the SDK's own
     * getSubagentMessages: with this drop the two agree except for the agent's
     * opening task brief, which we KEEP on purpose — "what was this agent asked
     * to do" is the first thing you want when you navigate into one.)
     */
    if (blocks.length === 0) continue;
    built.push({ e, blocks });
  }

  const total = built.length;
  for (const { e, blocks } of built) {
    const index = scanned++;
    if (index < offset) continue;
    if (messages.length >= limit) break;
    messages.push({
      index,
      uuid: typeof e.uuid === 'string' ? e.uuid : null,
      parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null,
      role: e.type === 'assistant' ? 'assistant' : 'user',
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
      model: typeof e.message?.model === 'string' ? e.message.model : null,
      isMeta: e.isMeta === true,
      isCompactSummary: e.isCompactSummary === true,
      blocks,
    });
  }

  if (malformed) warnings.push(`${malformed} malformed line(s) skipped`);
  if (truncated) warnings.push(`file exceeded the ${AGENT_MAX_BYTES} byte read budget — counts are lower bounds`);

  return {
    sessionId,
    encodedDir,
    agentId,
    filePath,
    messages,
    offset,
    scannedMessages: total,
    hasMore: offset + messages.length < total,
    budgetExhausted: truncated,
    bytesRead,
    malformedLines: malformed,
    warnings,
  };
}
