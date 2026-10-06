/**
 * FEAT-126 — "Your requests": the DECLARED user-request binding, owned by the
 * server, holding NO status of its own.
 *
 * WHY THIS EXISTS. The user cannot answer "what happened to each thing I asked
 * for" without scrolling the chat stream — state is narrated turn-by-turn and
 * then lost. The fix is a persistent surface whose unit is the USER REQUEST, and
 * the hard question it answers (ARCH-010, docs/CONVENTIONS.md) is: who OWNS the
 * fact that "message N opens a new request, and it is about X"? Only the
 * orchestrator, when it reads the user's message and decides to act. The server
 * sees frames but not intent; the raw chat is not a reliable declaration (one
 * message can open several requests, several can refine one). So the request is
 * DECLARED by the orchestrator — exactly as the `Dispatch:` line declares a
 * lane's ticket — in a leading `orchard-request` fenced block in its own turn.
 *
 * THE KEYSTONE (what makes the surface trustworthy): this store owns ONLY the
 * binding + title + source link + declared ticket ids. It stores NO status. Every
 * status cell — running work, deaths, completion/verification, next step/owner —
 * is JOINED LIVE at render from that fact's existing owner (the running snapshot,
 * the agent-outcomes ledger, the board). Because the request holds no status it
 * cannot disagree with the board: it IS the board / liveness / outcomes, grouped
 * by the declared request key. That is both the ARCH-010 answer and the
 * anti-staleness guarantee. NEVER add a cached status field to RequestRecord —
 * that single shortcut recreates the "unmaintained summary rail" the origin
 * review rejected.
 *
 * SAME STRUCTURE AS decisions.ts / outcomes.ts: server-owned, single-writer, a
 * small JSON store under the data dir, written with `writeAtomic` (temp + fsync +
 * rename) so a crash mid-write never truncates it, and read tolerantly so a
 * partial/concurrent read yields an empty ledger rather than an error.
 */
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';
import { quarantine, readCapped } from './store-io.ts';

/**
 * A declared request binding. NO STATUS — see the header. `title` and `source`
 * are the identity the orchestrator wrote; `tickets` is the declared membership
 * (joined live against the board by id). Everything a reader wants to KNOW about
 * the request (is it running? did a lane die? is it verified?) is read elsewhere.
 */
export interface RequestRecord {
  /** The declared id, e.g. `REQ-7`. Unique per session. */
  id: string;
  /** The station session (AgentSession.id) this request belongs to. */
  stationSessionId: string;
  /** The project the declaring turn belonged to, for board joins. May be null. */
  projectId: string | null;
  /** The human title the orchestrator declared. */
  title: string;
  /** The source user-message uuid (a transcript anchor), or null. */
  source: string | null;
  /** Declared ticket ids bound to this request. Joined live against the board. */
  tickets: string[];
  createdAt: string;
  updatedAt: string;
}

/** The identity an `orchard-request` block declares (no status, ever). */
export interface RequestDeclaration {
  id: string;
  title: string;
  source: string | null;
  tickets: string[];
}

/* ─────────────────────────────── storage layout ─────────────────────────────
 *
 * ONE FILE PER SESSION, under `dataDir()/requests/<enc(sessionId)>.json`, each
 * holding only that session's RequestRecord[]. This is the DESIGN fix for the
 * cross-session data-loss FEAT-126 round-1 independent verify found (run
 * 25cdb5ae): the old single shared `requests.json` was mutated read-all →
 * write-all, so any session's write rewrote the WHOLE file from the snapshot it
 * had read. Two ways that lost other sessions' bindings:
 *   1. concurrent writers (two server processes) — each rewrote the file from a
 *      stale read, dropping the record the other had just added (lost update);
 *   2. a transient/torn read — `readAll` returned [] for an unreadable file (its
 *      own "tolerant" contract), and the write then put [newRecord] over
 *      everything, WIPING every other session.
 * A per-session file removes the shared write target entirely: a write for
 * session A can only ever touch A's file, so it is STRUCTURALLY impossible for
 * it to disturb session B's bindings (ARCH-010 — no second place able to hold a
 * different answer, and no shared array to clobber). Each session has exactly
 * one writer (its one driving server process), so its own file is never torn by
 * a concurrent write of itself.
 *
 * Belt-and-braces for the torn-read half: a read distinguishes "no file yet"
 * (genuinely empty, safe to create) from "file present but unreadable" (torn /
 * mid-write / corrupt). An upsert REFUSES to write over an unreadable file — a
 * gap, not a wipe. The declaration is latest-wins and re-emitted next turn, so a
 * skipped upsert self-heals, whereas a clobber is permanent.
 *
 * NOTE (arch-watch): decisions.ts and outcomes.ts share the old read-all/
 * write-all-one-shared-file shape and the same latent defect; they are
 * lower-frequency and out of scope for this ticket — flagged, not fixed here.
 */
