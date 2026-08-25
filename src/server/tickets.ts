/**
 * FEAT-058 — the ticket dashboard's server half: browse / search / WRITE the
 * per-project `docs/bugs/` board from a second browser tab.
 *
 * The rail (FEAT-018, src/server/board.ts) answers "what needs you NOW" and
 * deliberately shows a slice. This module is the FULL ARCHIVE behind it: every
 * ticket, its body, and the four writes a human needs in order to keep the board
 * honest without opening an editor — append a note, reopen a Done ticket, flag
 * 👤/needs-you, file a new ticket.
 *
 * NON-NEGOTIABLES (docs/bugs/README.md; enforced here, not merely documented):
 *
 *  1. APPEND-ONLY. A user note is written with `fs.appendFileSync` — the prior
 *     bytes are never read-and-rewritten, so no earlier entry can be lost even
 *     if an agent is appending at the same instant. The ONE in-place edit that
 *     exists is the `- **Status:**` header on reopen, and it is recorded in the
 *     Activity log by the same call.
 *
 *  2. NEVER CLOBBER A CONCURRENT AGENT. Every write carries the `rev` the client
 *     read (`<mtimeMs>:<size>`). It is re-checked against the file immediately
 *     before writing; a mismatch is a loud 409 carrying the current rev, never a
 *     silent overwrite. The in-place status edit re-checks a SECOND time between
 *     the read and the write, so the modify window is as small as the filesystem
 *     allows.
 *
 *  3. THE BOARD TOOL OWNS INDEX.md. Any write that can move a row runs
 *     `genBoard()` from scripts/board.mjs — the tool that knows which columns are
 *     curated (Open.Owner, Open.Status, Done.Commit) and preserves them by id —
 *     and then `checkBoard()`, so a write that would leave drift SAYS SO instead
 *     of leaving a broken `npm run board:check` behind.
 *
 * Reading is strictly read-only: opening a ticket mutates nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { genBoard, checkBoard } from '../../scripts/board.mjs';
// ONE definition of the ticket format (plan §3 / §8 step 2). This file used to
// carry its own `sectionOf`, whose comment claimed it was "the board tool's
// rule verbatim" — it was not: it was a COPY that never received FEAT-068's
// broadening, so `- **Status:** FIXED` was Done to `board:check` and OPEN here,
// on 12 real tickets. Both now ask ticket-schema.mjs.
import {
  parseTicket, isDoneStatus, indexRowCells, TICKET_FILE_RE,
  type WorkState, type VerificationState, type LegacyTicketRecord,
} from '../../scripts/lib/ticket-schema.mjs';
import {
  boardDir, ticketFile, composeAnswerEntry, ticketDecision, ticketAnswerState,
  type ReplyKind, type TicketDecision, type TicketAnswerState,
} from './board.ts';

export type { ReplyKind } from './board.ts';

const NEEDS_YOU = '\u{1F464}'; // 👤
const IN_FLIGHT = '\u{1F916}'; // 🤖

/** `BUG-004`, `FEAT-058`, `ARCH-001`, `DEPLOY-003` — the board's four prefixes. */
const ID_RE = /^(ARCH|BUG|FEAT|DEPLOY)-(\d+)$/;
export const TICKET_PREFIXES = ['BUG', 'FEAT', 'ARCH', 'DEPLOY'] as const;

export class TicketError extends Error {
  status: number;
  /** The file's CURRENT rev, when this is a freshness conflict (409). */
  rev: string | null;
  constructor(message: string, status = 400, rev: string | null = null) {
    super(message);
    this.status = status;
    this.rev = rev;
  }
}

