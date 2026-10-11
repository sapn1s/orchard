/**
 * BUG-239 — the LANE INCIDENT LEDGER: the durable record of every time Orchard
 * bounded a lane on the user's behalf, so that bounding is never silent.
 *
 * Three kinds:
 *   permission-expired — a lane's permission card got no answer by its deadline
 *                        and was REFUSED (never approved). The user did not decide.
 *   lane-parked        — a lane ended while background work it started was still
 *                        running or unread (the no-parking guard let it go).
 *   park-guard-error   — the guard could not judge (transcript unreadable, too
 *                        large, or over its time budget) and allowed the stop.
 *
 * STORAGE — ROTATED BY DAY, so a window read is bounded by STRUCTURE, not bytes
 * (round 2; independent verify d8d016bd found the round-1 byte-tail read let
 * refusals still inside the 24 h window vanish once the single file passed
 * 512 KB). Records go to `<dataDir>/lane-incidents/<UTC YYYY-MM-DD>.jsonl`,
 * filed by the record's own `at`. A window read opens exactly the day files the
 * window touches (2 for 24 h) and reads each WHOLE. A day file over
 * `PER_FILE_CAP` is not silently cut: the read returns a visible
 * `park-guard-error` record naming the file and its size instead.
 *
 * The pre-rotation single file `<dataDir>/lane-incidents.jsonl` (round 1) is
 * still read, whole and under the same cap, so nothing recorded before this
 * change disappears. Nothing here deletes a record. Reads are tolerant: a
 * half-written last line is skipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../lib/paths.ts';

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

/** A day file larger than this is reported, not read (32 MB ≈ 100k records). */
export const PER_FILE_CAP = 32 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function incidentsDir(dir: string = dataDir()): string {
  return path.join(dir, 'lane-incidents');
}

/** The day file a record with this timestamp belongs to. */
export function incidentFileFor(atMs: number, dir: string = dataDir()): string {
  return path.join(incidentsDir(dir), `${new Date(atMs).toISOString().slice(0, 10)}.jsonl`);
}

/** The round-1 single-file ledger, still read so nothing recorded earlier vanishes. */
export function legacyIncidentsPath(dir: string = dataDir()): string {
  return path.join(dir, 'lane-incidents.jsonl');
}

/** Append one record. Never throws: a full disk must not break a permission settle. */
export function recordIncident(rec: Omit<LaneIncident, 'at'> & { at?: string }, dir: string = dataDir()): LaneIncident {
  const full: LaneIncident = { ...rec, at: rec.at ?? new Date().toISOString() };
  try {
    const t = Date.parse(full.at);
    const file = incidentFileFor(Number.isFinite(t) ? t : Date.now(), dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  } catch (err) {
    console.warn(`[orchard] BUG-239: could not persist lane incident (${(err as Error).message}): ${full.kind} ${full.summary}`);
  }
  return full;
}

function readWhole(file: string, cap: number, now: number): { text: string } | { tooLarge: LaneIncident } | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size > cap) {
    return {
      tooLarge: {
        kind: 'park-guard-error',
        at: new Date(now).toISOString(),
        projectId: null,
        sessionId: null,
        agentId: null,
        summary: `the lane-incident ledger file ${path.basename(file)} is ${size} bytes (over the ${cap}-byte read cap), so its records are NOT shown here`,
        detail: `Read it directly: ${file}`,
      },
    };
  }
  try { return { text: fs.readFileSync(file, 'utf8') }; } catch { return null; }
}

/** Incidents inside the window (newest last), optionally for one project. */
export function recentIncidents(
  opts: { projectId?: string | null; windowMs?: number; now?: number; dir?: string; perFileCap?: number } = {},
): LaneIncident[] {
  const dir = opts.dir ?? dataDir();
  const windowMs = opts.windowMs ?? DAY_MS;
  const now = opts.now ?? Date.now();
  const cap = opts.perFileCap ?? PER_FILE_CAP;
  const files: string[] = [legacyIncidentsPath(dir)];
  // Every UTC day the window [now - windowMs, now] touches — a structural bound.
  const firstDay = Math.floor((now - windowMs) / DAY_MS);
  const lastDay = Math.floor(now / DAY_MS);
  for (let d = firstDay; d <= lastDay; d++) files.push(incidentFileFor(d * DAY_MS, dir));
  const out: LaneIncident[] = [];
  const notices: LaneIncident[] = [];
  for (const file of files) {
    const r = readWhole(file, cap, now);
    if (!r) continue;
    if ('tooLarge' in r) { notices.push(r.tooLarge); continue; }
    for (const line of r.text.split('\n')) {
      if (!line.trim()) continue;
      let rec: LaneIncident;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.kind !== 'string' || typeof rec.at !== 'string') continue;
      const t = Date.parse(rec.at);
      if (!Number.isFinite(t) || now - t > windowMs || t - now > 60_000) continue;
      if (opts.projectId !== undefined && rec.projectId !== opts.projectId) continue;
      out.push(rec);
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A too-large file concerns every project: never filtered out.
  return [...out, ...notices];
}
