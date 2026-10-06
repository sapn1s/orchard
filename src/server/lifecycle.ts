/**
 * ARCH-022 — THE container lifecycle authority.
 *
 * One owner for "may this Docker mutation happen now?". Every create, start, stop, remove, rename,
 * rebuild, image swap, service teardown, builder cleanup, orphan sweep and image prune is spawned by
 * `docker-exec.ts`, and `docker-exec.ts` asks the function this module installs (`sealAuthority`)
 * before spawning any mutation. That function grants a mutation only when ALL of these hold, checked
 * synchronously immediately before the spawn:
 *
 *   1. it runs inside an OPERATION (`runOp`) — a per-project FIFO slot; operations never join and
 *      never nest;
 *   2. this server still holds its data dir (`lanes.isWriter()`, BUG-220's kernel lock);
 *   3. the target is an Orchard object of a known role (session / service / builder / smoke /
 *      base-tag lock / image) that belongs to the operation's project and to this instance
 *      (`mayActOn`), resolved by inspecting the target — never by the caller's say-so;
 *   4. for anything that would stop, remove, rename or disconnect a project's session container, or
 *      remove its service sidecars/network/volumes: the project holds NO lease in any state, and a
 *      running session container's processes are proven to carry no session exec tag.
 *
 * LEASES are how "a session is live" is DECLARED rather than inferred (ARCH-010). A session can only
 * start in a project container through `admit`, an operation in that project's FIFO, which grants a
 * lease before its slot is released. So while any operation holds a project's slot, no new lease
 * for that project can appear: the set of leases can only shrink during an operation. A lease is
 * durable (a file under the data dir, written before the session's exec is submitted), and is
 * released only when the container is proven to run none of its processes — not when the session
 * object is dropped — so draining tool work and work left behind by a crashed server stay protected.
 * Boot RECOVERY turns every persisted lease and every tagged process found in a running container
 * into a draining lease before any operation may run.
 *
 * What this does NOT cover, stated: other docker clients (a container with the docker socket bound,
 * a shell on the host, another program); a process inside a container that clears its own
 * environment to drop the exec tag (the tag is the product's existing membership model, BUG-157).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dataDir, ensureDir } from '../lib/paths.ts';
import { sealAuthority, dockerSpawnSync, verbAt, type MutationGrant } from './docker-exec.ts';
import { LABEL_OWNER, ownerKey, ownershipOf, mayActOn, bindInstance } from './instance-owner.ts';
import * as lanes from './lanes.ts';

/* ------------------------------------------------------------------ facts */

/** Every project session container is named this (one owner of the fact). */
export const SESSION_NAME_PREFIX = 'claude-station-';
export function sessionContainerName(projectId: string): string {
  return `${SESSION_NAME_PREFIX}${projectId}`;
}
/** Env var carrying a session's exec tag inside the container; read back from /proc/<pid>/environ. */
export const EXEC_TAG_VAR = 'CLAUDE_STATION_EXEC';
const TAG_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class LifecycleError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(detail ? `${message}\n${detail}` : message);
    this.name = 'LifecycleError';
    this.code = code;
    this.detail = detail;
  }
}

/* --------------------------------------------------------------- context */

export type OpKind = 'admit' | 'start' | 'stop' | 'remove' | 'rebuild' | 'delete' | 'sweep' | 'prune' | 'reconcile' | 'maintain';

export class Op {
  readonly id: string;
  readonly projectId: string;
  readonly kind: OpKind;
  active = true;
  /** Set by `forceDrain` once the captured leases are gone: an unknown probe then does not block. */
  forced = false;
  /** Children of mutations this op issued that have not exited yet. */
  readonly inflight = new Set<Promise<void>>();
  constructor(projectId: string, kind: OpKind) {
    this.id = `op-${Date.now().toString(36)}-${(++opSeq).toString(36)}`;
    this.projectId = projectId;
    this.kind = kind;
  }
}
let opSeq = 0;

type Ctx = { kind: 'op'; op: Op } | { kind: 'lease'; leaseId: string } | { kind: 'probe' };
const als = new AsyncLocalStorage<Ctx>();

/** The operation the caller is running inside, if any. */
export function currentOp(): Op | null {
  const c = als.getStore();
  return c?.kind === 'op' && c.op.active ? c.op : null;
}

/* ------------------------------------------------------------ durable dir */

