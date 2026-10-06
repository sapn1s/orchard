/**
 * BUG-216 — which Orchard instance OWNS a Docker object. One authority.
 *
 * Every Orchard server on a host shares one Docker daemon. The orphan sweep used
 * to decide ownership by "labelled claude-station=1 and its project is not in MY
 * registry" — an inference the sweeper made about objects another server created.
 * A scratch server with an empty registry therefore concluded that every live
 * project's container was an orphan, and force-removed 44 of them (see BUG-216).
 *
 * Per ARCH-010 the creator declares ownership and nobody else works it out: every
 * container, network and volume Orchard creates carries `LABEL_OWNER=<ownerKey()>`,
 * and a sweep touches only objects whose label equals ITS OWN key. An object with
 * no owner label (created before this label existed) is never swept automatically;
 * it is reported so a person can decide.
 *
 * ARCH-022 — THE OWNER KEY IS DECLARED BY THE DATA DIR, NOT DERIVED FROM ITS PATH.
 * It used to be a hash of the data dir's path, while "one server per data dir" is a lock on the directory's
 * inode. The two disagree: another mount namespace (a container, a VM, a unit with a private home) can hold a
 * DIFFERENT directory at the SAME path — its own lock, the same key — and that server treated the first server's
 * objects as its own (attacker c, round 1). So the identity now lives IN the directory: a random id written once
 * (`orchard-instance.json`), recording WHERE it was written: the inode plus the filesystem's stable id (its UUID,
 * never the device number). A copy of the directory is another inode: its inherited identity no longer matches and the
 * server refuses to bind until the user says what it is (`reidentify`: a separate instance, fresh id, no legacy
 * ownership; `rebind`: the same instance, moved). A rename keeps the inode, and the id.
 *
 * "Which server is the LIVE instance" (the one that adopts objects made before owner labels existed) is declared
 * the same way: by a marker the USER writes into the live data dir (`scripts/orchard-live-instance.mjs declare`),
 * also bound to the inode. It used to be inferred from CLAUDE_STATION_DATA being unset (BUG-219).
 *
 * MIGRATION. Objects made before this change carry the old path-derived key. A data dir that already existed
 * when its identity was first written records that key (`legacyKey`) and keeps owning those objects — and only
 * those — when it is DECLARED live (the marker). Nothing is inferred from the path (ARCH-022 decision B,
 * 2026-10-02): an UNDECLARED server, even at this account's default data dir, refuses every pre-identity and
 * unlabelled object (reports it, never removes or recreates it). Deploy order: the user runs
 * `node scripts/orchard-live-instance.mjs declare` BEFORE the restart that ships this — the command only writes the
 * marker, which older servers do not read. A copy or a fresh directory records no legacy key.
 *
 * KNOWN LIMIT (accepted, ARCH-022 decision 2026-10-02): the identity and marker files are trusted when their
 * recorded dev/ino match the directory. A process running as the same user that can WRITE the data dir can forge
 * them (e.g. give a copy the original's id). That is outside the threat model: such a process can already drive
 * the Docker daemon directly. The authority defends against accidents and other instances, not against this user.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dataDir } from '../lib/paths.ts';

/** The label every Orchard-created container/network/volume carries: which instance made it. */
export const LABEL_OWNER = 'claude-station.owner';
export const IDENTITY_FILE = 'orchard-instance.json';
export const LIVE_MARKER_FILE = 'orchard-live-instance.json';

/** Length-prefixed encoding, so no two different tuples hash the same bytes. */
function lp(...parts: string[]): string {
  return parts.map((p) => `${Buffer.byteLength(p)}:${p}`).join('');
}

function realDir(d: string): string {
  try { return fs.realpathSync(d); } catch { return path.resolve(d); }
}

/** The OLD, path-derived key (16 hex). Only what pre-ARCH-022 objects carry; never a new object's label. */
export function pathKey(dir: string = dataDir()): string {
  return crypto.createHash('sha256').update(lp('orchard-data', realDir(dir))).digest('hex').slice(0, 16);
}

/* ---------------------------------------------------------------- identity */

/*
 * WHERE an identity lives (ARCH-022 decision "reboot", 2026-10-02): the directory's INODE plus a STABLE filesystem
 * id — the filesystem UUID (for btrfs also the subvolume, via statfs f_fsid, which btrfs derives from the UUID and
 * the subvolume, so a snapshot is another place), never the device number: btrfs hands out an anonymous st_dev at
 * mount time, and a reboot that changed it made the live data dir read as a copy (attacker c4, round 4).
 * A filesystem without a UUID (tmpfs, overlay) falls back to f_fsid, then st_dev; such directories do not survive a
 * reboot anyway. On ANY mismatch the identity is never re-minted silently: binding fails loudly, naming the repair.
 */
