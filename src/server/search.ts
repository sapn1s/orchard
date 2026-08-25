/**
 * Content search over the session store — ripgrep, no index.
 *
 * Measured on this machine: 1.7 GB / ~3,800 .jsonl files in 60–482 ms
 * (cold/warm), so an index would buy staleness and invalidation bugs and
 * nothing else. rg is used ONLY as a line filter; every candidate line is
 * re-judged here, because a raw .jsonl line is mostly metadata (uuids,
 * timestamps, base64) and a hit inside those is noise the user cannot act on.
 *
 * Classification of a matched line:
 *   - not a main-thread user/assistant entry (sidechain, meta, queue-ops) → drop
 *   - query found in prose (text blocks / string content)   → kind 'prose'
 *   - query found in thinking, tool inputs, or tool results → kind 'tool'
 *   - query found only in the JSON scaffolding              → drop (noise)
 *
 * Deep-linking: locate() maps a matched line number to the message's absolute
 * index in the SAME canonical space the transcript routes use (renderable
 * main-thread entries, tool results excluded) — see countable() in
 * transcript.ts, which is deliberately shared.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { isMainThreadEntry } from './jsonl.ts';
import { countable } from './transcript.ts';
import { translateItem } from './codex-native.ts';

export interface SearchHit {
  encodedDir: string;
  sessionId: string;
  /** 1-based line number in the .jsonl — feed to locate() on click. */
  line: number;
  role: 'user' | 'assistant';
  timestamp: string | null;
  /** 'prose' = visible conversation text; 'tool' = thinking/tool payloads. */
  kind: 'prose' | 'tool';
  snippet: string;
  /** Offsets of the query inside `snippet`, for highlighting. */
  matchStart: number;
  matchEnd: number;
}

export interface SearchResult {
  hits: SearchHit[];
  tookMs: number;
  /** True when the raw-match cap was hit — more matches exist than were judged. */
  truncated: boolean;
  filesScanned: number;
}

export interface SearchTarget {
  path: string;
  encodedDir?: string;
  sessionId?: string;
  format?: 'claude' | 'codex-rollout';
}

const MAX_RAW_MATCHES = 2000; // rg matches judged before we stop reading
const MAX_HITS = 300;         // judged hits returned
const SNIPPET_RADIUS = 90;

// One process for the whole server, not one per keystroke/client request. A
// replacement waits for the killed child's close event before spawning, while
// already-superseded waiters notice their AbortSignal and never join a queue.
let activeScan: { child: ReturnType<typeof spawn>; closed: Promise<void> } | null = null;

/** Flattened prose of an entry: what the transcript actually renders as text. */
function proseOf(e: Record<string, any>): string {
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n');
}

/** Secondary content: thinking, tool inputs, tool results. Real but noisier. */
function toolTextOf(e: Record<string, any>): string {
  const c = e.message?.content;
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const b of c as Record<string, any>[]) {
    if (b?.type === 'thinking') parts.push(String(b.thinking ?? ''));
    else if (b?.type === 'tool_use') {
      try { parts.push(JSON.stringify(b.input ?? null)); } catch { /* circular — skip */ }
    } else if (b?.type === 'tool_result') {
      const rc = b.content;
      if (typeof rc === 'string') parts.push(rc);
      else if (Array.isArray(rc)) parts.push(rc.map((x: any) => (typeof x === 'string' ? x : String(x?.text ?? ''))).join('\n'));
    }
  }
  return parts.join('\n');
}

function snippetAround(text: string, at: number, qLen: number): { snippet: string; matchStart: number; matchEnd: number } {
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + qLen + SNIPPET_RADIUS);
  const pre = (from > 0 ? '…' : '') + text.slice(from, at).replace(/\s+/g, ' ');
  const mid = text.slice(at, at + qLen);
  const post = text.slice(at + qLen, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
  return { snippet: pre + mid + post, matchStart: pre.length, matchEnd: pre.length + mid.length };
}

/** Judge one rg-matched line. Returns null for noise. */
export function judgeLine(lineText: string, q: string): Omit<SearchHit, 'encodedDir' | 'sessionId' | 'line'> | null {
  let e: Record<string, any>;
  try { e = JSON.parse(lineText); } catch { return null; }
  if (!isMainThreadEntry(e)) return null;
  const role: 'user' | 'assistant' = e.type === 'assistant' ? 'assistant' : 'user';
  const timestamp = typeof e.timestamp === 'string' ? e.timestamp : null;
  const ql = q.toLowerCase();

  const prose = proseOf(e);
  let at = prose.toLowerCase().indexOf(ql);
  if (at !== -1) return { role, timestamp, kind: 'prose', ...snippetAround(prose, at, q.length) };

  const tool = toolTextOf(e);
  at = tool.toLowerCase().indexOf(ql);
  if (at !== -1) return { role, timestamp, kind: 'tool', ...snippetAround(tool, at, q.length) };

  return null; // matched only uuids/paths/scaffolding — not something a user said or saw
}

/** Judge a native Codex rollout line after translating it exactly as import/open does. */
export function judgeCodexLine(lineText: string, q: string): Omit<SearchHit, 'encodedDir' | 'sessionId' | 'line'> | null {
  let raw: any;
  try { raw = JSON.parse(lineText); } catch { return null; }
  if (raw?.type !== 'response_item') return null;
  const entry = translateItem(raw.payload);
  if (!entry) return null;
  return judgeLine(JSON.stringify({ type: entry.type, timestamp: raw.timestamp, message: { content: entry.content } }), q);
}

/**
 * Search the given store dirs (absolute paths) for a fixed string `q`.
 * Spawns one rg over all dirs; kills it once enough raw matches were judged.
 */
