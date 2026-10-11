/**
 * BUG-239 — the LANE INCIDENT LEDGER: the durable record of every time Orchard
 * bounded a lane on the user's behalf, so that bounding is never silent.
 *
 * Three kinds:
 *   permission-expired — a lane's permission card got no answer by its deadline
 *                        and was REFUSED (never approved). The user did not decide.
 *   lane-parked        — a lane ended while background work it started was still
 *                        running or unread (the no-parking guard let it go: it
 *                        declined to wait, hit the ceiling, or was blocked on an
 *                        expired permission). Its child may have been killed.
 *   park-guard-error   — the guard could not judge (transcript unreadable or too
 *                        large) while live background work existed; it allowed the
 *                        stop and says so here.
 *
 * Append-only JSONL at `<dataDir>/lane-incidents.jsonl`, so a service restart does
 * not erase an omission before anyone sees it (in-memory lists did — the
 * cross-provider plan review's finding 9). The Needs-You rail reads the recent
 * window (24 h by default) on every board read; nothing here deletes a record.
 * Reads are tolerant: a half-written last line is skipped, and only the file's
 * tail (bounded) is read so a long-lived ledger never slows the board.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../../../../src/lib/paths.ts';

export type LaneIncidentKind = 'permission-expired' | 'lane-parked' | 'park-guard-error';

export interface LaneIncident {
  kind: LaneIncidentKind;
  at: string;
  projectId: string | null;
  sessionId: string | null;
  agentId: string | null;
  /** Lane description when known (dispatch description / agent type). */
  lane?: string | null;
  tool?: string | null;
  /** One line a person can act on. */
  summary: string;
  detail?: string;
}

const TAIL_BYTES = 512 * 1024;

export function incidentsPath(dir: string = dataDir()): string {
  return path.join(dir, 'lane-incidents.jsonl');
}

/** Append one record. Never throws: a full disk must not break a permission settle. */
export function recordIncident(rec: Omit<LaneIncident, 'at'> & { at?: string }, file: string = incidentsPath()): LaneIncident {
  const full: LaneIncident = { ...rec, at: rec.at ?? new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  } catch (err) {
    console.warn(`[orchard] BUG-239: could not persist lane incident (${(err as Error).message}): ${full.kind} ${full.summary}`);
  }
  return full;
}

/** Recent incidents (newest last), optionally for one project. Tolerant of a torn tail. */
export function recentIncidents(
  opts: { projectId?: string | null; windowMs?: number; now?: number; file?: string } = {},
): LaneIncident[] {
  const file = opts.file ?? incidentsPath();
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  let text = '';
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
      if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out: LaneIncident[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: LaneIncident;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.kind !== 'string' || typeof r.at !== 'string') continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || now - t > windowMs) continue;
    if (opts.projectId !== undefined && r.projectId !== opts.projectId) continue;
    out.push(r);
  }
  return out;
}
