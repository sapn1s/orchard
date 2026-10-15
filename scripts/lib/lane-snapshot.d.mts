/** FEAT-176 — types for scripts/lib/lane-snapshot.mjs (the parts the server imports). */
export interface LaneSnapshotLane {
  laneId: string;
  source: 'claude-subagent' | 'claude-external' | 'codex' | string;
  transcripts: string[];
  ticket?: string[];
  status?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  cwd?: string | null;
}
export interface LaneSnapshotSpec {
  v: 1;
  top: string;
  aliases?: Array<{ from: string; to: string }>;
  cwd?: string | null;
  stationSession?: string | null;
  sdkSession?: string | null;
  lanes: LaneSnapshotLane[];
}
export const SNAPSHOT_SCRIPT: string;
export function snapshotsEnabled(env?: NodeJS.ProcessEnv): boolean;
export function spawnLaneSnapshot(spec: LaneSnapshotSpec, opts?: { env?: NodeJS.ProcessEnv; warn?: (m: string) => void }): boolean;
export function warnIfLaneWorkLost(opts: { top: string; paths?: string[] | null; env?: NodeJS.ProcessEnv; write?: (s: string) => void; timeoutMs?: number }): unknown;
