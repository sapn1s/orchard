/**
 * Per-session project snapshots, built on btrfs reflink copies.
 *
 * WHY THIS EXISTS
 * ---------------
 * A containerised session bind-mounts the user's REAL project directory. The
 * container isolates *other* projects; it is not an undo for the one it is
 * working on. A bad `rm -rf` inside the container destroys real host files.
 * snapper's hourly timeline covers `/home`, but "hourly" is the wrong
 * granularity for "put this project back exactly as it was when the session
 * started". This module provides that granularity.
 *
 * MECHANISM
 * ---------
 * `cp --reflink=always -a`. On btrfs this shares extents copy-on-write: the
 * snapshot is near-instant and consumes ~0 additional bytes until the original
 * and the copy diverge. It is, however, **O(number of files)** rather than
 * O(bytes) — every file needs its own inode and its own clone ioctl. A 100k-file
 * `node_modules` therefore costs real seconds even though it costs no space,
 * which is exactly why the default exclusions exist (see DEFAULT_EXCLUDE).
 *
 * NO SILENT FALLBACK. If reflink is unavailable — the project and the snapshot
 * store are on different filesystems, or the filesystem has no clone support —
 * `create()` throws. It never degrades to a full byte copy, which would quietly
 * consume tens of gigabytes for what the user asked to be a cheap operation.
 * There is deliberately no opt-in full-copy mode either: a "snapshot" that can
 * fill the disk is a different feature and should be named like one.
 *
 * LAYOUT
 * ------
 *   <dataDir>/snapshots/<projectId>/<snapshotId>/meta.json
 *   <dataDir>/snapshots/<projectId>/<snapshotId>/tree/...
 *
 * Deliberately OUTSIDE the project: a store inside the project would be
 * captured by its own next snapshot (quadratic growth) and would pollute git.
 * `assertStoreOutsideProject` enforces it rather than assuming it — a user who
 * registers `~` as a project would otherwise hit exactly that.
 *
 * A snapshot is published by `rename()`ing a fully-built staging directory into
 * place, so a crashed or failed create can never leave a half-tree that `list()`
 * would report as a restorable snapshot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { dataDir, ensureDir, isInside, writeAtomic } from '../lib/paths.ts';
import type { Project } from './registry.ts';
import { snapshotSettingsOf } from './registry.ts';

/* ----------------------------------------------------------------- errors */

export type SnapshotErrorCode =
  | 'no-project-dir'
  | 'store-inside-project'
  | 'cross-filesystem'
  | 'reflink-unsupported'
  | 'copy-failed'
  | 'no-snapshot'
  | 'pre-restore-failed'
  | 'restore-failed'
  | 'restore-rolled-back'
  | 'stage-failed';

/** Carries a machine-readable code so the HTTP layer can pick a status. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  /** Raw tool output (cp's stderr, etc). Reported verbatim — never summarised away. */
  readonly detail: string | null;
  constructor(code: SnapshotErrorCode, message: string, detail?: string | null) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/* --------------------------------------------------------------- metadata */

export type SnapshotReason = 'session-start' | 'manual' | 'pre-restore';

export interface SnapshotMeta {
  id: string;
  projectId: string;
  /** Station session id this snapshot was taken for (`session-start` only). */
  sessionId: string | null;
  /** The real SDK session id, attached once the session reports it. */
  sdkSessionId: string | null;
  createdAt: string;
  reason: SnapshotReason;
  label: string | null;
  /** Files + symlinks captured (directories not counted). */
  fileCount: number;
  dirCount: number;
  /** Apparent size, i.e. the sum of file sizes. NOT the disk cost — extents are shared. */
  sizeBytes: number;
  durationMs: number;
  /** Directory names excluded from this snapshot. */
  exclusions: string[];
  /** Relative paths of directories actually skipped because of `exclusions`. */
  excludedFound: string[];
  /** Content fingerprint (relpath+size+mtime) used to skip identical re-snapshots. */
  fingerprint: string;
  /** The project path as it was when captured. */
  hostPath: string;
  /** How many `cp` invocations the copy needed — the exclusion machinery's cost. */
  cpInvocations: number;
  /** Schema version, so a future change can migrate rather than misread. */
  v: 1;
}

