/**
 * FEAT-152 — a PINNED, faithful reconstruction of the ROUND-3 ledger writer
 * (`recordOrchBypass` as of the round-3 working tree, 2026-09-24): every row
 * O_APPEND-ed to ONE shared `orch-bypass-audit.jsonl`, written with a
 * `writeSync` loop, fsync'd, with NO rollback of bytes already written when a
 * later write in the loop fails.
 *
 * Why this exists: it is the FIXED pre-fix baseline for the round-4 must-FAIL
 * proofs (orphaned partial bytes fused into the next row; concurrent writers
 * interleaving). Per docs/CONVENTIONS.md a must-FAIL must not be anchored to a
 * moving baseline (HEAD / "current"), so the round-3 shape is pinned here and
 * never edited. Do NOT "fix" this file — its defects are the point.
 */
import fs from 'node:fs';
import path from 'node:path';

export function round3Ledger(dataDir: string): string {
  return path.join(dataDir, 'orch-bypass-audit.jsonl');
}

/** Returns true when round 3 would have ALLOWED ("LOGGED"), false when it DENIED. */
export function round3Record(dataDir: string, row: Record<string, unknown>): boolean {
  const target = round3Ledger(dataDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
    const { O_APPEND, O_CREAT, O_WRONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(target, O_APPEND | O_CREAT | O_WRONLY | O_NONBLOCK | O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('not a regular file');
      let written = 0;
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written, null);
        if (typeof n !== 'number' || n <= 0) throw new Error('no progress');
        written += n;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return true;
}
