/**
 * Session provenance — who STARTED a session: a person, or an agent.
 *
 * WHY THIS EXISTS. The sidebar lists every session in a project's transcript
 * store. An orchestrator that DISPATCHES worker lanes (scripts/dispatch.mjs — a
 * real top-level `claude -p` / codex run in the project's own cwd) fills that
 * store with rows the user never opened: a busy project ends up with more
 * agent-dispatched rows than human conversations, and the human's own thread is
 * buried (reported by a user for one of their projects, and measured earlier in
 * Orchard's own store). These rows carry ticket ids as titles, which is why a
 * TITLE-shaped heuristic is the wrong tool: a human who types a ticket id would
 * be mislabelled by it. So provenance is DECLARED at creation, never inferred
 * from how the row looks (CONVENTIONS: whoever owns a fact writes it once).
 *
 * WHAT IS RECORDED, AND WHERE. One tiny JSON per session, keyed by the engine's
 * own session id, under <dataDir>/session-provenance/<sessionId>.json:
 *   { startedBy: 'user' | 'agent', source, at }
 * Session ids are globally-unique UUIDs, so a flat dir keyed by id needs no
 * per-project nesting and never collides across projects. Write-once: the first
 * declaration wins, so a re-record cannot silently flip a row's provenance.
 *
 * SELF-CONTAINED ON PURPOSE. This module is imported by BOTH the server (.ts,
 * type-stripped) AND scripts/dispatch.mjs, which runs in a spawned subprocess
 * under whatever `node` the host has. So it must NOT import any `.ts` (a node
 * without type-stripping would crash the dispatch over a peripheral record).
 * The data-dir resolution below therefore MIRRORS src/lib/paths.ts#dataDir —
 * kept in lockstep by verify-session-provenance.mjs, which asserts the two
 * agree. Its only non-builtin import is the PURE shared dispatch grammar.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseDispatchDeclaration } from '../../scripts/lib/cost-model.mjs';

export const STARTED_BY_VALUES = new Set(['user', 'agent']);

/**
 * MIRROR of src/lib/paths.ts#dataDir(). Any change there must change here too;
 * verify-session-provenance.mjs fails if they diverge. Self-contained so the
 * dispatch subprocess never needs the TypeScript module loaded.
 */
export function stationDataDir() {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

export function provenanceDir() {
  return path.join(stationDataDir(), 'session-provenance');
}

/** A session id safe to use as a file name — no traversal, no separators. */
export function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId);
}

function provenanceFile(sessionId) {
  return path.join(provenanceDir(), `${sessionId}.json`);
}

/**
 * Record who started a session. WRITE-ONCE — a later call for the same id is a
 * no-op (returns false), so provenance can never be flipped after the fact, and
 * two racing writers cannot disagree. Best-effort and NEVER throws: a failed
 * record must not break a session start or a dispatch. Returns true only when it
 * wrote a fresh record.
 */
export function recordSessionProvenance(sessionId, startedBy, extra = {}) {
  try {
    if (!isSafeSessionId(sessionId) || !STARTED_BY_VALUES.has(startedBy)) return false;
    const file = provenanceFile(sessionId);
    if (fs.existsSync(file)) return false; // write-once
    fs.mkdirSync(provenanceDir(), { recursive: true });
    const record = {
      sessionId,
      startedBy,
      source: typeof extra.source === 'string' ? extra.source : null,
      at: new Date().toISOString(),
    };
    // Atomic: write to a unique temp then rename, so a crash mid-write cannot
    // leave a half-written record that reads as malformed.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    // rename() is atomic within a dir; if the target appeared meanwhile
    // (another writer won the race) keep the first, discard ours.
    try {
      if (fs.existsSync(file)) { fs.unlinkSync(tmp); return false; }
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
      return false;
    }
    return true;
  } catch {
    return false; // provenance is advisory; never fatal
  }
}

/** The recorded provenance for a session, or null when none was declared. */
export function readSessionProvenance(sessionId) {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const raw = fs.readFileSync(provenanceFile(sessionId), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && STARTED_BY_VALUES.has(obj.startedBy)) return obj;
    return null;
  } catch {
    return null; // ENOENT (the common case) or malformed — treated as "unrecorded"
  }
}

/**
 * Load EVERY recorded provenance in one pass, as a Map<sessionId, record>. The
 * session-list endpoint calls this ONCE per request and resolves each row from
 * the map, instead of a stat/read per row (BUG-158 keeps listing cheap). An
 * absent/unreadable dir is simply an empty map.
 */
export function loadProvenanceMap() {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(provenanceDir());
  } catch {
    return out; // dir absent — nothing recorded yet
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -5);
    const rec = readSessionProvenance(sessionId);
    if (rec) out.set(sessionId, rec);
  }
  return out;
}

/**
 * The CONSERVATIVE fallback for PRE-EXISTING sessions only (no recorded
 * provenance because they predate this field). A dispatched lane's first user
 * message BEGINS with the machine declaration line scripts/dispatch.mjs emits —
 *     Dispatch: ticket=BUG-099 phase=fixing round=2 class=fix
 * — parsed here through the SAME grammar the dispatcher formats with. This is a
 * far stronger signal than "the title looks like a ticket": a human would have
 * to type that exact key=value line, verbatim, as their opening message. We
 * require at least one genuinely-declared field (a bare "dispatch:" is not
 * enough), so the fallback errs toward SHOWING — a false hide of a real human
 * session is the outcome to avoid, and hundreds of pre-existing sessions must
 * never default to hidden.
 */
export function looksAgentDispatched(firstUserMessage) {
  if (typeof firstUserMessage !== 'string' || !firstUserMessage.trim()) return false;
  // Cheap gate before the parser: the declaration is always at the very start.
  if (!/^\s*dispatch\s*:/i.test(firstUserMessage)) return false;
  const d = parseDispatchDeclaration(firstUserMessage);
  if (!d || !d.present) return false;
  const hasField = (Array.isArray(d.tickets) && d.tickets.length > 0)
    || d.phase != null || d.class != null || d.round != null;
  return Boolean(hasField);
}

/**
 * Resolve a session's effective provenance for the picker. Order:
 *   1. an explicit RECORD (declared at creation) — always wins;
 *   2. else the conservative pre-existing fallback (declaration line);
 *   3. else 'user' — the safe default that keeps a row VISIBLE.
 * `record` may be passed in (from loadProvenanceMap) to avoid a re-read.
 */
export function resolveStartedBy({ sessionId, firstUserMessage, record } = {}) {
  const rec = record ?? (sessionId ? readSessionProvenance(sessionId) : null);
  if (rec && STARTED_BY_VALUES.has(rec.startedBy)) return rec.startedBy;
  if (looksAgentDispatched(firstUserMessage)) return 'agent';
  return 'user';
}