/** What the API returns per snapshot. Superset of the contract the UI codes against. */
export interface SnapshotSummary {
  id: string;
  sessionId: string | null;
  sdkSessionId: string | null;
  createdAt: string;
  reason: SnapshotReason;
  label: string | null;
  fileCount: number;
  sizeBytes: number;
  durationMs: number;
  exclusions: string[];
  excludedFound: string[];
}

export function toSummary(m: SnapshotMeta): SnapshotSummary {
  return {
    id: m.id,
    sessionId: m.sessionId,
    sdkSessionId: m.sdkSessionId,
    createdAt: m.createdAt,
    reason: m.reason,
    label: m.label,
    fileCount: m.fileCount,
    sizeBytes: m.sizeBytes,
    durationMs: m.durationMs,
    exclusions: m.exclusions,
    excludedFound: m.excludedFound,
  };
}

/* ------------------------------------------------------------------ paths */

export function snapshotsRoot(): string {
  return path.join(dataDir(), 'snapshots');
}

export function projectSnapshotDir(projectId: string): string {
  return path.join(snapshotsRoot(), projectId);
}

export function snapshotDir(projectId: string, snapshotId: string): string {
  return path.join(projectSnapshotDir(projectId), snapshotId);
}

/** `<snapshot>/tree` — the reflink copy itself. */
export function snapshotTree(projectId: string, snapshotId: string): string {
  return path.join(snapshotDir(projectId, snapshotId), 'tree');
}

function metaFile(projectId: string, snapshotId: string): string {
  return path.join(snapshotDir(projectId, snapshotId), 'meta.json');
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------- filesystem facts */

/**
 * Filesystem type for a path, read from /proc/self/mountinfo.
 *
 * Used only to make an error message actionable ("tmpfs has no clone support"
 * beats "Operation not supported"). Never used to decide whether to proceed —
 * `cp --reflink=always` is the authority on that, and it is the thing that runs.
 */
export function fsTypeOf(target: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    resolved = path.resolve(target);
  }
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
  let best: { point: string; type: string } | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const pre = line.slice(0, sep).split(' ');
    const post = line.slice(sep + 3).split(' ');
    const point = pre[4];
    const type = post[0];
    if (!point || !type) continue;
    if (!isInside(point, resolved)) continue;
    if (!best || point.length > best.point.length) best = { point, type };
  }
  return best?.type ?? null;
}

/**
 * FEAT-131 — creation-time reflink capability probe for `projectHostPath`.
 *
 * Answers ONE question a container-default new project needs answered before it
 * is created: can this project's directory actually be reflink-snapshotted into
 * the snapshot store? It runs the REAL operation that `create()` would — a
 * `cp --reflink=always` from a throwaway file inside the project onto the store
 * — so it catches BOTH a non-reflink filesystem AND a store that lives on a
 * different device from the project (the two ways snapshotting is impossible
 * here). No silent full copy: `--reflink=always` refuses rather than degrading.
 *
 * Non-destructive: the probe source and destination are throwaway temp entries,
 * removed in `finally` whether the copy succeeds or fails. Used by
 * `registry.createProject` to fall a container default safely back to `direct`;
 * NOT used by `create()`, which stays fail-loud on the real snapshot.
 */