export interface TicketSummary {
  id: string;
  title: string;
  /** The ticket file's own `- **Status:**` line, verbatim. */
  status: string;
  /** Which board table this ticket belongs in, derived by the board tool's rule. */
  section: 'open' | 'done';
  /**
   * ARCH-004's fixed-set machine state, classified from the prose Status line
   * by scripts/lib/ticket-schema.mjs. `null` when the status uses a word the
   * schema does not recognise — an explicit "cannot classify", never a guess.
   * `section` is derived from this, so the two can never disagree.
   */
  workState: WorkState | null;
  /**
   * Whether a proof exists and what it says, ORTHOGONAL to workState. This is
   * where the nuance the single prose Status line used to carry now lives:
   * `FIXED` is `done` + `pending`, `VERIFIED` is `verified` + `holds`.
   */
  verificationState: VerificationState | null;
  /** True when the Done placement came from an incidental `DONE` token rather than the leading state word. */
  statusAmbiguous: boolean;
  /**
   * False ⇒ the schema could not interpret this ticket's `- **Status:**` line.
   * `section` is then a PLACEMENT ("not in the Done set", which is what
   * board.mjs and arch-watch also say), NOT a claim that the state was read.
   */
  statusMatched: boolean;
  /**
   * The board defect, in words, or null. An HTTP list of tickets must not 500
   * because one ticket is malformed — a half-written ticket has to stay
   * listable — so the report rides on the record and a client can render it.
   * `board:check` names the identical condition and exits 1.
   */
  statusError: string | null;
  /**
   * The ADVISORY half of the same channel, or null. The state IS answerable —
   * `section` and `workState` are trustworthy — but the declaration is untidy
   * in a way that becomes a defect if left: two `- **Status:**` lines that
   * happen to agree, a `DONE` token doing the classifying, a near-miss line.
   * Carried for the same reason as `statusError`: a consumer that only reads
   * the record must not have to re-derive it.
   */
  statusWarning: string | null;
  /** The INDEX Open row's curated Owner cell (👤 / 🤖 / —), '' when not on the Open table. */
  owner: string;
  /** The INDEX Open row's curated Status blurb, '' when absent. */
  boardStatus: string;
  sev: string;
  area: string;
  /** Newest `### YYYY-MM-DD` heading in the file; falls back to the file mtime. */
  lastActivity: string;
  mtimeMs: number;
  file: string;
  /** Freshness token the client must echo back on any write. */
  rev: string;
  /** True when the INDEX Open row carries 👤. */
  needsYou: boolean;
}

export interface TicketMatch {
  /** 1-based line number in the ticket file. */
  line: number;
  text: string;
  matchStart: number;
  matchEnd: number;
  /** True when the hit is inside the `## Activity log` section — the body-search proof. */
  inActivityLog: boolean;
}

export interface TicketSearchHit extends TicketSummary {
  matches: TicketMatch[];
  matchCount: number;
  /** Where the query was found at all: any of id / title / body. */
  where: { id: boolean; title: boolean; body: boolean };
}

export interface TicketDetail extends TicketSummary {
  markdown: string;
  /** Absolute path, shown so the user can find the same file an agent reads. */
  relPath: string;
  /**
   * FEAT-090 — the parsed decision (`## Question` / `## Decision…`), or null.
   * Surfaced so the ticket-view client renders the Decide card WITHOUT
   * re-parsing markdown (board.ts owns the ONE grammar).
   */
  decision: TicketDecision | null;
  /**
   * FEAT-090 — the LAST user reply on file (server-confirmed), or null. Lets the
   * client flip the Decide card to its read-only "you answered … on <date>"
   * state only when the server has recorded it (renderChosen discipline).
   */
  answer: TicketAnswerState | null;
}

/* ────────────────────────────────────────────────────────────────── reading */

function revOf(st: fs.Stats): string {
  return `${Math.round(st.mtimeMs)}:${st.size}`;
}

/** The freshness token for a ticket file as it is RIGHT NOW. */
export function currentRev(file: string): string {
  return revOf(fs.statSync(file));
}

/**
 * DONE-vs-OPEN. There is now exactly ONE rule, in scripts/lib/ticket-schema.mjs,
 * and it is the board tool's — genuinely this time, by import rather than by a
 * comment claiming a copy is verbatim.
 *
 * VERIFIED / FIXED / RE-FIXED / RESOLVED (leading), or a DONE token anywhere,
 * are done; OPEN / IN-PROGRESS / IN-VERIFICATION / BLOCKED / NOT-A-BUG still
 * need eyes and stay on the Open table. A status the schema cannot classify is
 * NOT quietly called open: it is `work_state: null`, reported by `board:check`,
 * and kept in Open where a human sees it.
 */
function sectionOf(statusRaw: string): 'open' | 'done' {
  return isDoneStatus(statusRaw) ? 'done' : 'open';
}

const cellsOf = (line: string): string[] => indexRowCells(line);

interface IndexRow { owner: string; status: string; sev: string }

/**
 * The curated half of the board: INDEX.md's Open rows. Parsed leniently (a
 * project whose INDEX is missing or half-written must still list its tickets —
 * the ticket FILES are the source of truth, the row is decoration).
 */
