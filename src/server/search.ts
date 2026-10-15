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
  /**
   * FEAT-189 — relevance of this match's immediate context, lower is better:
   * 0 = the query is a number sitting in a ticket id (`FEAT-164`); 1 = a clean
   * standalone match (a line number `:164`, or any non-numeric query); 2 = a
   * number buried inside a longer number (`164` inside `164790`/`4164`) — the
   * noise the user cannot act on. Orders hits WITHIN a kind so a bare ticket
   * number finds the ticket, not every number that contains its digits.
   */
  score: number;
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

/**
 * FEAT-189 — score a ticket-number query by the characters AROUND the match, so
 * `164` ranks a hit inside `FEAT-164` above a bare line number above `164790`.
 * `q` is a fixed string already found at `at` in `text`. A non-numeric query is
 * neutral (1): there is no number-embedding noise to demote.
 */
// The ticket-query grammar. This is a MIRROR of the client's canonical grammar
// in public/lib/search-ranking.js (parseTicketQuery / TICKET_PREFIXES) — the two
// surfaces MUST agree on what counts as a ticket query and a ticket ref, or one
// scores `ticket=FEAT-164`/`feat164`/`page-164` as a ticket and the other does
// not (independent-verify r8, r12). They cannot share a runtime module (browser
// public/ vs node src/ with a strict tsconfig), so they are kept in lockstep the
// way session-provenance mirrors dataDir: verify-feat-189.mjs FUZZES both over
// many query forms and strings and FAILS on any divergence.
const TICKET_PREFIXES = ['feat', 'bug', 'arch', 'deploy'];
const PREFIX_ALT = TICKET_PREFIXES.join('|');
// A known ticket prefix + '-' immediately before a bare-number match (`FEAT-164`).
// NOT any `<word>-164` (`page-164`, `adv-164-x`), which the client also rejects.
const TICKET_REF_BEFORE = new RegExp(`(?:^|[^a-z0-9])(?:${PREFIX_ALT})-$`, 'i');

/** Parse a finder query into a ticket reference, else null. MIRROR of the client. */
function parseTicketQuery(q: string): { num: string; prefix: string | null } | null {
  const t = String(q ?? '').trim().toLowerCase();
  let m = /^(\d{1,6})$/.exec(t);
  if (m) return { num: m[1], prefix: null };
  // ONLY the canonical dashed form — MIRROR of the client (r14): adorned/dashless
  // variants are not ticket queries, so the two surfaces never diverge on them.
  m = new RegExp(`^(${PREFIX_ALT})-(\\d{1,6})$`).exec(t);
  if (m) return { num: m[2], prefix: m[1] };
  return null;
}

/**
 * Is this query a ticket number (`164`) or a prefixed ticket id (`FEAT-164`,
 * `ticket=FEAT-164`, `feat164`)? These are the ONLY queries whose relevance score
 * varies by WHERE in a message the match sits — so the only ones worth scanning
 * past the first occurrence for (bestMatch). Every other query scores a constant 1.
 */
export function isTicketNumberQuery(q: string): boolean {
  return parseTicketQuery(q) !== null;
}

export function matchRelevance(text: string, at: number, q: string): number {
  const tq = parseTicketQuery(q);
  if (!tq) return 1;
  const ql = String(q ?? '').trim().toLowerCase();
  const before = at > 0 ? text[at - 1] : '';
  const after = text[at + ql.length] ?? '';
  const isDigit = (c: string) => c >= '0' && c <= '9';
  // Buried in a longer number — the token is not really this ticket's number.
  if (isDigit(after) || (tq.prefix === null && isDigit(before))) return 2;
  if (tq.prefix === null) {
    // A bare number is a ticket id ONLY when a KNOWN prefix + '-' precedes it.
    return TICKET_REF_BEFORE.test(text.slice(0, at)) ? 0 : 1;
  }
  // A prefixed query is a ticket ref ONLY when the matched text contains the
  // DASHED token (`FEAT-164`, not `FEAT164`) on a word boundary. The boundary is
  // checked before the TOKEN itself, not before any `ticket=`/`#` adornment the
  // user typed — matching the client, whose ticket regex anchors on the token
  // (independent-verify r13). `aticket=FEAT-164` is still a ref (token sits after
  // `=`); `xfeat-164` is not (token glued to a letter).
  const token = `${tq.prefix}-${tq.num}`; // always dashed
  const idx = ql.lastIndexOf(token);
  if (idx === -1) return 1; // dashless query form (`feat164`): no dashed token matched
  const tokenAt = at + idx;
  const beforeToken = tokenAt > 0 ? text[tokenAt - 1] : '';
  return beforeToken === '' || !/[a-z0-9]/i.test(beforeToken) ? 0 : 1;
}