function storeDir(): string {
  return path.join(dataDir(), 'requests');
}

/** The per-session store file. `encodeURIComponent` is injective and strips the
 *  path separators an opaque session id might contain, so no two ids collide and
 *  none escapes the store dir. */
function sessionFile(sid: string): string {
  return path.join(storeDir(), `${encodeURIComponent(sid)}.json`);
}

interface SessionRead {
  records: RequestRecord[];
  /** false = the file is present but could not be read as a WELL-SHAPED record
   *  array (torn / mid-write / corrupt / valid-JSON-of-the-wrong-shape / too big).
   *  A writer must NOT clobber it (quarantine first); a reader returns empty. */
  ok: boolean;
}

/**
 * A per-session store file bigger than this is treated as corrupt WITHOUT being
 * read into memory (a session realistically holds a handful of ~300-byte records;
 * even thousands stay well under a megabyte). This bounds a hostile/garbage file
 * so a "huge file" can never OOM or stall the read path — it is refused like any
 * other wrong shape.
 */
const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024;

/**
 * FULL shape validation (round-5 finding): `Array.isArray` alone let valid JSON
 * of the WRONG SHAPE through — an array of malformed rows became "records", so a
 * read threw (e.g. `undefined.localeCompare` when sorting a row with no
 * `createdAt`) and a write clobbered the file. A record must be a plain object
 * with every required field present and correctly typed; unknown EXTRA fields are
 * tolerated (forward-compatible). One bad row makes the WHOLE file corrupt.
 */
function isRequestRecord(o: unknown): o is RequestRecord {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string';
  const strOrNull = (v: unknown) => v === null || typeof v === 'string';
  return (
    str(r.id) && (r.id as string).length > 0 &&
    str(r.stationSessionId) && (r.stationSessionId as string).length > 0 &&
    strOrNull(r.projectId) &&
    str(r.title) &&
    strOrNull(r.source) &&
    Array.isArray(r.tickets) && (r.tickets as unknown[]).every(str) &&
    str(r.createdAt) &&
    str(r.updatedAt)
  );
}

function readSession(sid: string): SessionRead {
  // Bounded read on the fd (store-io.readCapped) — no stat→read TOCTOU, and a
  // file over the cap is refused without being read into memory.
  const res = readCapped(sessionFile(sid), MAX_SESSION_FILE_BYTES);
  if (res.kind === 'absent') return { records: [], ok: true };
  if (res.kind !== 'ok') return { records: [], ok: false }; // toobig | error — present but unreadable
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.data);
  } catch {
    return { records: [], ok: false }; // torn / partial / non-JSON — do not clobber
  }
  // Valid JSON but must be an ARRAY of WELL-SHAPED records — anything else (an
  // object, null, an array with a malformed/mistyped row) is corrupt, never
  // clobbered, never returned as records (so a read can't throw on it).
  if (!Array.isArray(parsed) || !parsed.every(isRequestRecord)) return { records: [], ok: false };
  return { records: parsed as RequestRecord[], ok: true };
}

function writeSession(sid: string, records: RequestRecord[]): void {
  ensureDir(storeDir());
  writeAtomic(sessionFile(sid), JSON.stringify(records, null, 2));
}