function readIndexRows(dir: string): Map<string, IndexRow> {
  const rows = new Map<string, IndexRow>();
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'); } catch { return rows; }
  let inOpen = false;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { inOpen = h[1].trim().toLowerCase().startsWith('open'); continue; }
    if (!inOpen) continue;
    const cells = cellsOf(line);
    if (!cells.length || !ID_RE.test(cells[0])) continue;
    rows.set(cells[0], { owner: cells[2] ?? '', status: cells[3] ?? '', sev: cells[4] ?? '' });
  }
  return rows;
}

function summarize(file: string, text: string, st: fs.Stats, rows: Map<string, IndexRow>): TicketSummary {
  const base = path.basename(file);
  // ONE parse, BOTH formats (BUG-122): id, title, Status, Severity, Area and the
  // newest activity date all come back from the shared reader, off the leading
  // ```orchard-ticket record when the ticket has been promoted and off the prose
  // header when it has not. `mode: 'compat'` here used to read a promoted
  // ticket's opening fence as its H1 — the list showed ARCH-005's title as
  // ```` ```orchard-ticket ```` with a MISSING STATUS FIELD badge.
  // `requireEmDash` keeps this file's long-standing H1 strictness on the legacy
  // path, where `.summary` is the identical object `.record` used to be. A
  // malformed ticket of EITHER format still summarises (title falls back to the
  // raw first line) because the dashboard must list a half-written ticket rather
  // than hide it.
  const t = parseTicket(text, { file: base, mode: 'auto', requireEmDash: true }).summary as LegacyTicketRecord;
  const id = t.id ?? base.replace(/^((?:ARCH|BUG|FEAT|DEPLOY)-\d+).*$/, '$1');
  const status = t.statusRaw;
  const section: 'open' | 'done' = t.done ? 'done' : 'open';
  const row = rows.get(id);
  return {
    id,
    title: t.title ?? (text.split('\n', 1)[0] ?? id).replace(/^#\s*/, ''),
    status,
    section,
    // The machine state behind `section`, so a client can render "fixed,
    // awaiting independent verification" without re-reading the prose status.
    // ARCH-004's fixed-set answer, surfaced through the API.
    workState: t.work_state,
    verificationState: t.verification_state,
    statusAmbiguous: t.statusAmbiguous,
    statusMatched: t.statusMatched,
    statusError: t.statusError,
    statusWarning: t.statusWarning,
    owner: section === 'open' ? (row?.owner ?? '') : '',
    boardStatus: row?.status ?? '',
    sev: t.severityRaw.split('(')[0].split('|')[0].trim(),
    area: t.area,
    lastActivity: t.updated ?? new Date(st.mtimeMs).toISOString().slice(0, 10),
    mtimeMs: st.mtimeMs,
    file,
    rev: revOf(st),
    needsYou: (row?.owner ?? '').includes(NEEDS_YOU),
  };
}

function ticketFiles(dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => TICKET_FILE_RE.test(n)).map((n) => path.join(dir, n));
}

/** Every ticket of a project, newest activity first. No board → empty list. */
export function listTickets(hostPath: string): { hasBoard: boolean; tickets: TicketSummary[] } {
  const dir = boardDir(hostPath);
  const files = ticketFiles(dir);
  let hasBoard = false;
  try { hasBoard = fs.statSync(dir).isDirectory(); } catch { hasBoard = false; }
  const rows = readIndexRows(dir);
  const out: TicketSummary[] = [];
  for (const file of files) {
    try {
      out.push(summarize(file, fs.readFileSync(file, 'utf8'), fs.statSync(file), rows));
    } catch { /* a ticket that vanished mid-scan is not an error for the list */ }
  }
  out.sort((a, b) => (a.lastActivity === b.lastActivity ? b.mtimeMs - a.mtimeMs : (a.lastActivity < b.lastActivity ? 1 : -1)));
  return { hasBoard, tickets: out };
}

function resolveTicket(hostPath: string, id: string): { dir: string; file: string } {
  if (!ID_RE.test(id)) throw new TicketError(`not a ticket id: ${JSON.stringify(id)}`, 400);
  const dir = boardDir(hostPath);
  const file = ticketFile(dir, id);
  if (!file) throw new TicketError(`no ticket ${id} under ${dir}`, 404);
  return { dir, file };
}