function stateDir(sub: 'leases' | 'fences'): string {
  const base = lanes.holdsLock() ? lanes.writerDataDir() : dataDir();
  const d = path.join(base, 'lifecycle', sub);
  ensureDir(d);
  return d;
}
function fileKey(k: string): string {
  return k.replace(/[^A-Za-z0-9_.-]/g, '_');
}
function writeJsonDurable(file: string, v: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(v)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/* ---------------------------------------------------------------- leases */

export type LeaseState = 'reserved' | 'attached' | 'draining';
export interface Lease {
  id: string;
  projectId: string;
  state: LeaseState;
  sessionId: string | null;
  createdAt: number;
  /** A crash leftover or a tag found at boot: nothing in this process owns it. */
  orphan: boolean;
}

const leases = new Map<string, Lease>();
const watchers = new Map<string, NodeJS.Timeout>();
const releaseWaiters = new Set<() => void>();
/** A reserved lease whose session never attached (a failed start) drains after this. */
const RESERVED_TTL_MS = 120_000;
const DRAIN_POLL_MS = 2_000;
/** A drain is proven by two empty probes at least this far apart (an exec accepted but not yet visible). */
const SETTLE_MS = 2_000;

/** A lease file is NAMED by its project and tag, so a torn or unreadable file still says what it protects. */
function leaseFile(projectId: string, id: string): string {
  return path.join(stateDir('leases'), `${fileKey(projectId)}--${fileKey(id)}.json`);
}
function persistLease(l: Lease): void {
  writeJsonDurable(leaseFile(l.projectId, l.id), l);
}
function unpersistLease(l: Lease): void {
  try { fs.unlinkSync(leaseFile(l.projectId, l.id)); } catch { /* already gone */ }
}

/** Leases of a project that are not yet released (any state). */
export function leasesOf(projectId: string): Lease[] {
  return [...leases.values()].filter((l) => l.projectId === projectId);
}
export function hasLeases(projectId: string): boolean {
  for (const l of leases.values()) if (l.projectId === projectId) return true;
  return false;
}

/** A new exec tag for a session about to be admitted. */
export function newExecTag(hint = 'cs'): string {
  const h = hint.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  return `${h}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Granted only by an `admit` operation of the same project, before its slot is released. */
export function grantLease(op: Op, id: string): Lease {
  if (!op.active || op.kind !== 'admit') throw new LifecycleError('not-admission', 'a lease can only be granted by an admit operation');
  if (!TAG_RE.test(id)) throw new LifecycleError('bad-exec-id', `refusing unsafe exec tag ${JSON.stringify(id)}`);
  if (leases.has(id)) throw new LifecycleError('lease-exists', `exec tag ${id} already holds a lease`);
  const l: Lease = { id, projectId: op.projectId, state: 'reserved', sessionId: null, createdAt: Date.now(), orphan: false };
  persistLease(l); // durable BEFORE any exec can carry the tag
  leases.set(id, l);
  const t = setTimeout(() => { const cur = leases.get(id); if (cur?.state === 'reserved') drainLease(id); }, RESERVED_TTL_MS);
  t.unref();
  return l;
}

/** The session the lease was granted for is now registered. Idempotent. */
export function attachLease(id: string, sessionId: string): void {
  const l = leases.get(id);
  if (!l || l.state !== 'reserved') return;
  l.state = 'attached';
  l.sessionId = sessionId;
  persistLease(l);
}

/**
 * The session ended (or never started). Protection is kept until the container is proven to run none
 * of the lease's processes. Idempotent; a released or unknown lease is a no-op.
 */
export function drainLease(id: string): void {
  const l = leases.get(id);
  if (!l) return;
  if (l.state !== 'draining') { l.state = 'draining'; persistLease(l); }
  if (watchers.has(id)) return;
  let emptySince: number | null = null;
  const tick = () => {
    watchers.delete(id);
    const cur = leases.get(id);
    if (!cur) return;
    const p = probeProject(cur.projectId);
    if (p.state === 'gone' || p.state === 'stopped') return releaseLease(id);
    if (p.state === 'ok' && !p.tags.has(id)) {
      if (emptySince === null) emptySince = Date.now();
      else if (Date.now() - emptySince >= SETTLE_MS) return releaseLease(id);
    } else {
      emptySince = null; // live, or unknown: keep protecting
    }
    const t = setTimeout(tick, DRAIN_POLL_MS);
    t.unref();
    watchers.set(id, t);
  };
  const t = setTimeout(tick, cur0Delay(l));
  t.unref();
  watchers.set(id, t);
}
function cur0Delay(l: Lease): number { return l.orphan ? 0 : 250; }

function releaseLease(id: string): void {
  const w = watchers.get(id);
  if (w) clearTimeout(w);
  watchers.delete(id);
  const gone = leases.get(id);
  if (!gone || !leases.delete(id)) return;
  unpersistLease(gone);
  for (const f of [...releaseWaiters]) f();
}

function waitForRelease(projectId: string, ids: Set<string>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const left = leasesOf(projectId).some((l) => ids.has(l.id));
      if (!left) { done(true); return true; }
      if (Date.now() >= deadline) { done(false); return true; }
      return false;
    };
    const timer = setInterval(() => { check(); }, 500);
    timer.unref();
    const waiter = () => { check(); };
    const done = (v: boolean) => { clearInterval(timer); releaseWaiters.delete(waiter); resolve(v); };
    releaseWaiters.add(waiter);
    check();
  });
}

/* ----------------------------------------------------------------- probe */

const raw = sealAuthority(authorize);

function hostIds(): string {
  const u = os.userInfo();
  return `${u.uid}:${u.gid}`;
}

/**
 * The probe: every process's environment, streamed out RAW, parsed HERE (attacker a, round 1: the in-container
 * parse used tr/sed/head, and an image without sed printed no tags yet still finished — the probe failed OPEN).
 * Inside the container it needs only `sh` and `cat`, and `cat` is proven first (missing = unknown). A process's
 * environment is readable only by its own uid (the container drops CAP_SYS_PTRACE), so it runs as the session uid
 * AND as root; a live, non-zombie process neither can read is UNKNOWN, and unknown keeps protection.
 *
 * Framing cannot hide a tag: the parser takes every `CLAUDE_STATION_EXEC=` entry ANYWHERE in the stream, so bytes a
 * process put in its own environment can only ADD tags (more protection), never remove one. `@ERR` markers are
 * printed only for environments that could NOT be read (whose bytes are therefore not in the stream).
 */
const PROBE_SCRIPT =
  `cat /proc/self/status >/dev/null 2>&1 || { printf '\\n@NOCAT\\n'; exit 9; }; ` +
  `for p in /proc/[0-9]*; do ` +
  `if cat "$p/environ" 2>/dev/null; then printf '\\0'; ` +
  `else printf '\\0@ERR %s\\0' "\${p#/proc/}"; cat "$p/status" 2>/dev/null; printf '\\0@ST\\0'; fi; done; printf '\\0@END\\0'`;

type ProbeRun = { ok: true; tags: Set<string>; unreadable: Set<string> } | { ok: false; why: string };
function parseProbe(out: string): ProbeRun {
  if (out.includes('@NOCAT')) return { ok: false, why: 'the container has no usable cat' };
  if (!out.endsWith('\0@END\0')) return { ok: false, why: 'the probe did not complete' };
  const tags = new Set<string>();
  for (const tok of out.split(/[\0\n]/)) {
    if (!tok.startsWith(`${EXEC_TAG_VAR}=`)) continue;
    const t = tok.slice(EXEC_TAG_VAR.length + 1);
    if (!TAG_RE.test(t)) return { ok: false, why: 'a process carries a malformed exec tag' };
    tags.add(t);
  }
  // each process whose environment could not be read: its status says zombie (no work) or live (unreadable)
  const unreadable = new Set<string>();
  const re = /\0@ERR (\d+)\0([\s\S]*?)\0@ST\0/g;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const status = m[2] ?? '';
    if (!status.includes('State:')) continue; // exited between the two reads
    if (/State:\s*Z/.test(status)) continue; // a zombie runs nothing
    unreadable.add(m[1]!);
  }
  return { ok: true, tags, unreadable };
}

interface ContainerFacts { id: string; name: string; running: boolean; paused: boolean; labels: Record<string, string> }

function inspectContainer(target: string): ContainerFacts | null | 'error' {
  const r = dockerSpawnSync(['container', 'inspect', target, '--format', '{{json .}}'], { timeoutMs: 20_000 });
  if (r.status !== 0) return /no such (object|container)/i.test(`${r.stderr}${r.stdout}`) ? null : 'error';
  try {
    const j = JSON.parse(r.stdout) as Record<string, any>;
    return {
      id: String(j.Id ?? ''),
      name: String(j.Name ?? '').replace(/^\//, ''),
      running: j.State?.Running === true || j.State?.Restarting === true,
      paused: j.State?.Paused === true,
      labels: (j.Config?.Labels ?? {}) as Record<string, string>,
    };
  } catch { return 'error'; }
}

type Probe = { state: 'ok'; tags: Set<string> } | { state: 'unknown'; why: string } | { state: 'stopped' } | { state: 'gone' };

/** Tri-state: a probe that could not complete is UNKNOWN, and unknown keeps protection. */
/**
 * ARCH-022 (attacker c3, round 3): the authority's OWN execs into a session container — the liveness probe, the force
 * reap, a lease's exec — reach only a container this instance may act on. A copy of a data dir inherits its lease
 * files (another instance, another identity): without this, its force-stop reaped the ORIGINAL server's live
 * processes inside the original's container before the destroy was refused as foreign. Ownership is the gate's
 * first question for every exec, not only for destroys.
 */
function actable(c: ContainerFacts): boolean {
  return mayActOn(ownershipOf(c.labels[LABEL_OWNER]));
}

function probeContainer(c: ContainerFacts): Probe {
  if (!c.running) return { state: 'stopped' };
  if (!actable(c)) return { state: 'unknown', why: `${c.name} is not this instance's container; it is never probed from here` };
  if (c.paused) return { state: 'unknown', why: 'the container is paused' };
  // A process unreadable as the session uid but readable as root (or the reverse) is read; unreadable in BOTH = unknown.
  const runs: ProbeRun[] = [];
  for (const user of [hostIds(), '0:0']) {
    let r;
    try {
      r = raw.spawnSync(['exec', '--user', user, c.id, 'sh', '-c', PROBE_SCRIPT], { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 }, authorityRaw('probe', c.id));
    } catch (e) { return { state: 'unknown', why: (e as Error).message }; }
    if (r.status !== 0 || r.error) return { state: 'unknown', why: `probe as ${user} exited ${r.status ?? r.signal}: ${(r.stderr || '').trim().slice(0, 200)}` };
    const p = parseProbe(r.stdout ?? '');
    if (!p.ok) return { state: 'unknown', why: p.why };
    runs.push(p);
  }
  const tags = new Set<string>();
  for (const r of runs) if (r.ok) for (const t of r.tags) tags.add(t);
  // A process is UNKNOWN only if NEITHER uid could read it (a third uid); each uid reads its own processes.
  const [a, b] = runs as [Extract<ProbeRun, { ok: true }>, Extract<ProbeRun, { ok: true }>];
  const both = [...a.unreadable].filter((pid) => b.unreadable.has(pid));
  if (both.length) return { state: 'unknown', why: `process(es) ${both.slice(0, 5).join(', ')} run as a uid the probe cannot read` };
  return { state: 'ok', tags };
}

function probeProject(projectId: string): Probe {
  const c = inspectContainer(sessionContainerName(projectId));
  if (c === null) return { state: 'gone' };
  if (c === 'error') return { state: 'unknown', why: 'inspect failed' };
  return probeContainer(c);
}

/** Kill every process carrying one of these tags (the force path). Raw: the authority's own act. */
function reapTags(projectId: string, ids: string[], signal: 'TERM' | 'KILL'): void {
  const c = inspectContainer(sessionContainerName(projectId));
  if (!c || c === 'error' || !c.running || !actable(c)) return;
  for (const id of ids) {
    if (!TAG_RE.test(id)) continue;
    const script =
      `for p in /proc/[0-9]*; do ` +
      `if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "${EXEC_TAG_VAR}=${id}"; then kill -${signal} "\${p#/proc/}" 2>/dev/null; fi; done; true`;
    try { raw.spawnSync(['exec', '--user', hostIds(), c.id, 'sh', '-c', script], { timeoutMs: 15_000 }, authorityRaw(`reap-${signal}`, id)); } catch { /* the drain watcher decides */ }
  }
}

/* ------------------------------------------------------------- readiness */

let readyState: 'not-started' | 'recovering' | 'ready' = 'not-started';
let readyPromise: Promise<void> | null = null;

/**
 * Boot RECOVERY, before any operation may run: every persisted lease becomes a draining orphan, and
 * every running session container this instance may act on is probed — each exec tag found is a
 * draining orphan lease, and a container that cannot be probed gets a quarantine lease until it can.
 */
export function recover(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyState = 'recovering';
  readyPromise = (async () => {
    // ARCH-022: bind this process to the identity DECLARED in the data dir it holds (the locked inode), before
    // any ownership question is asked. Without the lock there is no identity to bind, and no operation runs.
    if (!lanes.holdsLock()) throw new LifecycleError('no-claim', 'boot recovery needs this server to hold its data dir; nothing will run');
    bindInstance(lanes.writerDataDir());
    // 1. persisted leases (sessions of a server that stopped or crashed)
    let files: string[] = [];
    try { files = fs.readdirSync(stateDir('leases')).filter((f) => f.endsWith('.json')); } catch { files = []; }
    for (const f of files) {
      let rec: Partial<Lease> | null = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(stateDir('leases'), f), 'utf8')) as Partial<Lease>; } catch { rec = null; }
      if (!rec || typeof rec.id !== 'string' || typeof rec.projectId !== 'string' || !TAG_RE.test(rec.id)) {
        // A torn or unreadable lease file still NAMES its project: protect that project until its container is proven
        // to run nothing (attacker a, round 1: recovery used to skip it silently).
        const m = /^(.+?)--(.+)\.json$/.exec(f);
        if (!m) continue; // not a lease file this code wrote
        const q = `quarantine-file-${m[2]!.slice(0, 64)}`.replace(/[^A-Za-z0-9_-]/g, '-');
        leases.set(q, { id: q, projectId: m[1]!, state: 'draining', sessionId: null, createdAt: Date.now(), orphan: true });
        try { fs.renameSync(path.join(stateDir('leases'), f), path.join(stateDir('leases'), `${f}.unreadable`)); } catch { /* keep it */ }
        continue;
      }
      leases.set(rec.id, { id: rec.id, projectId: rec.projectId, state: 'draining', sessionId: null, createdAt: Number(rec.createdAt) || Date.now(), orphan: true });
    }
    // 2. tags found in running session containers
    const ls = dockerSpawnSync(['ps', '--filter', 'label=claude-station=1', '--format', `{{.ID}}\t{{.Names}}\t{{.Label "claude-station.project"}}\t{{.Label "${LABEL_OWNER}"}}`], { timeoutMs: 30_000 });
    if (ls.status !== 0) throw new LifecycleError('recovery-failed', `cannot list running containers (${(ls.stderr || '').trim().slice(0, 200)}); no container operation will run until this server can`);
    const rows = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((l) => l.split('\t'));
    for (const [cid = '', cname = '', cproj = '', cowner = ''] of rows) {
      const c = inspectContainer(cid);
      if (!c) continue; // gone since the listing
      if (c === 'error') {
        // cannot be inspected: protect the project its listing names (attacker a, round 1: it used to be skipped)
        const m = /^claude-station-(.+?)(\.next|-next)?$/.exec(cname);
        const pid = cproj && PROJECT_RE.test(cproj) ? cproj : m && PROJECT_RE.test(m[1]!) ? m[1]! : null;
        if (pid && mayActOn(ownershipOf(cowner))) {
          const q = `quarantine-${cid.slice(0, 12)}`;
          leases.set(q, { id: q, projectId: pid, state: 'draining', sessionId: null, createdAt: Date.now(), orphan: true });
        }
        continue;
      }
      if (roleOf(c) !== 'session' || !mayActOn(ownershipOf(c.labels[LABEL_OWNER]))) continue;
      const pid = projectOfSession(c);
      if (!pid) continue;
      const p = probeContainer(c);
      if (p.state === 'ok') {
        for (const t of p.tags) if (!leases.has(t)) leases.set(t, { id: t, projectId: pid, state: 'draining', sessionId: null, createdAt: Date.now(), orphan: true });
      } else if (p.state === 'unknown') {
        const q = `quarantine-${c.id.slice(0, 12)}`;
        leases.set(q, { id: q, projectId: pid, state: 'draining', sessionId: null, createdAt: Date.now(), orphan: true });
      }
    }
    for (const l of leases.values()) { persistLease(l); drainLease(l.id); }
    readyState = 'ready';
  })();
  return readyPromise;
}

