/**
 * FEAT-155 round 5 — a project that owns its image as a Dockerfile in its repo.
 *
 * `settings.container.dockerfile` names a file RELATIVE to the project repo.
 * Orchard builds it (context = the repo), tags the result with a hash of what it
 * was built from, rebuilds when that hash changes, and keeps the last good image
 * running when a build fails. This file owns the pure half of that:
 *
 *   - reading the Dockerfile without ever following a link out of the repo;
 *   - (no text rules: isolation is structural — see the note below and
 *     project-builder.ts);
 *   - the identity hash and the image names derived from it;
 *   - the per-project build record (state, error, log tail, last good image),
 *     persisted so a failure and the last good image survive a restart.
 *
 * The docker half (build, smoke-test, promote, run-time lockdown, swap) lives in
 * container-manager.ts beside the rest of the container lifecycle.
 *
 * THREAT MODEL. The session inside the container can edit any repo file,
 * including this Dockerfile — that is the point of the feature (the project's
 * own session changes its image). So everything here treats the Dockerfile's
 * bytes, its path, and the build's output as attacker-controlled. The security
 * invariant is: the Dockerfile controls image CONTENTS only. What the running
 * container may do (user, capabilities, mounts, GPU, memory, network, entry
 * command) is decided by Orchard's `docker create` arguments, never the image.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, ensureDir } from '../lib/paths.ts';

/** Largest Dockerfile Orchard will read. A real one is a few KiB. */
export const DOCKERFILE_MAX_BYTES = 1024 * 1024;
/** How much build output is kept per project (tail). */
export const BUILD_LOG_MAX_BYTES = 256 * 1024;

/* ------------------------------------------------------ write-time shape */

/**
 * Shape check for the setting itself, applied when it is saved. Null = ok.
 * Relative, inside the repo by construction (no `..`, not absolute), printable.
 * Containment is enforced AGAIN at read time against the real filesystem —
 * this only rejects values that could never be right.
 */
export function dockerfileSettingError(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return 'container.dockerfile must be a string (a path relative to the project repo) or null';
  if (!v.trim()) return 'container.dockerfile must not be empty (use null to clear it)';
  if (Buffer.byteLength(v) > 256) return 'container.dockerfile is longer than 256 bytes';
  if (/[\0\n\r\\]/.test(v)) return 'container.dockerfile must not contain NUL, newlines or backslashes';
  if (v.startsWith('/') || v.startsWith('~')) return 'container.dockerfile must be relative to the project repo, not an absolute path';
  const parts = v.split('/');
  if (parts.some((p) => p === '..')) return 'container.dockerfile must not contain ".." — it has to stay inside the project repo';
  return null;
}

/** The canonical stored form: trimmed, `./` and duplicate slashes removed. */
export function normaliseDockerfileSetting(v: string): string {
  return v.trim().split('/').filter((p) => p !== '' && p !== '.').join('/');
}

/* ------------------------------------------------------------- reading */

export type DockerfileRead =
  | { ok: true; bytes: Buffer; text: string; rel: string }
  | { ok: false; error: string };

/**
 * Read the project's Dockerfile, refusing anything that is not a regular file
 * physically inside the repo.
 *
 * Three layers, because the file is attacker-controlled and the reader is the
 * host user:
 *  1. lstat every component from the repo root down and refuse ANY symlink —
 *     before `open`, so a link cannot make the host user open a device, a FIFO
 *     or a hung network path somewhere else;
 *  2. `open` with O_NOFOLLOW|O_NONBLOCK (a last-component swap to a link fails;
 *     a FIFO cannot block the server) and fstat the fd: regular file, size cap;
 *  3. ask the KERNEL where the fd actually is (`readlink /proc/self/fd/N`) and
 *     require it to be under the repo's real path — this decides, whatever
 *     raced between (1) and (2).
 * The bytes returned are read from that same fd, and they are exactly what is
 * hashed AND what is handed to `docker build -f -` — what is built is what was
 * checked.
 */