/** One ticket, with the REAL file markdown — the same bytes an agent reads. */
export function readTicket(hostPath: string, id: string): TicketDetail {
  const { dir, file } = resolveTicket(hostPath, id);
  const text = fs.readFileSync(file, 'utf8');
  const st = fs.statSync(file);
  return {
    ...summarize(file, text, st, readIndexRows(dir)),
    markdown: text,
    relPath: path.relative(hostPath, file),
    decision: ticketDecision(text),
    answer: ticketAnswerState(text),
  };
}

/* ────────────────────────────────────────────────────────────────── search */

const MAX_MATCHES_PER_TICKET = 6;
const SNIPPET_MAX = 240;

/**
 * Full-text search over ticket BODIES — the activity logs are where the real
 * content is, so a title-only search would answer the wrong question.
 *
 * Deliberately a small scoped reader rather than the session store's
 * ripgrep plumbing (src/server/search.ts): that path exists to judge `.jsonl`
 * lines (it JSON-parses every candidate and drops anything that is not a
 * main-thread message), which is meaningless for markdown. A board is ~100 small
 * files — under a millisecond to scan — so a subprocess would buy a dependency
 * and a failure mode and nothing else.
 */
export function searchTickets(hostPath: string, q: string): { hasBoard: boolean; hits: TicketSearchHit[] } {
  const { hasBoard, tickets } = listTickets(hostPath);
  const needle = q.trim().toLowerCase();
  if (!needle) return { hasBoard, hits: tickets.map((t) => ({ ...t, matches: [], matchCount: 0, where: { id: false, title: false, body: false } })) };

  const hits: TicketSearchHit[] = [];
  for (const t of tickets) {
    let text: string;
    try { text = fs.readFileSync(t.file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const matches: TicketMatch[] = [];
    let matchCount = 0;
    let activityFrom = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Activity log\b/i.test(lines[i])) { activityFrom = i; break; }
    }
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].toLowerCase().indexOf(needle);
      if (at === -1) continue;
      matchCount++;
      if (matches.length >= MAX_MATCHES_PER_TICKET) continue;
      const raw = lines[i];
      const from = Math.max(0, at - 80);
      const snippet = (from > 0 ? '…' : '') + raw.slice(from, from + SNIPPET_MAX);
      const start = (from > 0 ? 1 : 0) + (at - from);
      matches.push({
        line: i + 1,
        text: snippet,
        matchStart: start,
        matchEnd: start + needle.length,
        inActivityLog: i >= activityFrom,
      });
    }
    const inId = t.id.toLowerCase().includes(needle);
    const inTitle = t.title.toLowerCase().includes(needle);
    if (!matchCount && !inId && !inTitle) continue;
    hits.push({ ...t, matches, matchCount, where: { id: inId, title: inTitle, body: matchCount > 0 } });
  }
  // An id/title hit is the most likely intent; otherwise the most-matching body.
  hits.sort((a, b) => {
    const rank = (h: TicketSearchHit) => (h.where.id ? 0 : h.where.title ? 1 : 2);
    const r = rank(a) - rank(b);
    if (r) return r;
    if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
    return a.lastActivity < b.lastActivity ? 1 : -1;
  });
  return { hasBoard, hits };
}

/* ───────────────────────────────────────────────────────────── concurrency */

/**
 * The freshness gate. `rev` is what the client READ; if the file has moved on,
 * an agent (or another tab) wrote in between — refuse, loudly, with the current
 * rev so the caller can re-read and decide. This is the guard that makes the
 * dashboard safe to use WHILE an agent is working the same ticket.
 */
export function assertFresh(file: string, rev: string | undefined | null): string {
  const cur = currentRev(file);
  if (!rev) throw new TicketError('write refused: no `rev` (freshness token) supplied — re-open the ticket and retry', 400, cur);
  if (rev !== cur) {
    throw new TicketError(
      `write refused: this ticket changed on disk since you opened it (an agent may be writing to it right now). ` +
      `Re-read it and retry — nothing was written.`,
      409, cur,
    );
  }
  return cur;
}

const DATE = () => new Date().toISOString().slice(0, 10);

/** `— user (via dashboard)` — the attribution FEAT-058 writes under. */
export const USER_SIGNATURE = 'user (via dashboard)';

