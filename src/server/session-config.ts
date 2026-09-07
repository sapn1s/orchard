/**
 * FEAT-132 — the SESSION CONFIGURATION record: what was actually injected into a
 * session's context at launch, persisted so the transcript view can show it long
 * after the live session is gone.
 *
 * WHY THIS EXISTS. The four big docs a session runs under — the Working
 * Agreement, docs/CONVENTIONS.md, provider routing and the response format — are
 * composed in templates.ts#composeInstructions and handed to the SDK as the
 * system prompt. They are NEVER written to the session JSONL, so a front-end
 * that only parses the transcript cannot see them: a reader has no way to tell
 * which rules the session was operating under, or that one of those docs was
 * silently TRUNCATED to fit its cap (BUG-146). This record is the owner
 * (agent-bridge, at launch) writing down that fact once, so the reader never has
 * to guess it (ARCH-010 / docs/CONVENTIONS.md).
 *
 * WHAT IS RECORDED, AND WHERE. One JSON per session, keyed by the engine's own
 * session id (a globally-unique UUID, so a flat dir needs no per-project
 * nesting), under <dataDir>/session-config/<sessionId>.json. Write-once: the
 * first declaration wins (the record is assembled at system:init and never
 * changes for that thread), so a resume cannot silently rewrite what an earlier
 * launch injected. Best-effort and NEVER throws — a failed record must not break
 * a session start; the reader simply degrades to a partial card.
 *
 * Sessions launched BEFORE this feature have no file. The API returns 404 and
 * the UI shows a clearly-labelled "configuration not recorded" state rather than
 * a card that implies full knowledge.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir } from '../lib/paths.ts';

/** A single injected source (one chip on the card). */
export interface SessionConfigSource {
  id: string;
  label: string;
  /**
   * - `applied`      — injected whole.
   * - `truncated`    — injected but cut to fit its cap; `droppedChars` says how much.
   * - `missing`      — a referenced doc/template that could not be read.
   * - `superseded`   — dropped because a later `replace` entry took over.
   * - `best-effort`  — known to be injected by the CLI (CLAUDE.md, skills), but
   *                    Orchard does not own its content, so the body is not recorded.
   */
  status: 'applied' | 'truncated' | 'missing' | 'superseded' | 'best-effort';
  /** Length of the injected body in characters (0 for missing/best-effort). */
  chars: number;
  /** For `truncated`: characters of the source NOT in the prompt. */
  droppedChars?: number;
  /** The injected text, so a chip can expand it inline. Empty for missing/best-effort. */
  body: string;
  /** A one-line note shown under the chip (e.g. why best-effort). */
  note?: string;
}

export interface SessionConfigRecord {
  v: 1;
  sessionId: string;
  at: string;
  projectId: string | null;
  /** How the system prompt was composed: none | append | replace. */
  mode: string;
  /** The model the CLI reported at init (m.model), or null. */
  model: string | null;
  provider: string | null;
  isolation: string | null;
  /** Every injected source, in injection order. */
  sources: SessionConfigSource[];
  /** The real attached tool list the CLI reported at init. */
  tools: string[];
  /** MCP server names Orchard attached for this session. */
  mcpServers: string[];
}

/** A session id safe to use as a file name — no traversal, no separators. */
export function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId);
}

export function sessionConfigDir(): string {
  return path.join(dataDir(), 'session-config');
}

function configFile(sessionId: string): string {
  return path.join(sessionConfigDir(), `${sessionId}.json`);
}

/**
 * Record a session's configuration. WRITE-ONCE — a later call for the same id is
 * a no-op (returns false). Atomic via temp+rename so a crash mid-write cannot
 * leave a half-written record. Best-effort: NEVER throws.
 */
export function recordSessionConfig(
  sessionId: string,
  record: Omit<SessionConfigRecord, 'v' | 'sessionId' | 'at'>,
): boolean {
  try {
    if (!isSafeSessionId(sessionId)) return false;
    const file = configFile(sessionId);
    if (fs.existsSync(file)) return false; // write-once
    fs.mkdirSync(sessionConfigDir(), { recursive: true });
    const full: SessionConfigRecord = {
      v: 1,
      sessionId,
      at: new Date().toISOString(),
      ...record,
    };
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
    try {
      if (fs.existsSync(file)) { fs.unlinkSync(tmp); return false; }
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
      return false;
    }
    return true;
  } catch {
    return false; // the record is advisory; never fatal
  }
}

/** The recorded configuration for a session, or null when none was declared. */
export function readSessionConfig(sessionId: string): SessionConfigRecord | null {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const raw = fs.readFileSync(configFile(sessionId), 'utf8');
    const obj = JSON.parse(raw) as SessionConfigRecord;
    if (obj && obj.v === 1 && Array.isArray(obj.sources)) return obj;
    return null;
  } catch {
    return null; // ENOENT (the common case — pre-feature session) or malformed
  }
}