/* ─────────────────────────── the orchard-request block parser ─────────────────
 *
 * A leading (or short-lead-in) fenced code block whose info-string is
 * `orchard-request`, parallel to `orchard-digest`. Body is JSON:
 *
 *   ```orchard-request
 *   { "id": "REQ-7", "title": "…", "source": "<uuid>", "tickets": ["FEAT-126"] }
 *   ```
 *
 * TWO STRICTNESSES, both from the same failure class parseDispatchDeclaration
 * guards (a recogniser over prose returning the wrong answer):
 *  1. A block QUOTED inside another fence is IGNORED. The scan is a state machine:
 *     once inside ANY fence, everything until its matching close is body — a
 *     `orchard-request` example inside a bash/markdown block never opens. This is
 *     what lets a lane document the grammar without declaring it.
 *  2. Malformed / wrong-shape JSON yields NOTHING for that block (a gap, not a
 *     guess) — never a fabricated record.
 * Multiple blocks in one turn are allowed (a turn may open several requests).
 */
// A fence OPENS on any run of ≥3 backticks/tildes followed by an OPTIONAL info
// string — which may be MULTIPLE whitespace-separated tokens (CommonMark:
// ```` ```markdown title=x ````). The old pattern anchored `[ \t]*$` right after a
// single `[^\s]*` token, so a multi-token info string did not match at all and
// the fence never opened — its body (incl. a quoted `orchard-request`) then leaked
// as top-level (FEAT-126 r1 finding). Capturing the WHOLE info string and keying
// on its FIRST token keeps every fence's body inert while still recognising a real
// `orchard-request` open (a single-token info string).
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