function entryBody(text: string, label = 'Note'): string {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
  const [first, ...rest] = clean.split('\n');
  return [`- **${label}:** ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ''))].join('\n');
}

/* ──────────────────────────────────────────────────────────────── writing */

export interface WriteResult {
  id: string;
  file: string;
  rev: string;
  appended: string;
  board: BoardReconcileResult;
}

export interface BoardReconcileResult {
  /** Did `genBoard()` run to completion? */
  reconciled: boolean;
  /** `checkBoard()`'s hard drift after the write — MUST be empty. */
  fails: string[];
  warns: string[];
  error: string | null;
}

/**
 * Run the board tool's OWN reconciliation, then its own check. Never hand-edits
 * INDEX.md: `genBoard` is what knows the curated columns and preserves them.
 * A project whose INDEX.md is missing a required section makes `genBoard` throw
 * — reported honestly rather than swallowed, because the write DID land and the
 * user must know the board is now behind.
 */
function reconcileBoard(dir: string): BoardReconcileResult {
  try {
    genBoard(dir);
  } catch (err) {
    return { reconciled: false, fails: [], warns: [], error: (err as Error).message };
  }
  try {
    const r = checkBoard(dir);
    return { reconciled: true, fails: r.fails, warns: r.warns, error: null };
  } catch (err) {
    return { reconciled: true, fails: [], warns: [], error: (err as Error).message };
  }
}

/**
 * Append a dated, attributed user note. `fs.appendFileSync` at EOF — a prior
 * entry cannot be rewritten by construction; the freshness check exists so the
 * user is not writing blind into a ticket an agent just changed.
 */
export function appendNote(
  hostPath: string, id: string, text: string, rev: string | undefined,
  opts: { author?: string; label?: string } = {},
): WriteResult {
  const clean = String(text ?? '').trim();
  if (!clean) throw new TicketError('note is empty', 400);
  const { dir, file } = resolveTicket(hostPath, id);
  assertFresh(file, rev);
  // The attribution is a PARAMETER, not a constant, because the board tool
  // appends as the agent that is working the ticket. Defaulting to the dashboard
  // signature keeps every existing caller byte-identical; an append-only log
  // whose entries all claim to be the user is a worse record than none.
  const author = String(opts.author ?? '').trim() || USER_SIGNATURE;
  const label = String(opts.label ?? '').trim() || 'Note';
  const entry = `\n### ${DATE()} — ${author}\n${entryBody(clean, label)}\n`;
  fs.appendFileSync(file, entry);
  // A note changes no status, so the board cannot drift — but check anyway:
  // "still green after every write" is the guard, and a check is nearly free.
  return { id, file, rev: currentRev(file), appended: entry, board: reconcileBoard(dir) };
}

export interface AnswerInput {
  kind: ReplyKind;
  /** The decision question echoed into the record (from the client's `decision`). */
  question?: string | null;
  /** The chosen option, when a decision offered options. */
  chose?: { key: string; label: string } | null;
  /** Free text: a Note alongside a chosen option, or the whole free-text answer. */
  note?: string;
  /**
   * FEAT-090 — this reply is a FOLLOW-UP: added context after the decision was
   * already recorded. Append-only (never edits the original), owner stays 👤, the
   * ticket stays answered-awaiting. Only honoured on a `decision` reply.
   */
  followup?: boolean;
}

export interface AnswerResult extends WriteResult {
  kind: ReplyKind;
  /** Who owns the ticket AFTER this reply: '👤' answered-awaiting, '🤖' agent-owned. */
  owner: string;
  /** The re-derived reply state (what the client flips the Decide card to). */
  answer: TicketAnswerState | null;
}

/**
 * FEAT-090 — record a user REPLY to a ticket, through the SAME write layer as
 * appendNote: the `rev` freshness gate (409, never a silent clobber of a
 * concurrent agent) and the board tool's own reconciliation. Deliberately NOT
 * `board.appendAnswer` (which appends blind): agents write these files while the
 * user reads them, so the freshness gate is not optional.
 *
 * OWNERSHIP is made explicit, not inferred:
 *   - decision → owner STAYS 👤; the appended answer entry derives the ticket
 *     into the answered-awaiting lane (the human decided, an agent should act).
 *   - question / counter → owner FLIPS to 🤖: the ball is in the agent's court
 *     (answer the user, or weigh the counter). It is agent-owned but NOT
 *     ready-for-work — the INDEX Status blurb says exactly that.
 *
 * This function contains NO session code by construction: answering a TICKET
 * dispatches nothing and sends nothing into any live session. Work starts only
 * when the user says go.
 */
export function answerTicket(hostPath: string, id: string, input: AnswerInput, rev: string | undefined): AnswerResult {
  const kind: ReplyKind = input.kind === 'question' || input.kind === 'counter' ? input.kind : 'decision';
  const followup = kind === 'decision' && input.followup === true;
  const chose = followup ? null : (input.chose && input.chose.key ? { key: String(input.chose.key), label: String(input.chose.label ?? '') } : null);
  const note = String(input.note ?? '').trim();
  if (followup && !note) throw new TicketError('a follow-up needs some text', 400);
  if (!chose && !note) throw new TicketError('a reply needs a chosen option or some text', 400);
  const { dir, file } = resolveTicket(hostPath, id);
  assertFresh(file, rev);
  const entry = composeAnswerEntry({
    kind,
    question: input.question ?? null,
    chose,
    note,
    via: 'ticket view',
    followup,
  });
  fs.appendFileSync(file, entry);

  // A decision leaves Owner 👤 (→ answered-awaiting is derived). A question or
  // counter-proposal hands ownership to the agent: flip the curated INDEX Owner
  // cell to 🤖 with a blurb that says it is waiting on the agent, not queued work.
  // Reconcile FIRST (genBoard preserves the Owner cell it finds), THEN stamp — the
  // same proven order reopenTicket uses.
  let board: BoardReconcileResult = reconcileBoard(dir);
  let owner = NEEDS_YOU;
  if (kind === 'question' || kind === 'counter') {
    owner = IN_FLIGHT;
    setOwnerCell(dir, id, IN_FLIGHT, kind === 'question' ? '🤖 to answer — user asked a question' : '🤖 to weigh — user countered');
    board = recheck(dir, board);
  }
  const after = fs.readFileSync(file, 'utf8');
  return { id, file, rev: currentRev(file), appended: entry, board, kind, owner, answer: ticketAnswerState(after) };
}

/**
 * Reopen a Done/VERIFIED ticket: flip the Status header back to OPEN, record WHY
 * in the Activity log, and hand INDEX.md to the board tool so the row moves from
 * Done to Open with the curated columns intact.
 *
 * Owner is set to 👤 at the same time, and that is deliberate rather than
 * incidental: a ticket a HUMAN reopened is waiting on a human's triage, so it
 * must show up both on the Needs-You rail and — the whole point of the feature —
 * in the "Project state" snapshot injected into the NEXT session's prompt, which
 * is composed from 👤/🤖 rows only (src/server/board.ts `boardStateSection`).
 * An owner-less reopened row would be invisible to the very agent it exists for.
 */
export function reopenTicket(hostPath: string, id: string, reason: string, rev: string | undefined): WriteResult {
  const why = String(reason ?? '').trim();
  if (!why) throw new TicketError('reopen requires a reason (it is recorded in the ticket)', 400);
  const { dir, file } = resolveTicket(hostPath, id);
  assertFresh(file, rev);
  const before = fs.readFileSync(file, 'utf8');
  const statusLine = /^- \*\*Status:\*\*\s*(.*)$/m.exec(before);
  if (!statusLine) throw new TicketError(`${id} has no "- **Status:**" line to reopen`, 400);
  const wasStatus = statusLine[1].trim();
  if (sectionOf(wasStatus) !== 'done') {
    throw new TicketError(`${id} is not Done (its Status is "${wasStatus}") — nothing to reopen`, 400);
  }
  const after = before.replace(
    /^- \*\*Status:\*\*.*$/m,
    `- **Status:** OPEN (reopened ${DATE()} by user via dashboard)`,
  );
  // Second freshness check, as late as physically possible: the read above and
  // this write are the only in-place edit in the whole feature, so the window in
  // which an agent's append could be lost is narrowed to these two statements.
  assertFresh(file, rev);
  fs.writeFileSync(file, after);
  const entry =
    `\n### ${DATE()} — ${USER_SIGNATURE}\n` +
    `- **Reopened:** status was "${wasStatus}" → OPEN.\n` +
    `${entryBody(why).replace('**Note:**', '**Why:**')}\n`;
  fs.appendFileSync(file, entry);
  // Reconcile FIRST — the Open row this ticket needs does not exist until the
  // board tool moves it out of Done — then stamp the curated Owner cell on the
  // row it just created, and re-check.
  const board = reconcileBoard(dir);
  setOwnerCell(dir, id, NEEDS_YOU, 'reopened by user');
  return { id, file, rev: currentRev(file), appended: entry, board: recheck(dir, board) };
}

/** Re-run only the CHECK half after a curated-cell edit (gen already ran). */
function recheck(dir: string, prior: BoardReconcileResult): BoardReconcileResult {
  if (!prior.reconciled) return prior;
  try {
    const r = checkBoard(dir);
    return { reconciled: true, fails: r.fails, warns: r.warns, error: null };
  } catch (err) {
    return { reconciled: true, fails: [], warns: [], error: (err as Error).message };
  }
}

/**
 * Set (or clear) the 👤 flag. Owner is a CURATED INDEX column — it exists
 * nowhere else, so this is the one place the dashboard touches INDEX.md, and it
 * rewrites exactly one cell of exactly one row before handing the file straight
 * back to `genBoard()` (which preserves what it finds there). The ticket file is
 * not touched at all: flagging is board state, not ticket history.
 */
export function setNeedsYou(hostPath: string, id: string, on: boolean): { id: string; owner: string; board: BoardReconcileResult } {
  return setBoardOwner(hostPath, id, on ? 'you' : 'unassigned');
}

/** The three states the curated Owner cell can hold, by the record's own vocabulary. */
export const OWNER_CELL: Readonly<Record<'you' | 'agent' | 'unassigned', string>> = {
  you: NEEDS_YOU, agent: IN_FLIGHT, unassigned: '—',
};

/**
 * Set the curated Open-row Owner cell. `setNeedsYou` is this function with the
 * 👤/— half of the vocabulary; the board tool (scripts/board-tool.mjs) needs the
 * 🤖 third, and a second writer of that cell is precisely how two owners of one
 * column come to disagree — so there is one writer and `setNeedsYou` delegates
 * to it rather than the other way round.
 *
 * Owner names the record's own enum (`you` / `agent` / `unassigned`), not the
 * glyph, so a caller never has to know which emoji the rail reads.
 */
export function setBoardOwner(
  hostPath: string, id: string, owner: 'you' | 'agent' | 'unassigned',
): { id: string; owner: string; board: BoardReconcileResult } {
  const cell = OWNER_CELL[owner];
  if (!cell) throw new TicketError(`unknown owner ${JSON.stringify(owner)} — expected one of ${Object.keys(OWNER_CELL).join(', ')}`, 400);
  const { dir } = resolveTicket(hostPath, id);
  const rows = readIndexRows(dir);
  if (!rows.has(id)) {
    throw new TicketError(`${id} has no row on the Open board (a Done ticket must be reopened first)`, 400);
  }
  setOwnerCell(dir, id, cell, null);
  return { id, owner: cell, board: recheck(dir, reconcileBoard(dir)) };
}

/** Rewrite one Open-row Owner cell (and optionally its Status blurb) in place. */
function setOwnerCell(dir: string, id: string, owner: string, statusBlurb: string | null): void {
  const indexPath = path.join(dir, 'INDEX.md');
  let text: string;
  try { text = fs.readFileSync(indexPath, 'utf8'); } catch { return; } // no INDEX → genBoard will report
  const lines = text.split('\n');
  let inOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+(.*)$/.exec(lines[i]);
    if (h) { inOpen = h[1].trim().toLowerCase().startsWith('open'); continue; }
    if (!inOpen) continue;
    const cells = cellsOf(lines[i]);
    if (cells[0] !== id) continue;
    cells[2] = owner;
    if (statusBlurb) cells[3] = statusBlurb;
    lines[i] = `| ${cells.join(' | ')} |`;
    fs.writeFileSync(indexPath, lines.join('\n'));
    return;
  }
  // No Open row to stamp. Callers that can hit this (reopen) run genBoard FIRST
  // so the row exists; anything else is a Done ticket, which has no Owner column
  // at all — nothing to write, and inventing one would be drift.
}