export interface Place { ino: number; fs: string; dev: number }
function fsKeyOf(real: string, st: fs.Stats): string {
  let uuid = ''; let fstype = ''; let fsid = '';
  try {
    const r = spawnSync('findmnt', ['-n', '-o', 'UUID,FSTYPE', '-T', real], { encoding: 'utf8', timeout: 5_000 });
    if (r.status === 0) [uuid = '', fstype = ''] = (r.stdout ?? '').trim().split(/\s+/);
  } catch { /* findmnt unavailable */ }
  try {
    const r = spawnSync('stat', ['-f', '-c', '%i', real], { encoding: 'utf8', timeout: 5_000 });
    if (r.status === 0) fsid = (r.stdout ?? '').trim();
  } catch { /* stat unavailable */ }
  if (/^[0-9A-Fa-f-]{8,}$/.test(uuid)) return fstype === 'btrfs' && fsid ? `uuid:${uuid.toLowerCase()}:sub:${fsid}` : `uuid:${uuid.toLowerCase()}`;
  if (/^[0-9a-f]+$/.test(fsid) && !/^0+$/.test(fsid)) return `fsid:${fsid}`;
  return `dev:${st.dev}`;
}
/** Where `dir` is: its inode and its filesystem's stable id. */
export function placeOf(dir: string): Place | null {
  const real = realDir(dir);
  const st = statDir(real);
  return st ? { ino: st.ino, fs: fsKeyOf(real, st), dev: st.dev } : null;
}

export interface InstanceIdentity {
  schema: 2;
  /** The owner key: 16 hex, random, written once. */
  id: string;
  /** The directory it was written in: inode + stable filesystem id (dev is informational only). */
  ino: number;
  fs: string;
  dev: number;
  createdAt: string;
  /** The path-derived key this directory's objects carried before identities existed; null for a new or copied dir. */
  legacyKey: string | null;
}
const ID_RE = /^[0-9a-f]{16}$/;

/** Thrown when a data dir's identity file does not belong to the directory it sits in. Never resolved silently. */
export class IdentityMismatchError extends Error {
  code = 'identity-mismatch';
}
const repairHint = (dir: string) =>
  `If this directory IS the same Orchard instance (moved to another disk, restored, or its filesystem changed): node scripts/orchard-live-instance.mjs rebind --data-dir ${dir}. ` +
  `If it is a COPY that should be a separate instance: node scripts/orchard-live-instance.mjs reidentify --data-dir ${dir}. Until then no container operation runs.`;

function statDir(dir: string): fs.Stats | null {
  try { const st = fs.statSync(dir); return st.isDirectory() ? st : null; } catch { return null; }
}

type RawIdentity = { schema: number; id: string; ino: number; fs: string | null; dev: number; createdAt: string; legacyKey: string | null };
function readIdentityFile(dir: string): RawIdentity | null {
  const file = path.join(dir, IDENTITY_FILE);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Present but unreadable (permissions: e.g. once written by a server run under another user): NEVER replace it —
    // a fresh id would silently disown every object this instance made (attacker c3, round 3). Fail loudly.
    throw new IdentityMismatchError(`this data dir's identity file exists but cannot be read (${(e as NodeJS.ErrnoException).code}): ${file} — fix its permissions; no container operation will run until then`);
  }
  let j: Partial<RawIdentity>;
  try { j = JSON.parse(raw) as Partial<RawIdentity>; } catch { j = {}; }
  if ((j.schema !== 1 && j.schema !== 2) || typeof j.id !== 'string' || !ID_RE.test(j.id) || !Number.isFinite(j.ino) || (j.schema === 1 && !Number.isFinite(j.dev)) || (j.schema === 2 && typeof j.fs !== 'string')) {
    throw new IdentityMismatchError(`this data dir's identity file is unreadable as an identity: ${file}. It is never replaced silently. ${repairHint(dir)}`);
  }
  return { schema: j.schema, id: j.id, ino: Number(j.ino), fs: typeof j.fs === 'string' ? j.fs : null, dev: Number(j.dev), createdAt: String(j.createdAt ?? ''), legacyKey: typeof j.legacyKey === 'string' && ID_RE.test(j.legacyKey) ? j.legacyKey : null };
}