export function isReady(): boolean { return readyState === 'ready'; }

/* ---------------------------------------------------------------- fences */

interface Fence { key: string; verb: string; target: string; at: number; bound: number }
/** How long a timed-out mutation may still be acted on by the daemon (a test may shorten it). */
const FENCE_BOUND_MS = (() => { const v = Number(process.env.ORCHARD_LIFECYCLE_FENCE_MS); return Number.isFinite(v) && v > 0 ? v : 120_000; })();

function fenceFile(key: string): string { return path.join(stateDir('fences'), `${fileKey(key)}.json`); }
function readFence(key: string): Fence | null {
  try { return JSON.parse(fs.readFileSync(fenceFile(key), 'utf8')) as Fence; } catch { return null; }
}
function writeFence(f: Fence): void { writeJsonDurable(fenceFile(f.key), f); }
function clearFence(key: string): void { try { fs.unlinkSync(fenceFile(key)); } catch { /* none */ } }

/** Terminal evidence that a timed-out mutation is over; anything else keeps the fence. */
async function reconcileFence(key: string): Promise<boolean> {
  const f = readFence(key);
  if (!f) return true;
  const wait = f.bound - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, FENCE_BOUND_MS)));
  let settled = true;
  if (f.verb === 'rm' || f.verb === 'stop' || f.verb === 'kill') {
    const c = inspectContainer(f.target);
    if (c === 'error') settled = false;
    else if (f.verb === 'rm') settled = c === null;
    else settled = c === null || !c.running;
  }
  if (settled) clearFence(key);
  return settled;
}