/* ─────────────────────────────────────────────────────────── new tickets */

/**
 * Next free id for a prefix: max(existing) + 1, over the ticket FILES (the
 * source of truth), matching the board tool's own `<PREFIX>-<NNN>-<slug>.md`
 * shape. Never reuses a number, even if a ticket was deleted — an id in a commit
 * message must keep meaning one thing forever.
 */
export function nextTicketId(hostPath: string, prefix: string): string {
  const p = prefix.toUpperCase();
  if (!(TICKET_PREFIXES as readonly string[]).includes(p)) {
    throw new TicketError(`unknown ticket prefix ${JSON.stringify(prefix)} — expected one of ${TICKET_PREFIXES.join(', ')}`, 400);
  }
  const dir = boardDir(hostPath);
  let max = 0;
  for (const f of ticketFiles(dir)) {
    const m = TICKET_FILE_RE.exec(path.basename(f));
    if (m && m[1] === p) max = Math.max(max, Number(m[2]));
  }
  return `${p}-${String(max + 1).padStart(3, '0')}`;
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'untitled';
}

/** The project's own template, falling back to this repo's copy. */
function templateFor(dir: string, prefix: string): string {
  const name = prefix === 'ARCH' ? 'TEMPLATE-ARCH.md' : 'TEMPLATE.md';
  for (const candidate of [path.join(dir, name), path.join(path.resolve(import.meta.dirname, '..', '..'), 'docs', 'bugs', name)]) {
    try { return fs.readFileSync(candidate, 'utf8'); } catch { /* try the next */ }
  }
  throw new TicketError(`no ${name} to file from (looked in ${dir} and this station's docs/bugs/)`, 400);
}

