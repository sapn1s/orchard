/**
 * BUG-290 — scratch-server self-defence, so a test-harness server never outlives
 * the reason it exists.
 *
 * THE INCIDENT. 17 Orchard servers (`node <scratch>/src/server/index.ts`) booted
 * by clean-room verify suites ran for 7–8 DAYS after their launchers had exited,
 * spinning at 40–80% CPU each (~7 cores, 3.6 GB) with their cwd deleted. When a
 * verify script spawns a scratch server and is then itself killed abnormally
 * (OOM, a dispatch timeout, the agent's turn ending) its `finally{ kill }` never
 * runs, and the server is REPARENTED — on a systemd user session to the user
 * manager, NOT to pid 1 — so `ppid === 1` never detects it. Nothing signals it,
 * and it lives forever.
 *
 * THE FIX, BY CONSTRUCTION. A scratch server watches the world it was born into
 * and EXITS the instant that world is gone:
 *   - its LAUNCHER is dead (the pid that spawned it no longer exists), or
 *   - its working directory has been deleted, or
 *   - its (isolated) data dir has been deleted.
 * Any one of these means there is no longer anyone to serve and nothing to serve
 * from. Exiting is both the orphan reaper AND the cure for the busy loop — a loop
 * retrying against a vanished dir cannot spin if the process it runs in is gone.
 *
 * STRICTLY GATED — the live service is never touched. This arms ONLY when
 * `CLAUDE_STATION_TEST_HARNESS` is set (injected by `isolatedServerEnv`, the one
 * path every scratch suite boots through) AND the data dir is isolated
 * (`dataDirMode() === 'isolated'`). The production server is started by systemd
 * on the real, shared data dir and sets neither, so both arms must be true before
 * a single check runs. `isolatedServerEnv` already REFUSES to build an env on the
 * shared data dir, so a harness env can never point at it.
 *
 * Exit is DIRECT (`process.exit`), not the graceful `shutdown()` path: when the
 * cwd or data dir has vanished, closing sessions can itself hang (that is the
 * very SIGTERM-ignored failure this incident also showed). A throwaway scratch
 * server has no precious state to drain, so it leaves at once.
 */
import * as fs from 'node:fs';