/* ------------------------------------------------------------- scheduler */

const queues = new Map<string, Promise<unknown>>();

export interface RunOpts {
  /** Re-read the project under the slot; a missing project or another generation fails `project-gone`. */
  current?: () => { createdAt?: string } | null | undefined;
  /** The project's generation (createdAt) when the request was made. */
  expectGeneration?: string | null;
}

/**
 * Run `fn` in the project's FIFO slot. Operations never join and never nest: calling `runOp` from
 * inside an operation throws, so a lock-order cycle cannot be written.
 */
export function runOp<T>(projectId: string, kind: OpKind, fn: (op: Op) => Promise<T>, opts: RunOpts = {}): Promise<T> {
  if (als.getStore()?.kind === 'op') {
    return Promise.reject(new LifecycleError('reentrant', `a ${kind} operation cannot be started from inside another operation (ARCH-022: operations never nest)`));
  }
  if (readyState === 'not-started') {
    return Promise.reject(new LifecycleError('not-ready', 'the container lifecycle authority has not been started (boot recovery has not run in this process)'));
  }
  const prev = queues.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    await readyPromise;
    const op = new Op(projectId, kind);
    try {
      if (!lanes.isWriter()) throw new LifecycleError('no-claim', 'this server does not hold its data dir (another server, or the dir moved); no container operation may run');
      if (opts.current) {
        const cur = opts.current();
        if (!cur || (opts.expectGeneration !== undefined && (cur.createdAt ?? null) !== opts.expectGeneration)) {
          throw new LifecycleError('project-gone', `project ${projectId} was deleted (or replaced by a new project with the same id) before this ${kind} ran; nothing was done`);
        }
      }
      const fenced = !(await reconcileFence(projectId));
      if (fenced && (kind === 'admit' || kind === 'start' || kind === 'rebuild')) {
        const f = readFence(projectId);
        throw new LifecycleError('lifecycle-uncertain', `an earlier docker ${f?.verb ?? 'operation'} on ${f?.target ?? projectId} timed out and its outcome cannot be proven; no session is admitted until it is settled — Stop or Remove the container to settle it`);
      }
      return await als.run({ kind: 'op', op }, () => fn(op));
    } finally {
      // The slot is released only once every mutation this op started has exited.
      if (op.inflight.size) {
        const all = Promise.allSettled([...op.inflight]);
        const capped = await Promise.race([all.then(() => true), new Promise<boolean>((r) => { const t = setTimeout(() => r(false), FENCE_BOUND_MS); t.unref(); })]);
        if (!capped) writeFence({ key: projectId, verb: 'unsettled', target: projectId, at: Date.now(), bound: Date.now() + FENCE_BOUND_MS });
      }
      op.active = false;
    }
  });
  const tail = next.catch(() => undefined);
  queues.set(projectId, tail);
  void tail.then(() => { if (queues.get(projectId) === tail) queues.delete(projectId); });
  return next;
}

/** Shared image cleanup: its own slot, scheduled, never awaited by a project operation. */
export function scheduleImagesOp(fn: (op: Op) => Promise<void> | void): void {
  if (readyState === 'not-started') return;
  // Scheduled FROM an operation (after its ensure), but it is not nested in it: it leaves the caller's context
  // and queues in its own slot, so the project's slot is never held while waiting on the images slot.
  als.exit(() => {
    void runOp('#images', 'prune', async (op) => { await fn(op); }).catch((e) => console.warn(`[lifecycle] image cleanup failed: ${(e as Error).message}`));
  });
}

/**
 * READ-ONLY probes that need an exec (docker has no other way to read inside a container): the exact
 * commands below and nothing else, into a session container. Owned here so the gate can match them.
 */
