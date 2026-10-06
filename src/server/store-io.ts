/**
 * Shared data-loss-safe primitives for the small JSON stores (requests.ts,
 * decisions.ts, outcomes.ts).
 *
 * WHY THIS EXISTS (ARCH-010 — one owner for one fact). All three stores had
 * independently grown the SAME two data-loss guards, and the FEAT-126 round-6
 * independent verify found the SAME three defects in each copy:
 *   1. quarantine renamed onto `<file>.corrupt-<timestamp>` with no existence
 *      check, silently OVERWRITING an earlier quarantine of the same name;
 *   2. two quarantines in the same millisecond collided, DESTROYING the first
 *      preserved bytes;
 *   3. the size guard was `statSync`-then-unbounded-`readFileSync`, a TOCTOU that
 *      a file growing between the stat and the read bypasses entirely.
 * Fixing each copy separately is exactly the "patch each surface as someone finds
 * it" anti-pattern ARCH-010 rejects. These two helpers are the single owner of
 * both facts; every store routes through them and keeps no private copy.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Move a present-but-unreadable store file ASIDE, preserving its bytes, to a name
 * GUARANTEED not to overwrite any existing file. Collision-safe against a
 * same-millisecond call and a concurrent process: the destination name is
 * reserved atomically with `O_EXCL` (retrying on the astronomically-rare random
 * collision), and the corrupt bytes are then moved onto that reserved name — so no
 * earlier quarantine's bytes are ever destroyed (defects 1 & 2).
 *
 * Returns the quarantine path, or null when there was nothing to move (the source
 * vanished first — ENOENT). Throws only when the bytes genuinely cannot be
 * preserved (e.g. EACCES): refusing is correct there, since a later `writeAtomic`
 * to the same directory would fail too — better to throw than to clobber.
 */
export function quarantine(file: string, label = 'store'): string | null {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const dest = `${file}.corrupt-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
    // Reserve the name atomically. O_EXCL fails with EEXIST if anything already
    // holds it, so we can never rename onto an existing quarantine.
    try {
      fs.closeSync(fs.openSync(dest, 'wx', 0o600));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue; // taken — pick another
      throw err;
    }
    // Move the corrupt bytes onto our reserved placeholder (overwrites only our
    // own just-created empty file, never another quarantine).
    try {
      fs.renameSync(file, dest);
      console.warn(
        `[orchard] ${label} store at ${file} was present but unreadable ` +
        `(torn/corrupt/wrong-shape/too-big); preserved as ${dest} and starting fresh ` +
        `(BUG-202 / FEAT-126 data-loss guard).`,
      );
      return dest;
    } catch (err) {
      try { fs.unlinkSync(dest); } catch { /* our placeholder; best-effort */ }
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null; // source gone — nothing to preserve
      throw err; // cannot preserve (EACCES, …) — refuse rather than clobber
    }
  }
  // 10k random 6-byte names all colliding is not physically reachable; treat it
  // as a hard failure rather than risk clobbering.
  throw new Error(`quarantine: could not reserve a unique name beside ${file}`);
}

/** The outcome of a capped read (see readCapped). */
export type CappedRead =
  | { kind: 'absent' }            // ENOENT — no file yet (genuinely empty, safe to create)
  | { kind: 'toobig' }            // exceeded the byte cap — treat as unreadable/corrupt
  | { kind: 'error' }             // present but unreadable (EACCES, EISDIR, a mid-read error)
  | { kind: 'ok'; data: string }; // read fully within the cap

/**
 * Read a file bounded by an ACTUAL byte cap on the open fd — never by a prior
 * `stat`. This closes the TOCTOU (defect 3): the read consumes at most `max + 1`
 * bytes from the fd, so a file that grew after any earlier check can never be read
 * unbounded (no OOM/stall) and is reported `toobig` rather than parsed. There is
 * no separate `statSync`, so there is no stat→read window to race.
 *
 * `max` is the largest content, in bytes, the caller will accept.
 */
export function readCapped(file: string, max: number): CappedRead {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error' };
  }
  try {
    // Read up to max+1 bytes: if we ever fill that one extra byte, the file is
    // over the cap regardless of what its size claimed to be.
    const buf = Buffer.allocUnsafe(max + 1);
    let total = 0;
    while (total <= max) {
      const n = fs.readSync(fd, buf, total, (max + 1) - total, null);
      if (n === 0) break; // EOF
      total += n;
    }
    if (total > max) return { kind: 'toobig' };
    return { kind: 'ok', data: buf.toString('utf8', 0, total) };
  } catch {
    return { kind: 'error' }; // e.g. EISDIR on read, I/O error — present but unreadable
  } finally {
    fs.closeSync(fd);
  }
}