export function readProjectDockerfile(repoPath: string, relSetting: string): DockerfileRead {
  const shapeErr = dockerfileSettingError(relSetting);
  if (shapeErr) return { ok: false, error: shapeErr };
  const rel = normaliseDockerfileSetting(relSetting);
  if (!rel) return { ok: false, error: 'container.dockerfile names the repo root, not a file' };
  let repoReal: string;
  try {
    repoReal = fs.realpathSync(repoPath);
  } catch (e) {
    return { ok: false, error: `project directory is not readable: ${(e as Error).message}` };
  }
  const parts = rel.split('/');
  let cur = repoReal;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return { ok: false, error: `Dockerfile ${rel} does not exist in the project repo` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, error: `Dockerfile path ${rel} goes through a symlink (${parts.slice(0, i + 1).join('/')}); Orchard only reads a Dockerfile that is physically inside the repo` };
    }
    if (i < parts.length - 1 && !st.isDirectory()) return { ok: false, error: `Dockerfile path ${rel}: ${parts.slice(0, i + 1).join('/')} is not a directory` };
    if (i === parts.length - 1 && !st.isFile()) return { ok: false, error: `Dockerfile ${rel} is not a regular file` };
  }
  let fd: number;
  try {
    fd = fs.openSync(cur, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    return { ok: false, error: `cannot open Dockerfile ${rel}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: `Dockerfile ${rel} is not a regular file` };
    if (st.size > DOCKERFILE_MAX_BYTES) return { ok: false, error: `Dockerfile ${rel} is larger than ${DOCKERFILE_MAX_BYTES} bytes` };
    let where: string;
    try {
      where = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch (e) {
      return { ok: false, error: `cannot verify where Dockerfile ${rel} is: ${(e as Error).message}` };
    }
    if (where.endsWith(' (deleted)') || !where.startsWith(`${repoReal}${path.sep}`)) {
      return { ok: false, error: `Dockerfile ${rel} resolved outside the project repo; refusing to read it` };
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const bytes = buf.subarray(0, off);
    return { ok: true, bytes, text: bytes.toString('utf8'), rel };
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------- no text rules */
/*
 * ARCH-020 (decision A): there is deliberately NO Dockerfile linter any more.
 * FEAT-155 rounds 2–13 enforced cross-project isolation with rules over the
 * Dockerfile text (a canonicaliser, a flag allow-list, an image-reference ban,
 * ONBUILD/ADD/heredoc/# syntax refusals, a per-project cache-scope step after
 * every FROM) because every project built on the host's one shared BuildKit.
 * Eight clean-room rounds each broke one of those rules. Each project now builds
 * on its own rootless BuildKit (project-builder.ts), which has no host image
 * store and no other project's cache to read — so the isolation holds for ANY
 * Dockerfile text, and the exact bytes on disk are what is hashed and built.
 * What the running container may do is still decided only by Orchard's create
 * arguments (the run-time lockdown), and a built image is still validated
 * (reserved ENV, smoke run) before it is promoted.
 */

/* ------------------------------------------------------------ identity */

/**
 * The REBUILD KEY of a project image: the Dockerfile's exact bytes plus every
 * build input Orchard supplies (the base image — by id, so a rebuilt base with
 * the same tag still changes it — the host uid/gid, the repo identity, the
 * builder image, and the owning data dir). Length-prefixed, so no two input tuples collide. A rebuild
 * key, not a reproducibility claim: files the Dockerfile COPYs, registry images
 * and package downloads can change the result under the same key (Rebuild
 * covers those).
 */
export function dockerfileHash(bytes: Buffer, inputs: { baseTag: string; baseId: string; uid: number; gid: number; repoKey?: string; builder?: string; owner?: string }): string {
  const h = crypto.createHash('sha256');
  const field = (b: Buffer | string) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8'); h.update(`${buf.length}:`); h.update(buf); };
  field('orchard-df-v2');
  field(bytes);
  // `owner` (the data dir's owner key): two Orchards on one daemon that register the same project id on the
  // same repo must never compute the same tag — else one runs the image the OTHER's builder produced.
  for (const v of [inputs.baseTag, inputs.baseId, String(inputs.uid), String(inputs.gid), inputs.repoKey ?? '', inputs.builder ?? '', inputs.owner ?? '']) field(v);
  return h.digest('hex').slice(0, 12);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Docker repository for a project's Dockerfile images. One-to-one with the
 * project id: a registry slug is used as-is; anything else (a hand-edited id)
 * gets a hash suffix so two ids can never share a repository.
 */
export function projectImageRepo(projectId: string): string {
  if (SLUG_RE.test(projectId) && projectId.length <= 120) return `claude-station-project-${projectId}`;
  const safe = projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'p';
  const sum = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  return `claude-station-project-${safe}-${sum}`;
}

export const DF_TAG_RE = /^df-[0-9a-f]{12}$/;
export const CAND_TAG_RE = /^cand-[0-9a-f]{12}(?:-[0-9a-f]{8})?$/;
export const LABEL_DF_PROJECT = 'claude-station.dockerfile-project';
export const LABEL_DF_HASH = 'claude-station.dockerfile-hash';
export const LABEL_DF_REPO = 'claude-station.dockerfile-repo';
/** ARCH-020: the data dir (project-builder `dataKey`) whose Orchard built the image. */
export const LABEL_DF_DATA = 'claude-station.dockerfile-data';

/** Identity of a project repo on this machine: its real path, hashed. */
export function repoIdentity(repoReal: string): string {
  return crypto.createHash('sha256').update(`orchard-repo\0${repoReal}`).digest('hex').slice(0, 16);
}

/** Forget a record entirely (a different repo now owns this project id). */
export function resetBuildRecord(projectId: string, repoKey: string): BuildRecord {
  // In place, so a reference a reader took a moment earlier (e.g. to read the
  // log) cannot still hand out the previous repo's log.
  const cur = buildRecord(projectId);
  Object.assign(cur, emptyRecord(), { repoKey });
  return updateBuildRecord(projectId, { repoKey });
}

/* --------------------------------------------------------- build record */

export interface BuildRecord {
  /** Hash of the last build ATTEMPT. */
  hash: string | null;
  image: string | null;
  state: 'idle' | 'building' | 'succeeded' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Sanitised tail of the last build's output. */
  log: string;
  /** Hash whose build failed; not re-attempted automatically until the Dockerfile changes or the user presses Rebuild. */
  failedHash: string | null;
  /** The newest Dockerfile image a container actually ran on successfully. */
  lastGoodImage: string | null;
  /**
   * Which REPO this record describes (`repoIdentity`). A project id is reused
   * when a project is deleted and re-created with the same name, possibly on a
   * different repo; a record (and the images it names) for another repo must
   * never be adopted — container-manager resets a record whose key differs.
   */
  repoKey: string | null;
  /**
   * A random token reset together with the record. A build captures it when it
   * starts and promotes only if it is unchanged, so a build that finishes after
   * the project was deleted or re-pointed at another repo is discarded.
   */
  generation: string | null;
}

function emptyRecord(): BuildRecord {
  return { hash: null, image: null, state: 'idle', startedAt: null, finishedAt: null, error: null, log: '', failedHash: null, lastGoodImage: null, repoKey: null, generation: crypto.randomBytes(8).toString('hex') };
}

function recordDir(): string {
  return path.join(dataDir(), 'container-builds');
}

function recordFile(projectId: string): string {
  return path.join(recordDir(), `${crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 24)}.json`);
}

const records = new Map<string, BuildRecord>();

export function buildRecord(projectId: string): BuildRecord {
  const mem = records.get(projectId);
  if (mem) return mem;
  let r = emptyRecord();
  try {
    const j = JSON.parse(fs.readFileSync(recordFile(projectId), 'utf8')) as Partial<BuildRecord> & { projectId?: string };
    if (j && j.projectId === projectId) {
      r = { ...r, ...j } as BuildRecord;
      // A build cannot still be running after a restart.
      if (r.state === 'building') { r.state = 'failed'; r.error = r.error ?? 'the server restarted while this build was running'; r.failedHash = null; }
    }
  } catch { /* none yet */ }
  records.set(projectId, r);
  return r;
}

export function updateBuildRecord(projectId: string, patch: Partial<BuildRecord>, persist = true): BuildRecord {
  const r = { ...buildRecord(projectId), ...patch };
  if (r.log.length > BUILD_LOG_MAX_BYTES) r.log = r.log.slice(-BUILD_LOG_MAX_BYTES);
  records.set(projectId, r);
  if (persist) {
    try {
      ensureDir(recordDir());
      const f = recordFile(projectId);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ projectId, ...r }));
      fs.renameSync(`${f}.tmp`, f);
    } catch { /* the in-memory record still serves the API */ }
  }
  return r;
}

/** Append build output (sanitised) to the in-memory record; persisted at the end of the build. */
export function appendBuildLog(projectId: string, chunk: string): void {
  const r = buildRecord(projectId);
  r.log = (r.log + sanitiseBuildLog(chunk)).slice(-BUILD_LOG_MAX_BYTES);
}

/**
 * Build output is attacker-controlled text shown in the UI. Strip ANSI/OSC
 * escape sequences and every control character except newline and tab, so it
 * can only ever be inert text (the UI also renders it with textContent).
 */
export function sanitiseBuildLog(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Forget a project's build record entirely (the project was deleted). */
export function forgetBuildRecord(projectId: string): void {
  records.delete(projectId);
  try { fs.rmSync(recordFile(projectId), { force: true }); } catch { /* */ }
}

/** Test seam: forget in-memory records (the persisted files stay). */
export function _resetBuildRecordsForTest(): void {
  records.clear();
}
