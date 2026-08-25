/**
 * scratch.mjs — where LONG-LIVED or EXPENSIVE scratch goes, and why it is not `/tmp`.
 *
 * On this machine `/etc/tmpfiles.d/tmp.conf` wipes all of `/tmp` on every boot.
 * That is correct system policy and nothing here tries to change it — it simply
 * makes `/tmp` the wrong home for two kinds of directory the tooling creates:
 *
 *   - EXPENSIVE ones. `independent-verify.mjs` builds a clean room by exporting
 *     the tree and copying this project's 374 MB / ~10,900-file `node_modules`
 *     with `cp -a --reflink=auto`. On a CoW filesystem that is ~0.4 s and ~0
 *     extra bytes; anywhere else it is a real 374 MB copy. Rebuilding one is
 *     minutes of dispatch time, not milliseconds.
 *   - LONG-LIVED ones. A room kept with `--keep-cleanroom`, and the record dir
 *     holding `manifest.jsonl` + `<id>.out`, are the artifacts a verdict CITES.
 *     They are read after the run — sometimes days later, when the ticket is
 *     being closed — so a boot in between must not eat the evidence.
 *
 * SHORT-LIVED scratch is a different animal and stays on `/tmp` deliberately: a
 * few JSON files written, read and `rm`'d inside one `finally` block, seconds
 * apart, is exactly what `/tmp` is for. See docs/CONVENTIONS.md for the rule as
 * stated for humans; the test for which side a directory falls on is "would
 * losing this cost me more than re-running the thing that made it?".
 *
 * SAME FILESYSTEM AS THE REPO — the non-obvious constraint. `--reflink=auto`
 * fails SILENTLY: cross a filesystem boundary and `cp` just does a real copy
 * and exits 0. Nothing is wrong, everything still passes, and the copy quietly
 * costs full size and full time. So the boundary is CHECKED, in the same shape
 * `src/server/snapshots.ts` checks it for the snapshot store (`assertSameFilesystem`):
 * both device numbers, both filesystem types, what is lost, and how to fix it.
 * Unlike snapshots this REPORTS rather than throws — a snapshot on the wrong
 * filesystem permanently consumes the project's full size on disk, whereas a
 * clean room is a throwaway whose only cost is seconds. Wrong-but-slow is worth
 * a loud line; it is not worth refusing to verify.
 *
 * Deliberately NOT age-swept. A sweeper here would be re-inventing the thing we
 * just escaped, and could delete a directory a still-running process is using
 * (see the escaped-host-scope ticket). Kept rooms are the operator's to remove;
 * every caller prints the path it used.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The one knob. Named for the `CLAUDE_STATION_*` convention already used by
 * `CLAUDE_STATION_DATA` (src/lib/paths.ts) — and deliberately NOT
 * `CLAUDE_STATION_SCRATCH_DIR`, which is already taken and means something
 * entirely different: the Orchard-owned scratch PROJECT's working directory,
 * a user-visible place sessions run in. This one is tooling scratch.
 */
export const SCRATCH_ENV = 'CLAUDE_STATION_TMPDIR';

/** Candidate roots, best first. The first one we can actually create wins. */
function candidates() {
  const out = [];
  const env = process.env[SCRATCH_ENV];
  if (env && env.trim()) out.push({ dir: path.resolve(env.trim()), why: `$${SCRATCH_ENV}` });
  // Persistent, not boot-wiped, on the same filesystem as $HOME (and so as a
  // repo under $HOME). XDG_STATE_HOME is the spec's home for exactly this:
  // state that should persist between restarts but is not precious enough for
  // the data dir.
  const xdg = process.env.XDG_STATE_HOME;
  const stateBase = xdg && xdg.trim() ? path.resolve(xdg.trim()) : path.join(os.homedir(), '.local', 'state');
  out.push({ dir: path.join(stateBase, 'claude-station', 'scratch'), why: xdg ? '$XDG_STATE_HOME' : '~/.local/state' });
  // Last resorts, in the order a POSIX tool would pick them. These ARE the
  // boot-wiped locations we are trying to avoid, so reaching one is a
  // degradation, reported by `scratchRootInfo().degraded`, not a silent default.
  const tmpenv = process.env.TMPDIR;
  if (tmpenv && tmpenv.trim()) out.push({ dir: path.resolve(tmpenv.trim()), why: '$TMPDIR', degraded: true });
  out.push({ dir: os.tmpdir(), why: 'system temp dir', degraded: true });
  return out;
}