export interface WatchdogOptions {
  enabled: boolean;
  /** The pid that spawned this server; when it dies, this server is an orphan. */
  launcherPid: number | null;
  /** This server's working directory (process.cwd() at boot). */
  cwd: string;
  /** This server's data dir. */
  dataDir: string;
  intervalMs?: number;
  /** Injected for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

/** True if `pid` is a live process this user can see. pid<=1 is never a launcher. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * THIS process's CURRENT parent pid, read live from /proc (not the cached
 * `process.ppid`, which Node fixes at startup). Returns null off Linux / when
 * unreadable. The key signal: on Linux a child is reparented to the subreaper
 * the INSTANT its parent exits — before that parent is reaped — so a changed
 * ppid detects a dead launcher even while the launcher lingers as a zombie
 * (BUG-290 round 2; the independent verifier's zombie-launcher finding, which
 * `kill(pid,0)` alone mis-read as "alive").
 */
export function currentPpid(): number | null {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = /^PPid:\s*(\d+)/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** A process that has TERMINATED but not yet been reaped — dead for our purposes. */
function isZombie(pid: number): boolean {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return /^State:\s*Z/m.test(status);
  } catch {
    return false;
  }
}

/**
 * Has the launcher that spawned this scratch server gone away? True if we have
 * been reparented away from it (its exit, zombie or not), or its pid no longer
 * exists, or it is a zombie. The ppid-change check is the robust Linux signal;
 * the others are belt-and-suspenders and the off-Linux fallback.
 */
export function launcherGone(launcherPid: number): boolean {
  const ppid = currentPpid();
  if (ppid !== null && ppid !== launcherPid) return true; // reparented ⇒ launcher exited
  if (!pidAlive(launcherPid)) return true;
  if (isZombie(launcherPid)) return true;
  return false;
}

/** The inode of `dir` right now, or null if it does not resolve to a directory. */
export function inodeOf(dir: string): number | null {
  try {
    const st = fs.statSync(dir);
    return st.isDirectory() ? Number(st.ino) : null;
  } catch {
    return null;
  }
}

/**
 * Round-3 (the verifier's "replaced directories" finding): a path check is not
 * enough. Deleting the cwd and RECREATING an empty dir at the same path leaves
 * `statSync(path)` succeeding while the process's REAL cwd is the original,
 * now-unlinked, inode. The kernel records this as `/proc/self/cwd` → "… (deleted)".
 * That symlink is the one authority on where this process actually sits.
 */
export function cwdDeleted(): boolean {
  try {
    return / \(deleted\)$/.test(fs.readlinkSync('/proc/self/cwd'));
  } catch {
    // Off Linux / no /proc: fall back to the caller's path+inode check.
    return false;
  }
}

/**
 * Has a directory this server depends on been deleted OR replaced by a different
 * directory at the same path? `bootIno` is the inode recorded when the server
 * started; a vanished path (null now) or a changed inode both mean gone. This is
 * the same inode-identity test `lanes.isWriter()` uses for the data-dir lock.
 */
export function dirGoneOrReplaced(dir: string, bootIno: number | null): boolean {
  const now = inodeOf(dir);
  if (now === null) return true;             // deleted
  if (bootIno != null && now !== bootIno) return true; // replaced at the same path
  return false;
}

/**
 * The single predicate: has the world this scratch server was born into gone
 * away? Returns a human reason string, or null if the world is still intact.
 * `cwdBootIno`/`dataDirBootIno` are the inodes captured at boot so a
 * delete-then-recreate at the same path is still caught. Exported so a test can
 * grade it against a partial/real state.
 */
export function worldGoneReason(o: {
  launcherPid: number | null;
  cwd: string;
  dataDir: string;
  cwdBootIno?: number | null;
  dataDirBootIno?: number | null;
}): string | null {
  if (o.launcherPid != null && launcherGone(o.launcherPid)) {
    return `its launcher (pid ${o.launcherPid}) has exited — this scratch server is orphaned`;
  }
  if (cwdDeleted() || dirGoneOrReplaced(o.cwd, o.cwdBootIno ?? null)) {
    return `its working directory (${o.cwd}) has been deleted or replaced`;
  }
  if (dirGoneOrReplaced(o.dataDir, o.dataDirBootIno ?? null)) {
    return `its data dir (${o.dataDir}) has been deleted or replaced`;
  }
  return null;
}

/**
 * Start the self-defence watchdog. Returns the interval handle (for tests to
 * clear), or null when not armed. The handle is NOT unref'd: a scratch server
 * with no sessions is kept alive by its listening socket anyway, and we want the
 * watchdog to be the thing that decides when it stops.
 */
export function startHarnessWatchdog(o: WatchdogOptions): NodeJS.Timeout | null {
  if (!o.enabled) return null;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const log = o.log ?? ((line: string) => console.error(line));
  const intervalMs = o.intervalMs ?? 1000;
  // Capture the inodes the server was born into, so a delete-then-recreate at the
  // same path (the verifier's round-2 finding) is caught as a changed inode.
  const cwdBootIno = inodeOf(o.cwd);
  const dataDirBootIno = inodeOf(o.dataDir);
  const tick = (): void => {
    const reason = worldGoneReason({ ...o, cwdBootIno, dataDirBootIno });
    if (reason) {
      log(`[orchard] TEST-HARNESS SELF-DEFENCE — EXITING: ${reason}. ` +
        `(A scratch server reaps itself so it cannot outlive its launcher as a CPU-spinning orphan — BUG-290.)`);
      exit(0);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return timer;
}