export async function searchStore(q: string, targets: Array<string | SearchTarget>, opts: { maxHits?: number; signal?: AbortSignal } = {}): Promise<SearchResult> {
  const t0 = Date.now();
  const maxHits = Math.min(opts.maxHits ?? MAX_HITS, MAX_HITS);
  const existingTargets = targets.filter((target) => {
    try { return fs.statSync(typeof target === 'string' ? target : target.path).isDirectory() || fs.statSync(typeof target === 'string' ? target : target.path).isFile(); } catch { return false; }
  });
  const existing = existingTargets.map((target) => typeof target === 'string' ? target : target.path);
  const metadata = new Map(existingTargets.filter((t): t is SearchTarget => typeof t !== 'string').map((t) => [path.resolve(t.path), t]));
  if (!existing.length || !q) return { hits: [], tookMs: Date.now() - t0, truncated: false, filesScanned: 0 };

  if (activeScan) {
    const prior = activeScan;
    prior.child.kill('SIGTERM');
    await prior.closed;
  }
  if (opts.signal?.aborted) return { hits: [], tookMs: Date.now() - t0, truncated: false, filesScanned: 0 };

  return new Promise((resolve, reject) => {
    const rg = spawn('rg', [
      '--json', '--fixed-strings', '--ignore-case', '--no-messages',
      '--glob', '*.jsonl', '--', q, ...existing,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let closeScan!: () => void;
    const closed = new Promise<void>((r) => { closeScan = r; });
    const mine = { child: rg, closed };
    activeScan = mine;

    const hits: SearchHit[] = [];
    const files = new Set<string>();
    let raw = 0;
    let truncated = false;
    let settled = false;
    const abandon = () => {
      if (settled) return;
      rg.kill('SIGTERM');
      done();
    };
    const done = () => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', abandon);
      // Prose above tool output, then newest first — the ranking the TODO settled on.
      hits.sort((a, b) => (a.kind === b.kind ? String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')) : (a.kind === 'prose' ? -1 : 1)));
      resolve({ hits: hits.slice(0, maxHits), tookMs: Date.now() - t0, truncated, filesScanned: files.size });
    };
    if (opts.signal?.aborted) return abandon();
    opts.signal?.addEventListener('abort', abandon, { once: true });

    const rl = readline.createInterface({ input: rg.stdout });
    rl.on('line', (l) => {
      if (settled) return;
      let ev: any;
      try { ev = JSON.parse(l); } catch { return; }
      if (ev.type !== 'match') return;
      raw++;
      if (raw > MAX_RAW_MATCHES || hits.length >= maxHits) {
        truncated = true;
        rg.kill('SIGTERM');
        return done();
      }
      const filePath = String(ev.data?.path?.text ?? '');
      const lineText = ev.data?.lines?.text;
      const lineNo = Number(ev.data?.line_number);
      if (!filePath || typeof lineText !== 'string' || !Number.isInteger(lineNo)) return;
      files.add(filePath);
      const target = metadata.get(path.resolve(filePath));
      const judged = target?.format === 'codex-rollout' ? judgeCodexLine(lineText, q) : judgeLine(lineText, q);
      if (!judged) return;
      hits.push({
        encodedDir: target?.encodedDir ?? path.basename(path.dirname(filePath)),
        sessionId: target?.sessionId ?? path.basename(filePath, '.jsonl'),
        line: lineNo,
        ...judged,
      });
    });
    rg.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    rg.on('close', () => {
      if (activeScan === mine) activeScan = null;
      closeScan();
      rl.close();
      done();
    });
  });
}

export interface Located {
  /** Absolute index in the canonical transcript space, or of the nearest
   *  earlier renderable message when the matched line itself renders nothing. */
  index: number;
  /** False when the matched line is not itself a canonical message. */
  exact: boolean;
}

/**
 * Map a 1-based line number to the canonical message index, by streaming the
 * file and counting with the SAME predicate the transcript routes count with.
 * O(bytes up to the hit) — paid once per clicked result, never per search.
 */
export async function locate(filePath: string, lineNo: number): Promise<Located | null> {
  const keep = (e: Record<string, any>) => isMainThreadEntry(e, false);
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let n = 0;
  let before = 0; // canonical messages strictly before the target line
  let hitCountable = false;
  for await (const line of rl) {
    n++;
    if (n > lineNo) break;
    const c = countable(line, keep, { includeToolResults: false });
    if (n < lineNo) { if (c) before++; }
    else hitCountable = c;
  }
  rl.close();
  if (n < lineNo) return null; // file shrank since the search — say so, don't guess
  if (hitCountable) return { index: before, exact: true };
  return { index: Math.max(0, before - 1), exact: false };
}

/** Locate in the canonical transcript produced when a native rollout is opened/imported. */
export async function locateCodex(filePath: string, lineNo: number): Promise<Located | null> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let n = 0;
  let before = 0;
  let hitCountable = false;
  for await (const line of rl) {
    n++;
    if (n > lineNo) break;
    let raw: any = null;
    try { raw = JSON.parse(line); } catch { /* partial final line: not countable */ }
    const entry = raw?.type === 'response_item' ? translateItem(raw.payload) : null;
    const c = entry ? countable(JSON.stringify({ type: entry.type, message: { content: entry.content } }), (e) => isMainThreadEntry(e, false), { includeToolResults: false }) : false;
    if (n < lineNo) { if (c) before++; } else hitCountable = c;
  }
  rl.close();
  if (n < lineNo) return null;
  if (hitCountable) return { index: before, exact: true };
  return { index: Math.max(0, before - 1), exact: false };
}