function writeIdentityExclusive(real: string, id: InstanceIdentity, replace: boolean): void {
  const file = path.join(real, IDENTITY_FILE);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(id, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (replace) fs.renameSync(tmp, file);
    else { try { fs.linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

/**
 * The identity of the data dir `dir`, created on first need (exclusive create: two processes on a fresh directory
 * agree on one id). An identity whose recorded place (inode + stable filesystem id) is not this directory's is
 * NEVER replaced: IdentityMismatchError, naming the repair (rebind = the same instance; reidentify = a copy).
 * A schema-1 file (inode + device number) whose device and inode both match is upgraded in place.
 * Returns null when the directory does not exist, or (create unset) has no identity yet.
 */
export function identityOf(dir: string = dataDir(), opts: { create?: boolean } = {}): InstanceIdentity | null {
  const real = realDir(dir);
  const st = statDir(real);
  if (!st) return null;
  const place = placeOf(real)!;
  const cur = readIdentityFile(real);
  if (cur) {
    const same = cur.schema === 2 ? cur.ino === place.ino && cur.fs === place.fs : cur.ino === place.ino && cur.dev === place.dev;
    if (!same) {
      throw new IdentityMismatchError(
        `this data dir's identity (${cur.id}) was written for another place (inode ${cur.ino}, filesystem ${cur.fs ?? `dev ${cur.dev}`}) than this directory (inode ${place.ino}, filesystem ${place.fs}). ${repairHint(real)}`);
    }
    const upgraded: InstanceIdentity = { schema: 2, id: cur.id, ino: place.ino, fs: place.fs, dev: place.dev, createdAt: cur.createdAt, legacyKey: cur.legacyKey };
    if (cur.schema === 1 && opts.create) { try { writeIdentityExclusive(real, upgraded, true); } catch { /* still valid in memory */ } }
    return upgraded;
  }
  if (!opts.create) return null;
  const hadState = fs.existsSync(path.join(real, 'registry.json'));
  const id: InstanceIdentity = {
    schema: 2, id: crypto.randomBytes(8).toString('hex'), ino: place.ino, fs: place.fs, dev: place.dev, createdAt: new Date().toISOString(),
    legacyKey: hadState ? pathKey(real) : null,
  };
  try { writeIdentityExclusive(real, id, false); } catch { return null; }
  const won = readIdentityFile(real);
  return won && won.schema === 2 && won.ino === place.ino && won.fs === place.fs
    ? { schema: 2, id: won.id, ino: won.ino, fs: won.fs!, dev: won.dev, createdAt: won.createdAt, legacyKey: won.legacyKey } : null;
}

/** REPAIR (user command): this directory IS the instance its identity names — rebind the identity (and a live marker) to this place. */
export function rebindIdentity(dir: string): InstanceIdentity {
  const real = realDir(dir);
  const place = placeOf(real);
  if (!place) throw new Error(`${real} is not a directory`);
  let cur: RawIdentity | null = null;
  try { cur = readIdentityFile(real); } catch (e) { throw new Error(`cannot rebind: ${(e as Error).message}`); }
  if (!cur) throw new Error(`cannot rebind: ${real} has no identity yet (one is written at the next server boot)`);
  const id: InstanceIdentity = { schema: 2, id: cur.id, ino: place.ino, fs: place.fs, dev: place.dev, createdAt: cur.createdAt, legacyKey: cur.legacyKey };
  writeIdentityExclusive(real, id, true);
  const mf = path.join(real, LIVE_MARKER_FILE);
  if (fs.existsSync(mf)) {
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(`${mf}.tmp`, `${JSON.stringify({ ...m, schema: 2, ino: place.ino, fs: place.fs, dev: place.dev, reboundAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(`${mf}.tmp`, mf);
    } catch { /* an unreadable marker stays not-live; declare again */ }
  }
  return id;
}
/** REPAIR (user command): this directory is a COPY — set its inherited identity aside and give it a fresh one (no legacy ownership). */
export function reidentify(dir: string): InstanceIdentity {
  const real = realDir(dir);
  const file = path.join(real, IDENTITY_FILE);
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.set-aside-${Date.now()}`);
  const mf = path.join(real, LIVE_MARKER_FILE);
  if (fs.existsSync(mf)) fs.renameSync(mf, `${mf}.set-aside-${Date.now()}`);
  const place = placeOf(real);
  if (!place) throw new Error(`${real} is not a directory`);
  const id: InstanceIdentity = { schema: 2, id: crypto.randomBytes(8).toString('hex'), ino: place.ino, fs: place.fs, dev: place.dev, createdAt: new Date().toISOString(), legacyKey: null };
  writeIdentityExclusive(real, id, false);
  return id;
}

export interface LiveMarker { schema: 1 | 2; ino: number; fs: string | null; dev: number; declaredAt: string; declaredBy: string }
/** The marker file's raw content, or null. */
function readMarker(real: string): Partial<LiveMarker> | null {
  try { return JSON.parse(fs.readFileSync(path.join(real, LIVE_MARKER_FILE), 'utf8')) as Partial<LiveMarker>; } catch { return null; }
}
/** The user's declaration that THIS directory is the live instance; valid only in the place it was written for. */
export function liveMarkerOf(dir: string = dataDir()): LiveMarker | null {
  const real = realDir(dir);
  const place = placeOf(real);
  if (!place) return null;
  const j = readMarker(real);
  if (!j) return null;
  const ok = j.schema === 2 ? Number(j.ino) === place.ino && j.fs === place.fs
    : j.schema === 1 ? Number(j.ino) === place.ino && Number(j.dev) === place.dev : false;
  if (!ok) return null;
  return { schema: 2, ino: place.ino, fs: place.fs, dev: place.dev, declaredAt: String(j.declaredAt ?? ''), declaredBy: String(j.declaredBy ?? '') };
}
/** A marker file is present but names another place (moved / copied / restored): said loudly at boot. */
export function liveMarkerMismatch(dir: string = dataDir()): boolean {
  const real = realDir(dir);
  return readMarker(real) !== null && liveMarkerOf(real) === null;
}

/** The data dir this user account's live server uses by default (from the password database, not from env). */
export function isAccountDefaultDataDir(dir: string): boolean {
  const def = path.join(os.userInfo().homedir, '.local', 'share', 'claude-station');
  return realDir(dir) === realDir(def);
}

/* ------------------------------------------------------------------ binding */

export interface BoundInstance {
  identity: InstanceIdentity;
  dir: string;
  /** The user declared this directory live (the marker, bound to its inode). */
  liveDeclared: boolean;
}
const BOUND = Symbol.for('orchard.instance-identity');
type G = typeof globalThis & { [BOUND]?: BoundInstance };

/**
 * Bind THIS process to its data dir's identity. Called by the lifecycle authority once it holds the data dir's
 * lock (boot recovery, or a suite's bootForTests), with the path that names the locked directory. Process-global
 * (a freshly re-imported copy of this module sees the same binding).
 */
export function bindInstance(lockedDir: string): BoundInstance {
  const identity = identityOf(lockedDir, { create: true });
  if (!identity) throw new Error(`cannot read or write this data dir's identity (${path.join(realDir(lockedDir), IDENTITY_FILE)})`);
  const liveDeclared = !!liveMarkerOf(lockedDir);
  if (!liveDeclared && liveMarkerMismatch(lockedDir)) {
    console.warn(`[orchard] ARCH-022: ${path.join(realDir(lockedDir), LIVE_MARKER_FILE)} declares ANOTHER place live (this directory was moved, copied or restored), so this server is NOT the live instance. If it is: node scripts/orchard-live-instance.mjs rebind --data-dir ${realDir(lockedDir)} (same instance) or declare it again.`);
  }
  const b: BoundInstance = { identity, dir: realDir(lockedDir), liveDeclared };
  (globalThis as G)[BOUND] = b;
  return b;
}
export function boundInstance(): BoundInstance | null {
  return (globalThis as G)[BOUND] ?? null;
}

/**
 * This instance's owner key (16 hex): the declared identity of the data dir. A process that has not bound (a tool
 * reading what a server on this dir stamps) reads the directory's identity file; with none yet, the old path key.
 */
export function ownerKey(): string {
  const b = boundInstance();
  if (b) return b.identity.id;
  return identityOf(dataDir())?.id ?? pathKey();
}

/** `--label` argv declaring this instance as the owner. Append to every `docker create/run/network create/volume create`. */
export function ownerLabelArgs(): string[] {
  return ['--label', `${LABEL_OWNER}=${ownerKey()}`];
}

export type Ownership = 'own' | 'foreign' | 'unlabelled';

/** The legacy key this bound instance still owns objects under, or null. */
function acceptedLegacyKey(): string | null {
  const b = boundInstance();
  if (!b || !b.identity.legacyKey) return null;
  return b.liveDeclared ? b.identity.legacyKey : null;
}

/** Classify an object by the owner label its creator wrote. The only question a sweep may ask. */
export function ownershipOf(ownerLabel: string | null | undefined): Ownership {
  const v = (ownerLabel ?? '').trim();
  // `docker inspect --format '{{index .Labels "k"}}'` prints the literal `<no value>`
  // for a missing label (Go template). That is absence, not another owner.
  if (!v || v === '<no value>') return 'unlabelled';
  if (v === ownerKey()) return 'own';
  const legacy = acceptedLegacyKey();
  return legacy && v === legacy ? 'own' : 'foreign';
}

/**
 * May THIS instance act on (reuse, recreate, remove) an object of this ownership? Own: yes. Foreign: never.
 * Unlabelled (made before the owner label existed): only the LIVE instance — declared by the user's marker in its
 * data dir. Nothing is inferred from a path; every other server (declared or not) never does.
 * Reporting is unchanged: sweeps still list unlabelled objects under `unowned` and never remove them.
 */
export function mayActOn(o: Ownership): boolean {
  if (o === 'own') return true;
  if (o !== 'unlabelled') return false;
  const b = boundInstance();
  return !!b && b.liveDeclared;
}