/**
 * The BEST (lowest-scoring) occurrence of `ql` in `text`, or null if absent.
 * FEAT-189 r2 — a message can hold the query more than once (`164790 … then
 * ticket=FEAT-164`): scoring only the FIRST hit demoted whole-ticket messages
 * behind an earlier embedded-number match (independent-verify BROKEN, 17/315
 * real ticket messages). Scan occurrences and keep the best; stop at score 0,
 * which nothing can beat. The chosen position is what the snippet is cut around,
 * so the highlight lands on the match that earned the rank.
 */
/**
 * Map an offset in `text.toLowerCase()` back to the corresponding offset in the
 * ORIGINAL `text`. Needed because a length-changing lowercase (İ → two units,
 * ß → ss) makes the two strings misalign, so a lowercased offset fed straight
 * into the original text highlights the wrong characters (independent-verify r7).
 * Walks by code point, accumulating each point's lowercased length.
 */
function lowerOffsetToOrig(text: string, lowerAt: number): number {
  let li = 0;
  for (let oi = 0; oi < text.length; ) {
    if (li >= lowerAt) return oi;
    const cp = text.codePointAt(oi) as number;
    const ch = String.fromCodePoint(cp);
    li += ch.toLowerCase().length;
    oi += ch.length;
  }
  return text.length;
}

function bestMatch(text: string, ql: string, q: string): { at: number; score: number } | null {
  const lower = text.toLowerCase();
  let at = lower.indexOf(ql);
  if (at === -1) return null;
  // Score against the LOWERCASED text at the lowercased-match offset. A
  // length-changing lowercase (Turkish İ → two code units, ß → ss) would shift
  // the offset so reading the ORIGINAL text at it lands on the wrong neighbour
  // and mis-scores (independent-verify r6). matchRelevance's adjacency checks are
  // case-insensitive, and a ticket-number query is ASCII (ql.length === q.length),
  // so scoring on `lower`/`ql` is both safe and exact.
  let bestAt = at;
  let bestScore = matchRelevance(lower, at, ql);
  // The returned offset must index the ORIGINAL text (for snippet/highlight), so
  // map it back when a length-changing lowercase made the two misalign; the 1:1
  // common case costs nothing.
  const origOf = (lowerAt: number) => lower.length === text.length ? lowerAt : lowerOffsetToOrig(text, lowerAt);
  // Only a ticket-number query scores differently across occurrences; for any
  // other query matchRelevance is a constant 1, so the first hit is already the
  // best and scanning the rest is pure cost (a 1.9x regression on common prose
  // queries — independent-verify r3). Short-circuit it.
  if (!isTicketNumberQuery(q)) return { at: origOf(bestAt), score: bestScore };
  while (bestScore > 0) {
    at = lower.indexOf(ql, at + 1);
    if (at === -1) break;
    const sc = matchRelevance(lower, at, ql);
    if (sc < bestScore) { bestScore = sc; bestAt = at; }
  }
  return { at: origOf(bestAt), score: bestScore };
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
  const pm = bestMatch(prose, ql, q);
  if (pm) return { role, timestamp, kind: 'prose', score: pm.score, ...snippetAround(prose, pm.at, q.length) };

  const tool = toolTextOf(e);
  const tm = bestMatch(tool, ql, q);
  if (tm) return { role, timestamp, kind: 'tool', score: tm.score, ...snippetAround(tool, tm.at, q.length) };

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
    // FEAT-189 r5 — only a ticket-number query scores differently across matches,
    // so only IT needs every match judged before the cap (to rank them). For any
    // other query every score is a constant 1, so stopping collection at maxHits —
    // the behaviour that predates this ticket — is both correct and fast; expanding
    // it regressed the common neutral query "the" 3.1x on the real store (r4→r5).
    const rankAcrossAll = isTicketNumberQuery(q);
    const abandon = () => {
      if (settled) return;
      rg.kill('SIGTERM');
      done();
    };
    const done = () => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', abandon);
      // Prose above tool output; WITHIN a kind, ticket-id matches above clean
      // matches above numbers-inside-numbers (FEAT-189); then newest first.
      hits.sort((a, b) =>
        (a.kind === b.kind ? 0 : (a.kind === 'prose' ? -1 : 1))
        || (a.score - b.score)
        || String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
      // FEAT-189 — the maxHits cut happens AFTER ranking the whole collected set,
      // never during collection: capping collection at maxHits would rank only the
      // first-scanned matches and could drop the best-scoring (ticket-id) hit before
      // it was ever judged (independent-verify r4). Returning fewer than we judged is
      // itself a truncation the UI should flag.
      if (hits.length > maxHits) truncated = true;
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
      // For a ticket-number query, stop only on the RAW-match budget so the sort
      // in done() ranks the whole set before the maxHits cut (a cap DURING
      // collection would rank only a scan-order prefix and miss the best hit — r4).
      // For any other query, keep the original early-stop at maxHits (r5 perf).
      if (raw > MAX_RAW_MATCHES || (!rankAcrossAll && hits.length >= maxHits)) {
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