export interface NewTicketInput {
  prefix: string;
  title: string;
  severity?: string;
  area?: string;
  summary?: string;
  needsYou?: boolean;
}

/**
 * File a new ticket from TEMPLATE.md / TEMPLATE-ARCH.md. The template is kept
 * verbatim up to and including its `## Activity log` heading — everything below
 * that in a template is a PLACEHOLDER entry, and a placeholder in an append-only
 * log is a lie waiting to be inherited — then a single real, dated, attributed
 * entry is written.
 */
export function createTicket(hostPath: string, input: NewTicketInput): { id: string; file: string; rev: string; board: BoardReconcileResult } {
  const title = String(input.title ?? '').trim();
  if (!title) throw new TicketError('a new ticket needs a title', 400);
  const prefix = String(input.prefix ?? 'BUG').toUpperCase();
  const dir = boardDir(hostPath);
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new TicketError(`this project has no docs/bugs/ board (${dir}) — onboard it first`, 400);
  }
  const id = nextTicketId(hostPath, prefix);
  const file = path.join(dir, `${id}-${slugify(title)}.md`);
  if (fs.existsSync(file)) throw new TicketError(`refusing to overwrite ${file}`, 409);

  const tpl = templateFor(dir, prefix);
  const cut = tpl.split('\n').findIndex((l) => /^##\s+Activity log\b/i.test(l));
  const head = (cut === -1 ? tpl : tpl.split('\n').slice(0, cut + 1).join('\n'))
    .replace(/^#.*$/m, `# ${id} — ${title}`)
    .replace(/^- \*\*Status:\*\*.*$/m, '- **Status:** OPEN')
    .replace(/^- \*\*Severity:\*\*.*$/m, `- **Severity:** ${(input.severity || 'med').trim()}`)
    .replace(/^- \*\*Area:\*\*.*$/m, `- **Area:** ${(input.area || '—').trim()}`)
    .replace(/^- \*\*Reported:\*\*.*$/m, `- **Reported:** ${DATE()} by ${USER_SIGNATURE}`);
  const summary = String(input.summary ?? '').trim();
  const body = summary
    ? head.replace(/^## (Symptom|Violated invariant)\n[\s\S]*?(?=\n## )/m, (m0, sec: string) => `## ${sec}\n${summary}\n`)
    : head;
  const entry =
    `\n### ${DATE()} — ${USER_SIGNATURE}\n` +
    `- **Filed** from the ticket dashboard.\n` +
    (summary ? `${entryBody(summary)}\n` : '');
  fs.writeFileSync(file, `${body.replace(/\s*$/, '\n')}${entry}`, { flag: 'wx' });

  // genBoard adds the new Open row (with Owner '—'); stamp 👤 onto it after.
  const board = reconcileBoard(dir);
  if (input.needsYou) setOwnerCell(dir, id, NEEDS_YOU, 'filed by user');
  return { id, file, rev: currentRev(file), board: recheck(dir, board) };
}

export { NEEDS_YOU, IN_FLIGHT };