export const MEMORY_PROBE_SCRIPT =
  'echo C:$(cat /sys/fs/cgroup/memory.current 2>/dev/null); ' +
  'echo M:$(cat /sys/fs/cgroup/memory.max 2>/dev/null); ' +
  "echo K:$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)";
export function withProbe<T>(fn: () => T): T {
  return als.run({ kind: 'probe' }, fn);
}
function authorizeProbe(args: readonly string[]): void {
  const i = verbAt(args);
  if (args[i] !== 'exec') refuse('probe-scope', `a probe may only exec, not docker ${args[i]}`);
  const rest = args.slice(i + 1);
  const pos = positionals(rest, EXEC_FLAGS);
  const c = pos[0] ? inspectContainer(pos[0]) : null;
  if (!c || c === 'error' || roleOf(c) !== 'session') refuse('probe-scope', 'a probe may only read a session container');
  if (!actable(c)) refuse('foreign-owner', `a probe may only read this instance's session container, not ${c.name}`);
  const cmd = pos.slice(1);
  const statOk = cmd[0] === 'stat' && cmd[1] === '-c' && cmd[2] === '%i %n' && cmd.slice(3).every((p) => p.startsWith('/') && !p.includes('\n'));
  const memOk = cmd.length === 3 && cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2] === MEMORY_PROBE_SCRIPT;
  if (!statOk && !memOk) refuse('probe-scope', 'not one of the fixed read-only probes');
  if (rest.some((a) => a === '-u' || a === '--user' || a.startsWith('--user=') || a === '--privileged')) refuse('probe-scope', 'a probe runs as the container default user, unprivileged');
}

/** Run `fn` with the authority of a lease (the session's own exec, probe and reap). */
export function withLease<T>(id: string, fn: () => T): T {
  return als.run({ kind: 'lease', leaseId: id }, fn);
}

/**
 * FORCE: the caller captured these leases at request time (and has closed their sessions). Reap their
 * processes and wait, bounded, until each is proven gone. Leases granted later are not in the set and
 * stay protected. Returns false (and keeps protection) if anything is still there at the deadline.
 */
export async function forceDrain(op: Op, captured: string[], deadlineMs = 30_000): Promise<boolean> {
  if (!op.active || op !== currentOp()) throw new LifecycleError('not-in-op', 'forceDrain must run inside its own operation');
  const ids = new Set(captured.filter((id) => leases.get(id)?.projectId === op.projectId));
  {
    const c = inspectContainer(sessionContainerName(op.projectId));
    if (c && c !== 'error' && !actable(c)) refuse('foreign-owner', `${c.name} belongs to another Orchard instance (or is unlabelled and this instance adopts none); nothing in it is reaped from here`);
  }
  for (const id of ids) drainLease(id);
  if (!ids.size) { op.forced = true; return true; }
  reapTags(op.projectId, [...ids], 'TERM');
  const soft = await waitForRelease(op.projectId, ids, Date.now() + 5_000);
  if (!soft) reapTags(op.projectId, [...ids].filter((id) => leases.has(id)), 'KILL');
  const ok = soft || (await waitForRelease(op.projectId, ids, Date.now() + deadlineMs));
  if (ok) op.forced = true;
  return ok;
}

/* ------------------------------------------------------------- authority */

type Role = 'session' | 'service' | 'builder' | 'smoke' | 'basetag-lock' | 'rtbuild' | 'unknown';

function roleOf(c: ContainerFacts): Role {
  const L = c.labels;
  /*
   * A SESSION container is recognised first, and by what Orchard itself declared: its create args set
   * `claude-station.role=session` (create-time labels override every image label), and its name is the project's
   * session name. An image can carry any label — a smoke/builder/rtbuild/lock label inherited from a prebuilt or
   * project image must never turn a session container into a role whose removal needs no lease (BUG-214 round 8:
   * inherited labels; found again building ARCH-022 step iv, where the CLI layer's build label reached sessions).
   */
  if (L['claude-station'] === '1' && L['claude-station.role'] === 'session') return 'session';
  if (L['claude-station'] === '1' && !L['claude-station.role']) {
    const pid = L['claude-station.project'];
    const m = /^claude-station-(.+?)(\.next|-next)?$/.exec(c.name);
    if (m && pid && pid === m[1]) return 'session'; // a pre-role-label session container: its name and its project label agree
  }
  if (L['orchard.basetag-lock'] === '1') return 'basetag-lock';
  if (L['claude-station.smoke'] === '1') return 'smoke';
  if (L['claude-station.rtbuild'] === '1') return 'rtbuild'; // FEAT-157: a never-started container the CLI layer is committed from
  if (L['claude-station.builder-project']) return 'builder';
  if (L['claude-station.role'] === 'service') return 'service';
  if (L['claude-station'] === '1' && (!L['claude-station.role'] || L['claude-station.role'] === 'session')) return 'session';
  return 'unknown';
}

/** The project a session container belongs to: its label, or (unlabelled legacy) its name. */
function projectOfSession(c: ContainerFacts): string | null {
  const lab = c.labels['claude-station.project'];
  if (lab && PROJECT_RE.test(lab)) return lab;
  const m = /^claude-station-(.+?)(\.next|-next)?$/.exec(c.name);
  return m && PROJECT_RE.test(m[1]!) ? m[1]! : null;
}

function refuse(code: string, msg: string): never {
  throw new LifecycleError(code, msg);
}

