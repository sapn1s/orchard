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
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';

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

function storeFile(): string {
  return path.join(dataDir(), 'requests.json');
}

function readAll(): RequestRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as RequestRecord[]) : [];
  } catch {
    return []; // no store yet, or a partial concurrent read — an empty ledger, never an error
  }
}

function writeAll(records: RequestRecord[]): void {
  ensureDir(dataDir());
  writeAtomic(storeFile(), JSON.stringify(records, null, 2));
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
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/;

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
    const info = (m[2] || '').toLowerCase();
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

/** Every valid request declaration in an assistant turn's text. */
export function parseRequestsFromText(text: string): RequestDeclaration[] {
  const out: RequestDeclaration[] = [];
  for (const body of extractRequestBlocks(text)) {
    const d = parseRequestDeclaration(body);
    if (d) out.push(d);
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
 * Upsert a declared binding. LATEST-WINS per (session, request id): a re-emitted
 * `orchard-request` for the same id updates its title / source / tickets in
 * place, exactly like a ticket status line. Never stores a status. Returns the
 * stored record.
 */
export function upsert(input: UpsertInput): RequestRecord {
  const sid = String(input.stationSessionId ?? '').trim();
  if (!sid) throw new Error('stationSessionId is required');
  const { decl } = input;
  const now = new Date().toISOString();
  const all = readAll();
  const existing = all.find((r) => r.stationSessionId === sid && r.id === decl.id);
  if (existing) {
    existing.title = decl.title;
    existing.source = decl.source;
    existing.tickets = decl.tickets;
    existing.projectId = input.projectId ?? existing.projectId ?? null;
    existing.updatedAt = now;
    writeAll(all);
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
  writeAll(all);
  return rec;
}

/**
 * Observe an assistant turn's full text and upsert every request it DECLARES.
 * Written by the server from frames it already receives (the outcomes.ts
 * precedent) — no model tokens, no second writer. Returns the records touched.
 */
export function observeAssistantText(
  stationSessionId: string,
  projectId: string | null,
  text: string,
): RequestRecord[] {
  const sid = String(stationSessionId ?? '').trim();
  if (!sid) return [];
  const decls = parseRequestsFromText(text);
  return decls.map((decl) => upsert({ stationSessionId: sid, projectId, decl }));
}

/** The declared bindings for one session, oldest first (declaration order). */
export function listForSession(stationSessionId: string): RequestRecord[] {
  const sid = String(stationSessionId ?? '').trim();
  if (!sid) return [];
  return readAll()
    .filter((r) => r.stationSessionId === sid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