let cached = null;

/**
 * Resolve (and create) the scratch root. Falls FORWARD on failure — an
 * unwritable or unmakeable candidate is skipped rather than fatal, because a
 * verification that cannot run at all is worse than one running somewhere
 * suboptimal. What it settled on, and whether that was a degradation, is
 * always inspectable.
 */
export function scratchRootInfo() {
  if (cached) return cached;
  const tried = [];
  for (const c of candidates()) {
    try {
      fs.mkdirSync(c.dir, { recursive: true });
      fs.accessSync(c.dir, fs.constants.W_OK);
      cached = { dir: c.dir, source: c.why, degraded: !!c.degraded, tried };
      return cached;
    } catch (err) {
      tried.push(`${c.dir} (${c.why}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Every candidate including os.tmpdir() failed. Nothing sensible is left.
  throw new Error(`no usable scratch root — tried:\n  ${tried.join('\n  ')}`);
}

/** The scratch root path. */
export function scratchRoot() {
  return scratchRootInfo().dir;
}

/** `mkdtemp` inside the scratch root. Drop-in for `mkdtempSync(join(os.tmpdir(), p))`. */
export function mkdtempScratch(prefix) {
  return fs.mkdtempSync(path.join(scratchRoot(), prefix));
}

/** Filesystem type of the mount `p` sits under, or null. Mirrors snapshots.fsTypeOf. */
export function fsTypeOf(p) {
  const r = spawnSync('findmnt', ['-n', '-o', 'FSTYPE', '-T', p], { encoding: 'utf8' });
  const t = (r.stdout ?? '').trim().split('\n').pop()?.trim();
  return t || null;
}

/**
 * Same-filesystem preflight for a reflink copy, in the shape
 * `snapshots.assertSameFilesystem` uses — device numbers, filesystem types,
 * what the boundary costs, and the knob that fixes it. Returns a report instead
 * of throwing (see the header): `{ ok, message }`.
 *
 * `destParent` need not exist yet; the nearest existing ancestor is measured,
 * exactly as the snapshot preflight does, so the check can run before anything
 * is created.
 */
export function checkSameFilesystem(src, destParent) {
  let a, b, bAt;
  try {
    a = fs.statSync(src);
    bAt = nearestExisting(destParent);
    b = fs.statSync(bAt);
  } catch (err) {
    return { ok: true, unknown: true, message: `same-filesystem check could not run (${err instanceof Error ? err.message : String(err)}) — proceeding` };
  }
  if (a.dev === b.dev) {
    return { ok: true, message: `same filesystem as ${src} (device ${a.dev} [${fsTypeOf(src) ?? 'unknown'}]) — reflink copies apply` };
  }
  return {
    ok: false,
    message:
      `SCRATCH IS ON A DIFFERENT FILESYSTEM from ${src}: ${bAt} is device ${b.dev} [${fsTypeOf(bAt) ?? 'unknown'}], ` +
      `${src} is device ${a.dev} [${fsTypeOf(src) ?? 'unknown'}]. ` +
      `Reflink copies share extents and cannot cross a filesystem boundary, and \`cp --reflink=auto\` does NOT fail on that — ` +
      `it silently does a full byte copy, costing the source's full size and full time on every run. ` +
      `Fix by pointing $${SCRATCH_ENV} at a directory on the same filesystem as the repo.`,
  };
}

/** Walk up until something exists (snapshots.nearestExisting, same reasoning). */
function nearestExisting(target) {
  let cur = path.resolve(target);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}