function closeReFor(run: string): RegExp {
  const ch = run[0] === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}\\${ch}{${run.length},}[ \\t]*$`);
}

/** Every top-level `orchard-request` block body in `text`, in document order. */
export function extractRequestBlocks(text: string): string[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const bodies: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const run = m[1];
    // Only the FIRST token of the info string names the language; the rest are
    // attributes. A block declares only when that first token is `orchard-request`.
    const info = (m[2] || '').trim().split(/[ \t]+/)[0].toLowerCase();
    const closeRe = closeReFor(run);
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !closeRe.test(lines[j])) { body.push(lines[j]); j++; }
    // j is the closing fence (or end-of-text: an unterminated fence declares nothing).
    if (j < lines.length && info === 'orchard-request') bodies.push(body.join('\n'));
    i = j + 1; // skip past the close; body lines were consumed, so nested fences never re-open
  }
  return bodies;
}

/** Parse one block body into a declaration, or null (malformed / wrong shape). */
export function parseRequestDeclaration(jsonText: string): RequestDeclaration | null {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!/^REQ-\d+$/.test(id)) return null; // an id is the one required fact; no id → no request
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null; // a request with no title carries nothing a reader can act on
  const source = typeof o.source === 'string' && o.source.trim() ? o.source.trim() : null;
  const tickets = Array.isArray(o.tickets)
    ? [...new Set(o.tickets.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean))]
    : [];
  return { id, title, source, tickets };
}

/** True iff two declarations for the same id carry the same facts (tickets as a
 *  set — order/dup-insensitive, already trimmed by parseRequestDeclaration). */
function sameDeclaration(a: RequestDeclaration, b: RequestDeclaration): boolean {
  if (a.title !== b.title || a.source !== b.source) return false;
  if (a.tickets.length !== b.tickets.length) return false;
  const sa = [...a.tickets].sort();
  const sb = [...b.tickets].sort();
  return sa.every((t, i) => t === sb[i]);
}

/**
 * Every valid request declaration in an assistant turn's text, resolved per id.
 *
 * WITHIN ONE TURN two declarations that DISAGREE about the same id yield NOTHING
 * for that id — a gap, not a guess (the same strictness parseDispatchDeclaration
 * applies to a repeated-but-conflicting key: "a guess is not a fact"). Identical
 * repeats collapse to one. This is per-turn: cross-turn refinement stays
 * latest-wins, because that happens across separate `observeAssistantText` calls,
 * each parsing one turn.
 */
export function parseRequestsFromText(text: string): RequestDeclaration[] {
  const raw: RequestDeclaration[] = [];
  for (const body of extractRequestBlocks(text)) {
    const d = parseRequestDeclaration(body);
    if (d) raw.push(d);
  }
  const byId = new Map<string, { decl: RequestDeclaration; conflict: boolean }>();
  const order: string[] = [];
  for (const d of raw) {
    const cur = byId.get(d.id);
    if (!cur) { byId.set(d.id, { decl: d, conflict: false }); order.push(d.id); }
    else if (!cur.conflict && !sameDeclaration(cur.decl, d)) cur.conflict = true;
  }
  const out: RequestDeclaration[] = [];
  for (const id of order) {
    const e = byId.get(id)!;
    if (!e.conflict) out.push(e.decl); // a conflicting id is dropped: a gap, never a last-wins guess
  }
  return out;
}

/* ─────────────────────────────────── the store ──────────────────────────────── */

export interface UpsertInput {
  stationSessionId: string;
  projectId?: string | null;
  decl: RequestDeclaration;
}

/**
 * Upsert a declared binding into its OWN session's file. LATEST-WINS per
 * (session, request id): a re-emitted `orchard-request` for the same id updates
 * its title / source / tickets in place, exactly like a ticket status line.
 * Never stores a status.
 *
 * DATA-LOSS SAFETY: reads and writes ONLY this session's file (so it can never
 * touch another session's bindings), and if that file is present but unreadable
 * (torn / mid-write / corrupt / valid-JSON-of-the-wrong-shape / too big) it NEVER
 * clobbers it — the corrupt bytes are QUARANTINED aside (renamed) first, then a
 * fresh file is written with this record. Because requests re-emit latest-wins,
 * the session self-heals; the preserved bytes stay recoverable. Returns the
 * stored record (always, now — the write is never silently skipped).
 */
export function upsert(input: UpsertInput): RequestRecord {
  const sid = String(input.stationSessionId ?? '').trim();
  if (!sid) throw new Error('stationSessionId is required');
  const { decl } = input;
  const now = new Date().toISOString();
  const read = readSession(sid);
  // A present-but-unreadable file is preserved (quarantine), never overwritten as
  // if empty; we then start fresh from an empty set for this session. requests
  // re-emit latest-wins, so the session self-heals after a quarantine.
  if (!read.ok) quarantine(sessionFile(sid), `requests(session ${sid})`);
  const all = read.ok ? read.records : [];
  const existing = all.find((r) => r.id === decl.id);
  if (existing) {
    existing.title = decl.title;
    existing.source = decl.source;
    existing.tickets = decl.tickets;
    existing.projectId = input.projectId ?? existing.projectId ?? null;
    existing.updatedAt = now;
    writeSession(sid, all);
    return existing;
  }
  const rec: RequestRecord = {
    id: decl.id,
    stationSessionId: sid,
    projectId: input.projectId ?? null,
    title: decl.title,
    source: decl.source,
    tickets: decl.tickets,
    createdAt: now,
    updatedAt: now,
  };
  all.push(rec);
  writeSession(sid, all);
  return rec;
}

/**
 * Observe an assistant turn's full text and upsert every request it DECLARES.
 * Written by the server from frames it already receives (the outcomes.ts
 * precedent) — no model tokens, no second writer. Returns the records stored.
 */
export function observeAssistantText(
  stationSessionId: string,
  projectId: string | null,
  text: string,
): RequestRecord[] {
  const sid = String(stationSessionId ?? '').trim();
  if (!sid) return [];
  return parseRequestsFromText(text).map((decl) =>
    upsert({ stationSessionId: sid, projectId, decl }));
}

/** The declared bindings for one session, oldest first (declaration order). */
export function listForSession(stationSessionId: string): RequestRecord[] {
  const sid = String(stationSessionId ?? '').trim();
  if (!sid) return [];
  return readSession(sid).records
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