export function reflinkProbe(projectHostPath: string): { ok: boolean; message: string } {
  const store = snapshotsRoot();
  const tag = crypto.randomBytes(6).toString('hex');
  const srcFile = path.join(projectHostPath, `.orchard-reflink-probe-${tag}`);
  const destDir = path.join(store, `.probe-${tag}`);
  try {
    ensureDir(store);
    fs.writeFileSync(srcFile, 'orchard reflink probe');
    ensureDir(destDir);
    const r = spawnSync('cp', ['--reflink=always', '-a', '--', srcFile, `${destDir}/`], {
      encoding: 'utf8', timeout: 15_000,
    });
    if (r.status === 0) {
      return {
        ok: true,
        message: `reflink OK (project ${fsTypeOf(projectHostPath) ?? '?'} -> store ${fsTypeOf(store) ?? '?'})`,
      };
    }
    const why = (r.stderr || r.stdout || '').trim().slice(0, 300);
    return { ok: false, message: `reflink unavailable: ${why || `cp --reflink=always exited ${r.status ?? r.signal}`}` };
  } catch (e) {
    return { ok: false, message: `reflink probe error: ${(e as Error).message}` };
  } finally {
    try { fs.rmSync(srcFile, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Preflight the one failure mode that is certain in advance: a reflink cannot
 * cross filesystems, so if the project and the snapshot store sit on different
 * devices there is nothing to try. Everything else is left to `cp` itself.
 */
function assertSameFilesystem(src: string, destParent: string): void {
  const a = fs.statSync(src);
  const b = fs.statSync(destParent);
  if (a.dev === b.dev) return;
  throw new SnapshotError(
    'cross-filesystem',
    `cannot snapshot ${src} into ${destParent}: they are on DIFFERENT filesystems ` +
      `(device ${a.dev} [${fsTypeOf(src) ?? 'unknown'}] vs device ${b.dev} [${fsTypeOf(destParent) ?? 'unknown'}]). ` +
      `Reflink copies share extents and cannot cross a filesystem boundary. ` +
      `No copy was made — falling back to a full byte copy would silently consume the project's full size on disk. ` +
      `Fix by pointing CLAUDE_STATION_DATA at a directory on the same btrfs filesystem as the project.`,
  );
}

/**
 * Walk up until something exists. Lets the same-filesystem preflight run before
 * any directory is created, so a refusal leaves the disk exactly as it found it.
 */
function nearestExisting(target: string): string {
  let cur = path.resolve(target);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/** The store must not live inside the project, or it snapshots itself. */
function assertStoreOutsideProject(hostPath: string): void {
  const root = snapshotsRoot();
  if (!isInside(hostPath, root)) return;
  throw new SnapshotError(
    'store-inside-project',
    `the snapshot store (${root}) is INSIDE the project directory (${hostPath}). ` +
      `Each snapshot would then be captured by the next one, growing quadratically, and would show up in git. ` +
      `Move the data dir with CLAUDE_STATION_DATA, or do not register a parent of the data dir as a project.`,
  );
}

/* -------------------------------------------------------------- the walk */

const MAX_CP_ARGS = 1000;

interface Plan {
  fileCount: number;
  dirCount: number;
  sizeBytes: number;
  excludedFound: string[];
  /**
   * Relative dirs that must be created by hand during the copy because they
   * contain (transitively) an excluded directory. Everything else is bulk-copied
   * by a single `cp -a` of the whole subtree, which is what keeps the fork count
   * proportional to the number of exclusions rather than to the tree size.
   */
  prefixDirs: Set<string>;
  fingerprint: string;
}

/**
 * Walk the tree that WILL be copied, without descending into excluded dirs.
 *
 * Produces three things in one pass: the copy plan, the counts reported in
 * metadata, and the content fingerprint used to skip an identical re-snapshot.
 * Entries are sorted so the fingerprint does not depend on readdir order.
 */
function planCopy(src: string, exclude: Set<string>): Plan {
  const plan: Plan = {
    fileCount: 0,
    dirCount: 0,
    sizeBytes: 0,
    excludedFound: [],
    prefixDirs: new Set<string>(),
    fingerprint: '',
  };
  const hash = crypto.createHash('sha1');

  const markPrefix = (rel: string): void => {
    let cur = rel;
    for (;;) {
      plan.prefixDirs.add(cur);
      if (cur === '') break;
      const parent = path.dirname(cur);
      cur = parent === '.' ? '' : parent;
    }
  };

  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === '' ? src : path.join(src, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished or is unreadable mid-walk is reported, not
      // silently skipped: a snapshot missing a subtree without saying so is the
      // exact "quietly incomplete backup" failure this module exists to avoid.
      throw new SnapshotError('copy-failed', `cannot read ${abs}: ${(err as Error).message}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      // Exclusions apply to REAL directories only. A symlink named
      // `node_modules` costs one inode, so excluding it would buy nothing and
      // would lose information.
      if (e.isDirectory() && exclude.has(e.name)) {
        plan.excludedFound.push(childRel);
        markPrefix(rel);
        continue;
      }
      if (e.isDirectory()) {
        plan.dirCount++;
        hash.update(`d\0${childRel}\n`);
        stack.push(childRel);
        continue;
      }
      plan.fileCount++;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(abs, e.name));
      } catch {
        // Raced away between readdir and lstat. Counted, size unknown.
        hash.update(`?\0${childRel}\n`);
        continue;
      }
      plan.sizeBytes += st.size;
      hash.update(`f\0${childRel}\0${st.size}\0${st.mtimeMs}\n`);
    }
  }
  plan.fingerprint = hash.digest('hex');
  return plan;
}

/** Run one `cp --reflink=always -a`, turning a failure into a typed error. */
function cpReflink(sources: string[], destDir: string): void {
  if (!sources.length) return;
  const r = spawnSync('cp', ['--reflink=always', '-a', '--', ...sources, `${destDir}/`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    throw new SnapshotError('copy-failed', `could not run cp: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? '').trim();
    // "failed to clone" is coreutils' wording when --reflink=always cannot be
    // honoured. Distinguish it from an ordinary IO failure so the UI can say
    // "this filesystem can't do this" rather than "something went wrong".
    const isClone = /failed to clone|Operation not supported|Invalid cross-device link/i.test(stderr);
    if (isClone) {
      throw new SnapshotError(
        'reflink-unsupported',
        `reflink copy refused by the filesystem. Source filesystem is ` +
          `"${fsTypeOf(sources[0] ?? destDir) ?? 'unknown'}", destination is "${fsTypeOf(destDir) ?? 'unknown'}". ` +
          `Reflink (copy-on-write extent sharing) needs btrfs or XFS with reflink=1, and both sides on the SAME filesystem. ` +
          `NOTHING was copied and no byte-for-byte fallback was attempted — a silent full copy would consume the project's ` +
          `entire size on disk instead of ~0.`,
        stderr,
      );
    }
    throw new SnapshotError('copy-failed', `cp failed with exit ${r.status}`, stderr);
  }
}

/** Recreate a directory with the source's mode and timestamps. */
function mirrorDir(srcDir: string, destDir: string): void {
  const st = fs.statSync(srcDir);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.chmodSync(destDir, st.mode & 0o7777);
    fs.utimesSync(destDir, st.atime, st.mtime);
  } catch {
    // Best effort: a mode/timestamp we cannot set is not worth failing a
    // snapshot over, and the contents (the point of the exercise) are intact.
  }
}

/**
 * Copy `src` -> `dest`, honouring the exclusions, using as few `cp` forks as
 * possible.
 *
 * Only directories on the path to an excluded directory are created by hand and
 * descended into; every other child is handed to `cp -a` whole. So a project
 * with a single top-level `node_modules` costs ONE cp, not one per directory.
 */
function runCopy(src: string, dest: string, plan: Plan, exclude: Set<string>): number {
  let invocations = 0;
  const walk = (rel: string): void => {
    const absSrc = rel === '' ? src : path.join(src, rel);
    const absDest = rel === '' ? dest : path.join(dest, rel);
    mirrorDir(absSrc, absDest);
    const entries = fs.readdirSync(absSrc, { withFileTypes: true });
    const batch: string[] = [];
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory() && exclude.has(e.name)) continue;
      if (e.isDirectory() && plan.prefixDirs.has(childRel)) {
        walk(childRel);
        continue;
      }
      batch.push(path.join(absSrc, e.name));
    }
    for (let i = 0; i < batch.length; i += MAX_CP_ARGS) {
      cpReflink(batch.slice(i, i + MAX_CP_ARGS), absDest);
      invocations++;
    }
    // Re-apply times: copying children into a directory bumps its mtime.
    try {
      const st = fs.statSync(absSrc);
      fs.utimesSync(absDest, st.atime, st.mtime);
    } catch {
      /* best effort, see mirrorDir */
    }
  };
  walk('');
  return invocations;
}

/* ----------------------------------------------------------------- create */

export interface CreateOptions {
  reason: SnapshotReason;
  /** Station session id, for `session-start`. */
  sessionId?: string | null;
  label?: string | null;
  /** Override the project's configured exclusions (used by verification). */
  exclude?: string[];
  /**
   * Skip the copy and return the newest snapshot when the tree is byte-identical
   * to it. Default true; `pre-restore` sets it false so the undo point is always
   * an unambiguous, explicitly-created entry.
   */
  dedupe?: boolean;
  /** Prune to this many after creating. Defaults to the project's `keep`. */
  keep?: number;
  /**
   * Snapshot ids the post-create prune must NEVER remove, even if they fall
   * outside `keep`. Used by `restore()` so the pre-restore snapshot can never
   * evict the very snapshot being restored (see the prune below and BUG-007).
   */
  protect?: readonly string[];
}

export interface CreateResult {
  meta: SnapshotMeta;
  /** True when no copy happened because an identical snapshot already existed. */
  deduped: boolean;
  /** Snapshot ids removed by the post-create prune. */
  pruned: string[];
}

export function create(project: Project, opts: CreateOptions): CreateResult {
  const t0 = Date.now();
  const hostPath = project.hostPath;
  let st: fs.Stats;
  try {
    st = fs.statSync(hostPath);
  } catch (err) {
    throw new SnapshotError('no-project-dir', `project path ${hostPath} is not readable: ${(err as Error).message}`);
  }
  if (!st.isDirectory()) throw new SnapshotError('no-project-dir', `project path ${hostPath} is not a directory`);

  assertStoreOutsideProject(hostPath);

  const cfg = snapshotSettingsOf(project);
  const exclusions = (opts.exclude ?? cfg.exclude).slice();
  const exclude = new Set(exclusions);
  const keep = opts.keep ?? cfg.keep;

  const projDir = projectSnapshotDir(project.id);
  // Checked against the nearest EXISTING ancestor, BEFORE creating anything: a
  // refusal must not leave a directory tree behind in a store it just declared
  // unusable. (Observed: it used to mkdir -p the store and then throw.)
  assertSameFilesystem(hostPath, nearestExisting(projDir));
  ensureDir(projDir);

  const plan = planCopy(hostPath, exclude);

  // Identical-state dedupe. Compared against the NEWEST snapshot only: that is
  // what "was one just taken" means, and it keeps the check O(1).
  if (opts.dedupe !== false) {
    const newest = list(project.id)[0];
    if (newest && newest.fingerprint === plan.fingerprint && newest.hostPath === hostPath) {
      return { meta: newest, deduped: true, pruned: [] };
    }
  }

  const now = new Date();
  const id = newId(now);
  const staging = path.join(projDir, `.staging-${id}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  let meta: SnapshotMeta;
  try {
    const invocations = runCopy(hostPath, path.join(staging, 'tree'), plan, exclude);
    meta = {
      id,
      projectId: project.id,
      sessionId: opts.sessionId ?? null,
      sdkSessionId: null,
      createdAt: now.toISOString(),
      reason: opts.reason,
      label: opts.label ?? null,
      fileCount: plan.fileCount,
      dirCount: plan.dirCount,
      sizeBytes: plan.sizeBytes,
      durationMs: Date.now() - t0,
      exclusions,
      excludedFound: plan.excludedFound,
      fingerprint: plan.fingerprint,
      hostPath,
      cpInvocations: invocations,
      v: 1,
    };
    // Written INSIDE staging, so the rename below publishes tree + meta together.
    // `list()` ignores anything without a meta.json, which makes a crashed create
    // invisible rather than restorable-and-wrong.
    writeAtomic(path.join(staging, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  fs.renameSync(staging, snapshotDir(project.id, id));
  const pruned = prune(project.id, keep, opts.protect);
  return { meta, deduped: false, pruned };
}

/* -------------------------------------------------------- read / list / rm */

function readMeta(projectId: string, snapshotId: string): SnapshotMeta | null {
  try {
    const raw = fs.readFileSync(metaFile(projectId, snapshotId), 'utf8');
    const m = JSON.parse(raw) as SnapshotMeta;
    if (!m || typeof m.id !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

/** Newest first. Entries without a readable meta.json are incomplete and skipped. */
export function list(projectId: string): SnapshotMeta[] {
  const dir = projectSnapshotDir(projectId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SnapshotMeta[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue; // staging / restore leftovers
    const m = readMeta(projectId, n);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function get(projectId: string, snapshotId: string): SnapshotMeta | null {
  if (!isSafeId(snapshotId)) return null;
  return readMeta(projectId, snapshotId);
}

/** Snapshot ids are generated here; anything else is a path-traversal attempt. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..' && !id.startsWith('.');
}

export function remove(projectId: string, snapshotId: string): boolean {
  if (!isSafeId(snapshotId)) throw new SnapshotError('no-snapshot', `invalid snapshot id ${JSON.stringify(snapshotId)}`);
  const dir = snapshotDir(projectId, snapshotId);
  // Belt and braces: the id regex already forbids traversal, but a delete of a
  // path outside the store is unrecoverable, so it is checked again.
  if (!isInside(snapshotsRoot(), dir)) {
    throw new SnapshotError('no-snapshot', `refusing to delete ${dir}: outside the snapshot store`);
  }
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Keep the `keep` newest snapshots; delete the rest. Returns the ids removed.
 *
 * `protect` names ids that must survive even if they fall outside `keep`. This
 * is what stops a `pre-restore` create() from evicting the snapshot being
 * restored: the list is newest-first, so the restore TARGET is the oldest and
 * would otherwise be the first thing pruned once the store is at its limit —
 * the restore would then read a tree that no longer exists (BUG-007).
 */
export function prune(projectId: string, keep: number, protect: readonly string[] = []): string[] {
  const k = Math.max(1, Math.floor(keep));
  const keepIds = new Set(protect);
  const all = list(projectId);
  const doomed = all.slice(k).filter((m) => !keepIds.has(m.id));
  const removed: string[] = [];
  for (const m of doomed) {
    try {
      if (remove(projectId, m.id)) removed.push(m.id);
    } catch {
      /* a snapshot we cannot delete is not worth failing the create over */
    }
  }
  return removed;
}

/**
 * Attach the real SDK session id once the session reports it.
 *
 * The snapshot is taken BEFORE the SDK spawns, so at creation time only the
 * station-side id exists. The UI wants to say "restore to the start of <sdk
 * session>", which needs this back-fill.
 */
export function attachSdkSessionId(projectId: string, snapshotId: string, sdkSessionId: string): boolean {
  const m = get(projectId, snapshotId);
  if (!m) return false;
  if (m.sdkSessionId === sdkSessionId) return true;
  m.sdkSessionId = sdkSessionId;
  try {
    writeAtomic(metaFile(projectId, snapshotId), `${JSON.stringify(m, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Total apparent size and count across a project's snapshots, for the UI header. */
export function usage(projectId: string): { count: number; apparentBytes: number; newestAt: string | null } {
  const all = list(projectId);
  return {
    count: all.length,
    apparentBytes: all.reduce((n, m) => n + m.sizeBytes, 0),
    newestAt: all[0]?.createdAt ?? null,
  };
}

/* ---------------------------------------------------------------- restore */

export interface RestoreReport {
  projectId: string;
  snapshotId: string;
  hostPath: string;
  /** The undo-the-undo point. Always created before anything is touched. */
  preRestoreSnapshotId: string;
  /** Top-level entries written from the snapshot. */
  restored: string[];
  /**
   * Top-level entries that existed in the project but are NOT in the snapshot,
   * and were therefore removed. Recoverable from `preRestoreSnapshotId`.
   */
  removed: string[];
  /**
   * Excluded directories found in the project and left EXACTLY as they were.
   * The snapshot never contained them, so restore can neither bring them back
   * nor is it entitled to delete them.
   */
  preservedExcluded: string[];
  exclusions: string[];
  snapshotCreatedAt: string;
  durationMs: number;
  forced: boolean;
}

/**
 * Restore a snapshot over the project's working directory.
 *
 * WHAT "ATOMIC-ISH" MEANS HERE, EXACTLY
 * -------------------------------------
 * This is NOT one atomic syscall, and it is not claimed to be. It is a
 * stage-then-swap with rollback:
 *
 *   1. A `pre-restore` snapshot of the CURRENT state is taken first. If that
 *      fails the restore ABORTS and nothing is touched.
 *   2. The snapshot tree is reflink-copied into a staging directory beside the
 *      project (same filesystem, so every later move is a rename). All the slow
 *      work happens here, while the project is still fully intact.
 *   3. Phase A: each top-level entry of the project is `rename()`d into
 *      `<staging>/old/`. Phase B: each top-level entry of `<staging>/new/` is
 *      `rename()`d into the project. Renames are O(1) regardless of subtree
 *      size, so the whole swap is milliseconds.
 *   4. If ANY rename fails, both phases are reversed in order and the original
 *      tree is put back, then the error is raised. The project is never left
 *      half-restored.
 *
 * The residual window is between phases A and B, where the project directory is
 * briefly missing entries. It is sub-second and cannot be eliminated without a
 * filesystem-level atomic directory swap, which Linux does not offer for this
 * shape. It is stated rather than papered over.
 *
 * The project DIRECTORY ITSELF is never renamed — only its contents. That is
 * deliberate: renaming it would break any container bind-mount pointing at it
 * (the mount follows the inode, so the container would keep the pre-restore
 * tree) and would strand any process whose cwd is inside.
 */
export function restore(project: Project, snapshotId: string, opts?: { forced?: boolean }): RestoreReport {
  const t0 = Date.now();
  const meta = get(project.id, snapshotId);
  if (!meta) throw new SnapshotError('no-snapshot', `no snapshot ${snapshotId} for project ${project.id}`);
  const tree = snapshotTree(project.id, snapshotId);
  if (!fs.existsSync(tree)) {
    throw new SnapshotError('no-snapshot', `snapshot ${snapshotId} has metadata but no tree at ${tree}`);
  }
  const hostPath = project.hostPath;
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    throw new SnapshotError('no-project-dir', `project path ${hostPath} is missing — refusing to restore into it`);
  }

  // 1. The undo point. `dedupe:false` so this is always an explicit entry the
  //    UI can point at, even if the state happens to match an earlier snapshot.
  let pre: CreateResult;
  try {
    pre = create(project, {
      reason: 'pre-restore',
      label: `state before restoring ${snapshotId}`,
      dedupe: false,
      // Same exclusions the target snapshot used, so the undo point covers
      // exactly the same ground as the thing it can undo.
      exclude: meta.exclusions,
      // CRITICAL: the pre-restore create() adds a snapshot and then prunes to
      // `keep`. When the store is already at its limit, the list (newest-first)
      // has the restore TARGET as its oldest entry — exactly the one prune would
      // delete. That destroys the tree this restore is about to read, turning a
      // no-op restore into silent loss of the backup it pointed at. Protecting
      // the target guarantees it survives the prune (BUG-007).
      protect: [snapshotId],
    });
  } catch (err) {
    const e = err as Error;
    throw new SnapshotError(
      'pre-restore-failed',
      `ABORTED: could not take the pre-restore snapshot, so the restore was not attempted and the project is untouched. ${e.message}`,
      err instanceof SnapshotError ? err.detail : null,
    );
  }

  const exclude = new Set(meta.exclusions);
  const staging = path.join(path.dirname(hostPath), `.claude-station-restore-${snapshotId}-${crypto.randomBytes(3).toString('hex')}`);
  const stageNew = path.join(staging, 'new');
  const stageOld = path.join(staging, 'old');

  // 2. Stage. Everything expensive happens with the project fully intact.
  try {
    fs.mkdirSync(stageNew, { recursive: true });
    fs.mkdirSync(stageOld, { recursive: true });
    const kids = fs.readdirSync(tree).map((n) => path.join(tree, n));
    for (let i = 0; i < kids.length; i += MAX_CP_ARGS) cpReflink(kids.slice(i, i + MAX_CP_ARGS), stageNew);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    const e = err as Error;
    throw new SnapshotError(
      'stage-failed',
      `restore aborted while staging (the project was NOT modified): ${e.message}`,
      err instanceof SnapshotError ? err.detail : null,
    );
  }

  const snapNames = fs.readdirSync(tree);
  const curEntries = fs.readdirSync(hostPath, { withFileTypes: true });
  const preservedExcluded: string[] = [];
  const toMoveOut: string[] = [];
  for (const e of curEntries) {
    if (e.isDirectory() && exclude.has(e.name)) preservedExcluded.push(e.name);
    else toMoveOut.push(e.name);
  }
  const snapSet = new Set(snapNames);
  const removedNames = toMoveOut.filter((n) => !snapSet.has(n));

  // 3. Swap, with 4. rollback.
  const movedOut: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const n of toMoveOut) {
      fs.renameSync(path.join(hostPath, n), path.join(stageOld, n));
      movedOut.push(n);
    }
    for (const n of snapNames) {
      fs.renameSync(path.join(stageNew, n), path.join(hostPath, n));
      movedIn.push(n);
    }
  } catch (err) {
    const e = err as Error;
    const rollbackErrors: string[] = [];
    for (const n of movedIn.reverse()) {
      try {
        fs.renameSync(path.join(hostPath, n), path.join(stageNew, n));
      } catch (r) {
        rollbackErrors.push(`${n}: ${(r as Error).message}`);
      }
    }
    for (const n of movedOut.reverse()) {
      try {
        fs.renameSync(path.join(stageOld, n), path.join(hostPath, n));
      } catch (r) {
        rollbackErrors.push(`${n}: ${(r as Error).message}`);
      }
    }
    const clean = rollbackErrors.length === 0;
    if (clean) fs.rmSync(staging, { recursive: true, force: true });
    throw new SnapshotError(
      clean ? 'restore-rolled-back' : 'restore-failed',
      clean
        ? `restore failed and was rolled back — the project is back to its pre-restore state. Cause: ${e.message}`
        : `restore FAILED and the rollback was incomplete. Original contents are preserved at ${stageOld} and the ` +
          `pre-restore snapshot ${pre.meta.id} also holds them. Cause: ${e.message}`,
      rollbackErrors.length ? rollbackErrors.join('; ') : null,
    );
  }

  // The old contents live on in the pre-restore snapshot, so the staging copy is
  // redundant and is removed. (It is a reflink copy — removing it frees nothing
  // that the snapshot is still holding.)
  fs.rmSync(staging, { recursive: true, force: true });

  return {
    projectId: project.id,
    snapshotId,
    hostPath,
    preRestoreSnapshotId: pre.meta.id,
    restored: snapNames,
    removed: removedNames,
    preservedExcluded,
    exclusions: meta.exclusions,
    snapshotCreatedAt: meta.createdAt,
    durationMs: Date.now() - t0,
    forced: opts?.forced === true,
  };
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Outcome of the automatic session-start snapshot.
 *
 * `disabled` and `failed` are SEPARATE states on purpose. Both leave the session
 * without a restore point, but they mean opposite things to a user: one is the
 * setting they chose, the other is a problem they need to see. Collapsing them
 * into a single null is what made the UI announce "the start snapshot failed"
 * for a project that simply had snapshots turned off — observed in verify:ui.
 */
export type StartSnapshotStatus = 'taken' | 'deduped' | 'disabled' | 'failed';

export interface StartSnapshotResult {
  status: StartSnapshotStatus;
  /** The snapshot to restore to, for `taken` and `deduped`. Null otherwise. */
  meta: SnapshotMeta | null;
  /** Human-readable reason, set for `failed` (and explaining the default for `disabled`). */
  reason: string | null;
  code: SnapshotErrorCode | 'unknown' | null;
}

/**
 * Take the automatic `session-start` snapshot.
 *
 * NEVER THROWS. The session is the user's goal; the snapshot is insurance. A
 * failed snapshot is reported through `onStatus`/`onError` and the session
 * proceeds — refusing to start a session because a backup failed would trade a
 * real capability for a hypothetical one.
 */
export function snapshotOnSessionStart(
  project: Project,
  sessionId: string,
  hooks: { onStatus?: (s: string) => void; onError?: (m: string) => void } = {},
): StartSnapshotResult {
  const cfg = snapshotSettingsOf(project);
  if (!cfg.enabled) {
    return {
      status: 'disabled',
      meta: null,
      code: null,
      reason:
        cfg.source === 'auto-off'
          ? `snapshots default to off for isolation "${project.isolation}" — enable them per project with settings.snapshots.enabled`
          : 'snapshots are turned off for this project',
    };
  }
  try {
    const r = create(project, { reason: 'session-start', sessionId, dedupe: true });
    hooks.onStatus?.(
      r.deduped
        ? `snapshot: project unchanged since ${r.meta.id} — reusing it instead of taking a duplicate`
        : `snapshot ${r.meta.id} taken (${r.meta.fileCount} files, ${(r.meta.sizeBytes / 1e6).toFixed(1)} MB apparent, ` +
          `${r.meta.durationMs}ms${r.meta.excludedFound.length ? `, skipped ${r.meta.excludedFound.length} excluded dir(s)` : ''})`,
    );
    return { status: r.deduped ? 'deduped' : 'taken', meta: r.meta, reason: null, code: null };
  } catch (err) {
    const e = err as Error;
    const code = err instanceof SnapshotError ? err.code : 'unknown';
    const reason = `${e.message}${err instanceof SnapshotError && err.detail ? `\n${err.detail}` : ''}`;
    hooks.onError?.(
      `session-start snapshot FAILED (${code}): ${reason}\n` +
        `The session is starting anyway — but this project has NO restore point for it.`,
    );
    return { status: 'failed', meta: null, reason, code };
  }
}