function positionals(rest: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') { out.push(...rest.slice(i + 1)); break; }
    if (a.startsWith('-')) { if (!a.includes('=') && valueFlags.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

const NO_VALUE = new Set<string>();
const STOP_FLAGS = new Set(['-t', '--time', '--timeout', '-s', '--signal']);
const KILL_FLAGS = new Set(['-s', '--signal']);
const EXEC_FLAGS = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys']);
const START_FLAGS = new Set(['--detach-keys', '--checkpoint', '--checkpoint-dir']);

/** Inspect a container target for the gate; a target that does not exist cannot be harmed. */
function target(t: string): ContainerFacts | null {
  const c = inspectContainer(t);
  if (c === 'error') refuse('target-unknown', `cannot inspect ${t}; refusing to act on what cannot be identified`);
  return c;
}

function assertNoLeases(op: Op, what: string): void {
  const ls = leasesOf(op.projectId);
  if (ls.length) {
    refuse('live-sessions',
      `refusing to ${what}: ${ls.length} session(s) hold project ${op.projectId}'s container (${ls.map((l) => `${l.id}:${l.state}`).join(', ')}); ` +
      'this would destroy work underneath them. Close them first, or retry with ?force=1.');
  }
}

/** A container mutation of this op: role, ownership and project, then protection when destructive. */
function assertContainer(op: Op, c: ContainerFacts, verb: string, destructive: boolean): void {
  const role = roleOf(c);
  const owner = ownershipOf(c.labels[LABEL_OWNER]);
  switch (role) {
    case 'basetag-lock':
      // A never-started mutex container (BUG-218). A dead holder's may be removed whoever made it.
      if (c.running) refuse('target-role', `${c.name} claims to be a base-tag lock but is running`);
      return;
    case 'smoke':
      if (owner !== 'own') refuse('foreign-owner', `${c.name} is another instance's validation container`);
      return;
    case 'rtbuild':
      if (owner !== 'own') refuse('foreign-owner', `${c.name} is another instance's CLI-layer build container`);
      if (c.running) refuse('target-role', `${c.name} claims to be a CLI-layer build container but is running`);
      return;
    case 'builder':
      if (c.labels['claude-station.builder-data'] !== ownerKey()) refuse('foreign-owner', `${c.name} is another data dir's builder`);
      if (c.labels['claude-station.builder-project'] !== op.projectId) refuse('wrong-project', `${c.name} is the builder of project ${c.labels['claude-station.builder-project']}, not ${op.projectId}`);
      return;
    case 'service': {
      if (!mayActOn(owner)) refuse('foreign-owner', `${c.name} belongs to another Orchard instance`);
      if (c.labels['claude-station.project'] !== op.projectId) refuse('wrong-project', `${c.name} is a service of project ${c.labels['claude-station.project']}, not ${op.projectId}`);
      if (destructive) assertNoLeases(op, `docker ${verb} ${c.name}`);
      return;
    }
    case 'session': {
      if (!mayActOn(owner)) refuse('foreign-owner', `${c.name} belongs to another Orchard instance (or is unlabelled and this instance adopts none)`);
      const pid = projectOfSession(c);
      if (pid !== op.projectId) refuse('wrong-project', `${c.name} is project ${pid ?? '?'}'s container, not ${op.projectId}'s`);
      if (!destructive) return;
      if (c.name === sessionContainerName(op.projectId)) assertNoLeases(op, `docker ${verb} ${c.name}`);
      if (c.running) {
        const p = probeContainer(c);
        if (p.state === 'ok' && p.tags.size) refuse('live-sessions', `refusing docker ${verb} ${c.name}: session processes are still running in it (${[...p.tags].join(', ')})`);
        if (p.state === 'unknown' && !op.forced) refuse('live-sessions', `refusing docker ${verb} ${c.name}: cannot prove no session work runs in it (${p.why}); retry with ?force=1`);
      }
      return;
    }
    default:
      refuse('target-role', `refusing docker ${verb} ${c.name || c.id}: it is not an Orchard object of a known role`);
  }
}

function labelsOfCreate(rest: readonly string[]): { name: string; labels: Record<string, string> } {
  let name = '';
  const labels: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const val = (flag: string) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : a === flag ? rest[++i] ?? '' : null);
    const n = val('--name'); if (n !== null) { name = n; continue; }
    if (a === '--label-file' || a.startsWith('--label-file=')) refuse('unparseable', 'labels from a file cannot be checked; refusing');
    const l = val('--label') ?? val('-l');
    if (l !== null) { const k = l.indexOf('='); labels[k < 0 ? l : l.slice(0, k)] = k < 0 ? '' : l.slice(k + 1); }
  }
  return { name, labels };
}

/** A container this op is about to CREATE: there is nothing to inspect, so its declared schema decides. */
function assertCreate(op: Op, rest: readonly string[]): void {
  const { name, labels } = labelsOfCreate(rest);
  const c: ContainerFacts = { id: '', name, running: false, paused: false, labels };
  const role = roleOf(c);
  if (role !== 'basetag-lock' && labels[LABEL_OWNER] !== ownerKey() && labels['claude-station.builder-data'] !== ownerKey()) {
    refuse('target-role', `refusing to create ${name || 'a container'} without this instance's owner label`);
  }
  switch (role) {
    case 'basetag-lock': if (!/^orchard-basetag-lock-[0-9a-f]{16}$/.test(name)) refuse('target-role', `bad base-tag lock name ${name}`); return;
    case 'smoke': if (!/^claude-station-(smoke|clisha|verify)-[0-9a-f]+$/.test(name)) refuse('target-role', `bad validation container name ${name}`); return;
    case 'rtbuild': if (!/^claude-station-rtbuild-[0-9a-f]+$/.test(name)) refuse('target-role', `bad CLI-layer build container name ${name}`); return;
    case 'builder': if (labels['claude-station.builder-project'] !== op.projectId) refuse('wrong-project', `builder for ${labels['claude-station.builder-project']} created by ${op.projectId}'s operation`); return;
    case 'service': if (labels['claude-station.project'] !== op.projectId) refuse('wrong-project', `service of ${labels['claude-station.project']} created by ${op.projectId}'s operation`); return;
    case 'session': {
      const main = sessionContainerName(op.projectId);
      if (labels['claude-station.project'] !== op.projectId || (name !== main && name !== `${main}.next`)) refuse('wrong-project', `session container ${name} is not project ${op.projectId}'s`);
      return;
    }
    default: refuse('target-role', `refusing to create ${name || 'a container'} of no known Orchard role`);
  }
}

function networkFacts(net: string): { project: string; owner: ReturnType<typeof ownershipOf> } | null {
  const r = dockerSpawnSync(['network', 'inspect', net, '--format', `{{index .Labels "claude-station.project"}}\t{{index .Labels "${LABEL_OWNER}"}}`], { timeoutMs: 20_000 });
  if (r.status !== 0) return /no such network|not found/i.test(`${r.stderr}${r.stdout}`) ? null : refuse('target-unknown', `cannot inspect network ${net}`);
  const [project = '', owner = ''] = r.stdout.trim().split('\t');
  return { project: project === '<no value>' ? '' : project, owner: ownershipOf(owner) };
}
function volumeFacts(vol: string): Record<string, string> | null {
  const r = dockerSpawnSync(['volume', 'inspect', vol, '--format', '{{json .Labels}}'], { timeoutMs: 20_000 });
  if (r.status !== 0) return /no such volume|not found/i.test(`${r.stderr}${r.stdout}`) ? null : refuse('target-unknown', `cannot inspect volume ${vol}`);
  try { return (JSON.parse(r.stdout) ?? {}) as Record<string, string>; } catch { return refuse('target-unknown', `cannot read volume ${vol}'s labels`); }
}

function assertNetwork(op: Op, net: string, destructive: boolean): void {
  const n = networkFacts(net);
  if (!n) return;
  if (!mayActOn(n.owner)) refuse('foreign-owner', `network ${net} belongs to another Orchard instance`);
  if (n.project !== op.projectId) refuse('wrong-project', `network ${net} belongs to project ${n.project || '?'}, not ${op.projectId}`);
  if (destructive) assertNoLeases(op, `remove network ${net}`);
}

function assertVolume(op: Op, vol: string, creating: boolean, labels?: Record<string, string>): void {
  const L = creating ? labels ?? {} : volumeFacts(vol);
  if (!L) return;
  if (L['claude-station.builder-project']) {
    if (L['claude-station.builder-data'] !== ownerKey() || L['claude-station.builder-project'] !== op.projectId) refuse('wrong-project', `volume ${vol} is not this project's builder state`);
    return;
  }
  if (L['claude-station.role'] === 'service') {
    if (!mayActOn(ownershipOf(L[LABEL_OWNER]))) refuse('foreign-owner', `volume ${vol} belongs to another Orchard instance`);
    if (L['claude-station.project'] !== op.projectId) refuse('wrong-project', `volume ${vol} belongs to project ${L['claude-station.project']}, not ${op.projectId}`);
    if (!creating) assertNoLeases(op, `remove volume ${vol}`);
    return;
  }
  refuse('target-role', `refusing to touch volume ${vol}: not an Orchard object of a known role`);
}

/** Session-exec authority: only into the lease's own container, carrying the lease's own tag. */
function authorizeLease(leaseId: string, args: readonly string[]): void {
  const l = leases.get(leaseId);
  if (!l) refuse('no-lease', `exec tag ${leaseId} holds no lease`);
  const i = verbAt(args);
  if (args[i] !== 'exec') refuse('lease-scope', `a session may only exec into its container, not docker ${args[i]}`);
  const rest = args.slice(i + 1);
  const pos = positionals(rest, EXEC_FLAGS);
  if (pos[0] !== sessionContainerName(l.projectId)) refuse('lease-scope', `lease ${leaseId} may exec only into ${sessionContainerName(l.projectId)}`);
  {
    const c = inspectContainer(pos[0]!);
    if (c === 'error') refuse('lease-scope', `cannot inspect ${pos[0]} to check whose it is`);
    if (c && !actable(c)) refuse('foreign-owner', `${c.name} belongs to another Orchard instance; lease ${leaseId} may not exec into it`);
  }
  const tag = `${EXEC_TAG_VAR}=${leaseId}`;
  const envTagged = rest.some((a, k) => (a === '--env' || a === '-e') && rest[k + 1] === tag) || rest.includes(`--env=${tag}`);
  if (envTagged) {
    if (l.state === 'draining') refuse('lease-draining', `session ${leaseId} has ended; no new exec under its lease`);
    return;
  }
  // The session's own probe / reap scripts name the tag in their script text.
  if (!rest.some((a) => a.includes(tag))) refuse('lease-scope', `an exec under lease ${leaseId} must carry that tag`);
}

function authorize(args: readonly string[]): MutationGrant {
  const ctx = als.getStore();
  if (!ctx) refuse('outside-authority', `refusing docker ${args.slice(verbAt(args), verbAt(args) + 2).join(' ')}: a docker mutation may only run inside a lifecycle operation (ARCH-022)`);
  if (!lanes.isWriter()) refuse('no-claim', 'refusing docker mutation: this server does not hold its data dir');
  if (ctx.kind === 'lease') {
    authorizeLease(ctx.leaseId, args);
    return { id: recordGrant({ ctx: 'lease', opId: null, projectId: leases.get(ctx.leaseId)?.projectId ?? null, verb: 'exec', target: ctx.leaseId }), settled: () => undefined };
  }
  if (ctx.kind === 'probe') { authorizeProbe(args); return { id: recordGrant({ ctx: 'probe', opId: null, projectId: null, verb: 'exec', target: '' }), settled: () => undefined }; }
  const op = ctx.op;
  if (!op.active) refuse('op-finished', 'refusing docker mutation: its operation has already finished');
  const i = verbAt(args);
  const verb = args[i] ?? '';
  const rest = args.slice(i + 1);
  const imagesOnly = op.projectId === '#images';
  const imageVerb = (v: string, sub?: string) =>
    v === 'rmi' || v === 'tag' || v === 'build' || v === 'load' || v === 'pull' || v === 'commit' || v === 'import' ||
    (v === 'image' && !!sub && ['rm', 'remove', 'prune', 'tag', 'build', 'load', 'pull', 'import'].includes(sub)) ||
    (v === 'buildx' && !!sub && ['build', 'create', 'rm', 'stop', 'prune', 'use'].includes(sub));
  if (imageVerb(verb, rest[0])) {
    if (imagesOnly && !(verb === 'rmi' || (verb === 'image' && ['rm', 'remove', 'prune'].includes(rest[0] ?? '')))) refuse('scope', 'the image-cleanup slot may only remove images');
    // Images are a cache: docker itself refuses to remove one a container uses (no --force anywhere).
    if (rest.includes('--force') || rest.includes('-f') && (verb === 'rmi' || rest[0] === 'rm' || rest[0] === 'remove')) refuse('force-image', 'refusing a forced image removal: it would pull an image out from under a container');
    return grantFor(op, verb, rest[rest.length - 1] ?? '');
  }
  if (imagesOnly) refuse('scope', `the image-cleanup slot cannot run docker ${verb}`);
  switch (verb) {
    case 'container': {
      // `docker container <sub>`: normalise to the top-level verb
      return authorize([...args.slice(0, i), ...rest]);
    }
    case 'rm': case 'stop': case 'kill': case 'restart': case 'pause': case 'unpause': case 'update': {
      const flags = verb === 'stop' || verb === 'restart' ? STOP_FLAGS : verb === 'kill' ? KILL_FLAGS : NO_VALUE;
      const ts = positionals(rest, flags);
      if (!ts.length) refuse('no-target', `docker ${verb} without a target`);
      for (const t of ts) { const c = target(t); if (c) assertContainer(op, c, verb, verb !== 'unpause'); }
      return grantFor(op, verb, ts[0]!);
    }
    case 'rename': {
      const [from, to] = positionals(rest, NO_VALUE);
      if (!from || !to) refuse('no-target', 'docker rename needs two names');
      const c = target(from);
      if (c) assertContainer(op, c, 'rename', true);
      const main = sessionContainerName(op.projectId);
      if (to !== main && to !== `${main}.next`) refuse('wrong-project', `refusing to rename into ${to}: not project ${op.projectId}'s container name`);
      return grantFor(op, verb, from);
    }
    case 'start': {
      const ts = positionals(rest, START_FLAGS);
      for (const t of ts) { const c = target(t); if (c) assertContainer(op, c, verb, false); }
      return grantFor(op, verb, ts[0] ?? '');
    }
    case 'create': case 'run':
      assertCreate(op, rest);
      return grantFor(op, verb, '');
    case 'cp': {
      // INTO a container (a read out is not a mutation): only the CLI layer's never-started build container.
      const pos = positionals(rest, NO_VALUE);
      const dest = pos.find((a) => a.includes(':')) ?? '';
      const c = dest ? target(dest.slice(0, dest.indexOf(':'))) : null;
      if (!c) refuse('no-target', 'docker cp into nothing');
      if (roleOf(c) !== 'rtbuild') refuse('target-role', `refusing to copy into ${c.name}: only a CLI-layer build container may be written this way`);
      assertContainer(op, c, verb, false);
      return grantFor(op, verb, c.id);
    }
    case 'exec': {
      const pos = positionals(rest, EXEC_FLAGS);
      const c = pos[0] ? target(pos[0]) : null;
      if (!c) refuse('no-target', 'docker exec into nothing');
      const role = roleOf(c);
      // An operation execs only into its own builder or validation container; a session exec needs a lease.
      if (role !== 'builder' && role !== 'smoke') refuse('lease-scope', `an operation may not exec into ${c.name}; session execs run under a lease`);
      assertContainer(op, c, verb, false);
      return grantFor(op, verb, c.id);
    }
    case 'network': {
      const sub = rest[0] ?? '';
      const r2 = rest.slice(1);
      if (sub === 'create') {
        const { labels } = labelsOfCreate(r2);
        if (labels['claude-station.project'] !== op.projectId || labels[LABEL_OWNER] !== ownerKey()) refuse('wrong-project', 'a network must be created for this operation\'s project, with this instance\'s owner label');
        return grantFor(op, 'network create', '');
      }
      if (sub === 'connect') {
        const [net, ctr] = positionals(r2, new Set(['--alias', '--ip', '--ip6', '--link', '--link-local-ip', '--driver-opt']));
        if (net) assertNetwork(op, net, false);
        const c = ctr ? target(ctr) : null;
        if (c) assertContainer(op, c, 'network connect', false);
        return grantFor(op, 'network connect', ctr ?? '');
      }
      if (sub === 'disconnect') {
        const [net, ctr] = positionals(r2, NO_VALUE);
        if (net) assertNetwork(op, net, false);
        const c = ctr ? target(ctr) : null;
        if (c) assertContainer(op, c, 'network disconnect', true);
        return grantFor(op, 'network disconnect', ctr ?? '');
      }
      if (sub === 'rm' || sub === 'remove') {
        for (const n of positionals(r2, NO_VALUE)) assertNetwork(op, n, true);
        return grantFor(op, 'network rm', '');
      }
      return refuse('unknown-verb', `refusing docker network ${sub}: not a known lifecycle mutation`);
    }
    case 'volume': {
      const sub = rest[0] ?? '';
      const r2 = rest.slice(1);
      if (sub === 'create') {
        const { labels } = labelsOfCreate(r2);
        const [name] = positionals(r2, new Set(['--label', '-l', '--driver', '-d', '--opt', '-o', '--name']));
        assertVolume(op, name ?? '', true, labels);
        return grantFor(op, 'volume create', '');
      }
      if (sub === 'rm' || sub === 'remove') {
        for (const v of positionals(r2, NO_VALUE)) assertVolume(op, v, false);
        return grantFor(op, 'volume rm', '');
      }
      return refuse('unknown-verb', `refusing docker volume ${sub}: not a known lifecycle mutation`);
    }
    default:
      return refuse('unknown-verb', `refusing docker ${verb}: not a known lifecycle mutation (fail-closed)`);
  }
}

/**
 * Every grant, in order (bounded). The docker child of each mutation carries its id in
 * ORCHARD_DOCKER_GRANT, so a suite's docker shim can prove every mutation that reached the daemon was
 * granted here — a mutation spawned any other way arrives without one.
 */
export interface GrantRecord { id: string; ctx: 'op' | 'lease' | 'probe' | 'authority'; opId: string | null; projectId: string | null; verb: string; target: string; at: number }
const grantLog: GrantRecord[] = [];
let grantSeq = 0;
function recordGrant(r: Omit<GrantRecord, 'id' | 'at'>): string {
  const id = `g${process.pid}-${(++grantSeq).toString(36)}`;
  grantLog.push({ ...r, id, at: Date.now() });
  if (grantLog.length > 5000) grantLog.splice(0, grantLog.length - 5000);
  return id;
}
export function grants(): readonly GrantRecord[] { return grantLog; }
function authorityRaw(verb: string, target: string): string {
  return recordGrant({ ctx: 'authority', opId: null, projectId: null, verb, target });
}

/** Track the mutation until its process exits; an uncertain exit fences the project durably. */
function grantFor(op: Op, verb: string, tgt: string): MutationGrant {
  const id = recordGrant({ ctx: 'op', opId: op.id, projectId: op.projectId, verb, target: tgt });
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  op.inflight.add(p);
  return {
    id,
    settled(uncertain: boolean) {
      if (uncertain) {
        try { writeFence({ key: op.projectId, verb, target: tgt, at: Date.now(), bound: Date.now() + FENCE_BOUND_MS }); }
        catch (e) { console.error(`[lifecycle] could not record an uncertain docker ${verb}: ${(e as Error).message}`); }
      } else {
        // A later CERTAIN completion of the same verb on the same target settles an earlier uncertain one.
        const f = readFence(op.projectId);
        if (f && f.verb === verb && f.target === tgt) clearFence(op.projectId);
      }
      op.inflight.delete(p);
      resolve();
    },
  };
}

/* ------------------------------------------------------------- test boot */

/**
 * For suites that drive the managers in-process: take a REAL claim on the (isolated) data dir and run
 * recovery, exactly as a booting server does. There is no other way to make mutations possible.
 */
export async function bootForTests(): Promise<{ dispose(): void }> {
  if (!lanes.isWriter()) {
    const c = await lanes.claimDataDir({ port: null, waitMs: 5_000 });
    if (!c.ok) throw new LifecycleError('no-claim', `could not claim the data dir for this test: ${c.reason}`);
  }
  await recover();
  return {
    dispose() {
      for (const t of watchers.values()) clearTimeout(t);
      watchers.clear();
    },
  };
}

/** Status for routes and the UI: the declared leases (never inferred). */
export function describe(projectId: string): { leases: Array<Pick<Lease, 'id' | 'state' | 'sessionId' | 'orphan'>>; fenced: boolean } {
  return {
    leases: leasesOf(projectId).map(({ id, state, sessionId, orphan }) => ({ id, state, sessionId, orphan })),
    fenced: !!readFence(projectId),
  };
}
