/**
 * FEAT-200 — container ACCESS REQUESTS: a container session asks for something its container lacks
 * (an env var such as a host database URL, or a port published on this machine's loopback), and the
 * USER approves or rejects it.
 *
 * This module is the typed record and its store. It decides nothing about who may write: the request
 * channel (access-channel.ts) can only `raise`; the user-only decide route in index.ts is the ONLY caller
 * of `decide`, and it applies the change. A record is decided exactly once. The decision is a typed
 * `{ verdict, at, by: 'user' }`, never a parsed answer string.
 *
 * Persistence mirrors decisions.ts (BUG-202): writeAtomic, and a present-but-unreadable store is
 * quarantined, never overwritten as if it were empty.
 */
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';
import { quarantine, readCapped } from './store-io.ts';
import { getProject, incarnationOf, type Project } from './registry.ts';

const MAX_STORE_BYTES = 8 * 1024 * 1024;
/**
 * IV r2 (flood): the inbox is agent-driven, so how much it can add to this store is BOUNDED, and the agent-driven
 * path can never discard what is already here. At most this many undecided requests per session and per project;
 * a raise past either is refused with a reply, and nothing already stored is touched.
 */
export const MAX_PENDING_PER_SESSION = 3;
export const MAX_PENDING_PER_PROJECT = 8;
/** Decided records older than this are pruned on write (pending ones never are). */
const KEEP_DECIDED_MS = 30 * 24 * 60 * 60_000;

/**
 * One requested change. A discriminated union: a later kind (a mount, a sidecar…) is one more arm, and
 * every switch over `kind` is exhaustive, so the compiler names each place that must learn it.
 */
export type AccessChange =
  | { kind: 'env'; key: string; value: string; /** the project's value when raised; null = new key */ previous: string | null }
  | { kind: 'port'; hostIp: '127.0.0.1'; hostPort: number; containerPort: number };

export type AccessVerdict = 'approved' | 'rejected';

export interface AccessDecision {
  verdict: AccessVerdict;
  at: string;
  /** Always 'user': the only writer is the user-only decide route. Stored so the record says it. */
  by: 'user';
  /**
   * FEAT-200 r5 (design review 0a294aac, COMMIT ON SUCCESS). For an approval: false = APPROVED-PENDING — the
   * change is in the project's DESIRED container config (base settings + the overlay of approved-pending
   * records, `desiredAccessOf`) but NOT in the settings; true = COMMITTED — a running container was observed
   * carrying it (drift-clean against desired) and its ops were then folded into the settings. Nothing is ever
   * written to the settings on approval, so nothing is ever reverted. A rejection is written true (terminal).
   * (Records written before r5 with applied:true were written into the settings at approval: committed.)
   */
  applied: boolean;
  /** FEAT-200 r5 — per-project approval order; the overlay folds in this order (last approval wins on a shared key). */
  seq?: number;
  /**
   * FEAT-200 r6 — the project's EDIT VERSIONS (registry `accessEdits`) of exactly the env keys and host ports this
   * request names, read in the same synchronous step as the approval, plus the project's createdAt. While approved-
   * pending, ANY change of one of those versions (a user save that touched the key or port, however it ended)
   * cancels the request (`editsSince`). Absent on rejections and on records approved before r6 (read as all zero).
   */
  basis?: AccessBasis;
}

/** FEAT-200 r6 — see AccessDecision.basis. */
export interface AccessBasis {
  env: Record<string, number>;
  ports: Record<string, number>;
  projectCreatedAt: string | null;
}

/** FEAT-200 r6 — the edit versions a project has now (registry `accessEditsOf`), in the shape `basisFor` reads. */
export interface EditVersions { env: Record<string, number>; ports: Record<string, number> }

/** FEAT-200 r6 — the basis an approval records: the current versions of the keys/ports `changes` name. Pure. */
export function basisFor(changes: AccessChange[], edits: EditVersions, projectCreatedAt: string | null): AccessBasis {
  const b: AccessBasis = { env: {}, ports: {}, projectCreatedAt };
  for (const c of changes) {
    switch (c.kind) {
      case 'env': b.env[c.key] = edits.env[c.key] ?? 0; break;
      case 'port': b.ports[String(c.hostPort)] = edits.ports[String(c.hostPort)] ?? 0; break;
    }
  }
  return b;
}

/**
 * FEAT-200 r6 — what was EDITED since `rec` was approved: each env key / host port it names whose edit version moved,
 * as user-facing names ("env K", "port 127.0.0.1:H"). Empty = nothing it names was touched. Pure; structural (versions), never a comparison of values, so an
 * edit that ends where it started (A→B→A, add-then-delete) still counts.
 */
export function editsSince(rec: AccessRequest, edits: EditVersions): string[] {
  // r8: edits are counted only WITHIN one incarnation. A removed (or removed-and-re-added) project is not an edit; the
  // classifier reads it first (`classify` → 'removed'), so this is only ever asked about the record's own project.
  const b = rec.decision?.basis ?? { env: {}, ports: {}, projectCreatedAt: null };
  const out: string[] = [];
  for (const c of rec.changes) {
    switch (c.kind) {
      case 'env': if ((edits.env[c.key] ?? 0) !== (b.env[c.key] ?? 0)) out.push(`env ${c.key}`); break;
      case 'port': if ((edits.ports[String(c.hostPort)] ?? 0) !== (b.ports[String(c.hostPort)] ?? 0)) out.push(`port ${c.hostIp}:${c.hostPort}`); break;
    }
  }
  return [...new Set(out)];
}

export interface AccessResume {
  /**
   * 'waiting' = approved; the container does not have it yet (nothing to send).
   * 'frozen'  = the message text is fixed (computed once, from the container); not yet in the outbox.
   * 'queued'  = the message is a row in the session's durable outbox (`rowId`); the outbox delivers it.
   * 'undeliverable' = r8: final and NOT sent — the project incarnation it was raised for is gone (removed; its id may
   *                   now name a re-added project) and the session is not running; a closed session is never resumed
   *                   into another project. Terminal; the card says so; the frozen text stays readable there.
   */
  state: 'waiting' | 'frozen' | 'queued' | 'undeliverable';
  at: string;
  text: string | null;
  rowId: string | null;
  error: string | null;
}

export interface AccessRequest {
  id: string;
  projectId: string;
  projectName: string;
  /**
   * FEAT-200 r8 — the INCARNATION of the project it was raised against (registry `incarnationOf`). Bound at raise time;
   * a request is read only against that incarnation (`classify`). Absent on records raised before r8.
   */
  projectIncarnation?: string;
  /** The SDK session id of the requesting session (from the channel's X-Orchard-Session header). */
  sdkSessionId: string;
  reason: string;
  changes: AccessChange[];
  /** Port conflicts found when it was raised (re-checked at approval). Non-empty = approval is refused. */
  conflicts: string[];
  createdAt: string;
  decision: AccessDecision | null;
  resume: AccessResume | null;
  /**
   * FEAT-200 r5 — a TERMINAL approved-but-not-applied outcome: 'refused' = docker refused a host port this request
   * needed when the container was recreated; 'superseded' = the user changed a setting this request touches (or the
   * project stopped using a container) before it was applied. The record left the overlay; the settings were never
   * written for it, so there is nothing to undo. Absent on every other record.
   */
  notApplied?: { reason: string; at: string; cause?: NotAppliedCause; reverted?: string[] };
}

/**
 * Why an approved request was not applied. 'refused' = docker refused a host port it needed; 'superseded' = its project
 * was removed or stopped using a container; 'cancelled' = the user edited a key/port it names after approving it, or
 * pressed Cancel on its card (FEAT-200 r6); 'save-failed' = the container carried it but the settings write failed;
 * 'removed' = r8: the project INCARNATION it was raised for is gone (removed, possibly re-added under the same id) —
 * whether it was ever written there is not claimed, only that it is not in effect (also closes an UNDECIDED record).
 */
export type NotAppliedCause = 'refused' | 'superseded' | 'cancelled' | 'save-failed' | 'removed';

function storeFile(): string {
  return path.join(dataDir(), 'access-requests.json');
}

function readStore(): { records: AccessRequest[]; ok: boolean } {
  const res = readCapped(storeFile(), MAX_STORE_BYTES);
  if (res.kind === 'absent') return { records: [], ok: true };
  if (res.kind !== 'ok') return { records: [], ok: false };
  try {
    const parsed = JSON.parse(res.data);
    return Array.isArray(parsed) ? { records: parsed as AccessRequest[], ok: true } : { records: [], ok: false };
  } catch {
    return { records: [], ok: false };
  }
}

function writeAll(records: AccessRequest[]): void {
  const cutoff = Date.now() - KEEP_DECIDED_MS;
  const kept = records.filter((r) => !r.decision || Date.parse(r.decision.at) >= cutoff || (r.resume?.state !== 'queued'));
  ensureDir(dataDir());
  writeAtomic(storeFile(), JSON.stringify(kept, null, 2));
}

function newId(): string {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A short human line for one change — the card, the resume text and the log all use this one spelling. */
export function describeChange(c: AccessChange): string {
  switch (c.kind) {
    case 'env': return `env ${c.key}=${c.value}${c.previous !== null && c.previous !== c.value ? ` (was ${c.previous})` : ''}`;
    case 'port': return `port ${c.hostIp}:${c.hostPort} → container ${c.containerPort}`;
  }
}

/** What becomes reachable because of one change — shown on the card next to the change itself. */
export function reachOf(c: AccessChange): string {
  switch (c.kind) {
    case 'env': {
      const hosts = [...c.value.matchAll(/host\.docker\.internal(?::(\d+))?/g)].map((m) => `host.docker.internal${m[1] ? `:${m[1]}` : ''}`);
      return hosts.length
        ? `Opens no new network path. The value points at a service on this machine (${[...new Set(hosts)].join(', ')}), which the container can already route to; the variable tells the program to use it.`
        : 'Opens no new network path; the program in the container sees this value.';
    }
    case 'port':
      return `Container port ${c.containerPort} becomes reachable at http://${c.hostIp}:${c.hostPort} from this machine only (loopback), never from the network.`;
  }
}

export function summarise(changes: AccessChange[]): string {
  return changes.map(describeChange).join('; ');
}

export interface RaiseAccessInput {
  projectId: string;
  /** r8 — `incarnationOf(project)` of the project row the request is raised against. */
  projectIncarnation: string;
  projectName: string;
  sdkSessionId: string;
  reason: string;
  changes: AccessChange[];
  conflicts: string[];
}

/**
 * Persist a new PENDING request. Validation is the caller's (the channel); this refuses an empty one, a raise past
 * the pending caps, and ANY raise while the store is unreadable. The raise path is agent-driven, so it never
 * quarantines or overwrites a store it cannot read (IV r2: a flood pushed the store past its read cap and the next
 * raise discarded an approved, unresumed record). Recovering an unreadable store is the server's, at boot
 * (`recoverAccessStoreAtBoot`).
 */
export function raiseAccess(input: RaiseAccessInput): AccessRequest {
  if (!input.changes.length) throw new Error('an access request needs at least one change');
  if (!input.reason.trim()) throw new Error('an access request needs a reason');
  const read = readStore();
  if (!read.ok) throw new AccessStoreError('unreadable', 'Orchard cannot read its access-request store right now, so no request can be raised; nothing was changed. Tell the user.');
  // r8/r10: the caps count requests still WAITING for the user, read through the one classifier: never a record already
  // closed (final: e.g. closed as removed while undecided), never a removed incarnation's leftover. An unreadable
  // registry ('unknown') counts — a cap must not open up because the registry cannot be read.
  const memo: ProjectMemo = new Map();
  const pending = read.records.filter((r) => { if (r.decision) return false; const k = classOf(r, memo).kind; return k === 'undecided' || k === 'unknown'; });
  const mine = pending.filter((r) => r.sdkSessionId === input.sdkSessionId).length;
  if (mine >= MAX_PENDING_PER_SESSION) throw new Error(`this session already has ${mine} access requests waiting for the user (the limit is ${MAX_PENDING_PER_SESSION}); wait for a decision before asking again`);
  const theirs = pending.filter((r) => r.projectId === input.projectId).length;
  if (theirs >= MAX_PENDING_PER_PROJECT) throw new Error(`this project already has ${theirs} access requests waiting for the user (the limit is ${MAX_PENDING_PER_PROJECT}); wait for decisions before asking again`);
  const rec: AccessRequest = {
    id: newId(),
    projectId: input.projectId,
    projectIncarnation: input.projectIncarnation,
    projectName: input.projectName,
    sdkSessionId: input.sdkSessionId,
    reason: input.reason.trim(),
    changes: input.changes,
    conflicts: input.conflicts,
    createdAt: new Date().toISOString(),
    decision: null,
    resume: null,
  };
  read.records.push(rec);
  writeAll(read.records);
  return rec;
}

/**
 * Server boot only (never an agent-driven path): a store that cannot be read is preserved (quarantined, BUG-202)
 * and a fresh one starts, so the server is not stuck refusing every request. Returns where it was kept, or null.
 */
export function recoverAccessStoreAtBoot(): string | null {
  const read = readStore();
  if (read.ok) return null;
  return quarantine(storeFile(), 'access-requests') ?? 'quarantined';
}

export function getAccess(id: string): AccessRequest | null {
  return readStore().records.find((r) => r.id === id) ?? null;
}

export function listAccessForProject(projectId: string): AccessRequest[] {
  return readStore().records.filter((r) => r.projectId === projectId);
}

export function listAccessForSession(sdkSessionId: string): AccessRequest[] {
  return readStore().records.filter((r) => r.sdkSessionId === sdkSessionId);
}

/**
 * Every FINAL record not yet delivered back to its session (the resume checker's delivery worklist): rejected,
 * committed, or closed not-applied (r8: including an UNDECIDED record closed because its project was removed). An
 * approved-PENDING record is not here: it has nothing true to say yet.
 */
export function listUnresumed(): AccessRequest[] {
  return readStore().records.filter((r) => isFinal(r) && r.resume?.state !== 'queued' && r.resume?.state !== 'undeliverable');
}

/* ───────────────────────────── r8: ONE classifier of request state ───────────────────────────── */

/** The registry could not be read: nothing about a request's project is known. */
export const UNREADABLE: unique symbol = Symbol('registry-unreadable');
/** One read of a request's project row: the row, null (no row has this id), or UNREADABLE. */
export type ProjectRead = Project | null | typeof UNREADABLE;
/** Per-call memo of project reads (one registry read per project per pass). */
export type ProjectMemo = Map<string, ProjectRead>;

/** Read a request's project row (memoised). The ONLY place this module reads the registry. */
export function readProject(projectId: string, memo: ProjectMemo = new Map()): ProjectRead {
  if (!memo.has(projectId)) {
    let p: ProjectRead;
    try { p = getProject(projectId); } catch { p = UNREADABLE; }
    memo.set(projectId, p);
  }
  return memo.get(projectId)!;
}

/**
 * Where the record's project incarnation is: 'current' = the row with its id IS the incarnation it was raised for;
 * 'gone' = no row has its id; 'reincarnated' = a row has its id but is a DIFFERENT incarnation (removed and re-added).
 */
export type AccessWhere = 'current' | 'gone' | 'reincarnated';

/**
 * FEAT-200 r8 — the state of one request, derived from the ONE current project record (its incarnation + committed
 * set) and the store's own terminal marks. Pure. EVERY reader of request state goes through this (the commit pass, the
 * overlay, the refusal handler, Cancel, the decide route, the card, the delivery step, the pending cap, and the store
 * writers' own backstops), so no two readers can disagree. Precedence:
 *   unknown   — the registry cannot be read: no mark is written, no message is sent.
 *   final     — the store already holds a terminal outcome (rejected, committed, closed); its frozen text stands.
 *   removed   — the incarnation it was raised for is gone (no row, or the row under its id is another incarnation).
 *               Never committed, overlaid, cancelled, refused or "never written": only "not in effect".
 *   committed — its id is in the row's committed set (written in the same atomic save as its ops).
 *   edited    — approved-pending, and the user edited a key/port it names since approval (same incarnation).
 *   live      — approved-pending, nothing it names was touched. undecided — not decided yet (current incarnation).
 */
export type AccessClass =
  | { kind: 'unknown' }
  | { kind: 'final'; where: AccessWhere }
  | { kind: 'removed'; where: 'gone' | 'reincarnated' }
  | { kind: 'committed' }
  | { kind: 'edited'; touched: string[] }
  | { kind: 'live' }
  | { kind: 'undecided' };

function isFinal(r: AccessRequest): boolean {
  return !!r.notApplied || (!!r.decision && (r.decision.verdict === 'rejected' || r.decision.applied === true));
}

/**
 * Is `p` the incarnation `rec` was raised against? r8 records carry the token. Legacy records (raised before r8): the
 * approval's basis.projectCreatedAt when present; otherwise a request cannot predate its own project (raised before
 * the row was created = raised for an earlier incarnation). Used only by `classify`.
 */
function sameIncarnation(rec: AccessRequest, p: Project): boolean {
  if (rec.projectIncarnation) return rec.projectIncarnation === incarnationOf(p);
  const b = rec.decision?.basis?.projectCreatedAt;
  if (b) return b === p.createdAt;
  return !(rec.createdAt && p.createdAt && rec.createdAt < p.createdAt);
}

export function classify(rec: AccessRequest, p: ProjectRead): AccessClass {
  if (p === UNREADABLE) return { kind: 'unknown' };
  const where: AccessWhere = !p || p.id !== rec.projectId ? 'gone' : sameIncarnation(rec, p) ? 'current' : 'reincarnated';
  if (isFinal(rec)) return { kind: 'final', where };
  if (where !== 'current' || !p) return { kind: 'removed', where: where === 'current' ? 'gone' : where };
  if ((p.accessCommitted ?? []).includes(rec.id)) return { kind: 'committed' };
  if (!rec.decision) return { kind: 'undecided' };
  const touched = editsSince(rec, p.accessEdits ?? { env: {}, ports: {} });
  return touched.length ? { kind: 'edited', touched } : { kind: 'live' };
}

/**
 * FEAT-200 r10 (IV r9 2af93888) — is the request's project incarnation gone (deleted, or replaced by a project re-added
 * under the same id)? Read off the ONE classification, never re-derived: 'removed' for an open record, and a 'final'
 * record whose `where` is not 'current' (its frozen outcome stands in the store, but its project is gone, so the card
 * must say "removed / not sent" — never "open the session", which would resume it inside the re-added project).
 * `classify`'s own precedence (final before removed) is deliberately unchanged: the store writers' backstops rely on a
 * final record never being re-closed.
 */
export function projectGone(c: AccessClass): boolean {
  return c.kind === 'removed' || (c.kind === 'final' && c.where !== 'current');
}

/**
 * FEAT-200 r7/r8/r10 — one record as the card reads it (pure; `accessView` in index.ts adds only the outbox row state
 * and the rebuild wait). ONE classification decides: the settings record owns "committed" (a store mark that has not
 * caught up is shown as committed); a request whose incarnation is gone — open OR already final (r10, IV r9 2af93888) —
 * is shown removed (`projectRemoved`), its own frozen outcome kept, never approvable, never cancellable, never "open the
 * session". `notApplied` cause 'removed' is added for display only when there is no frozen outcome to keep.
 */
export function accessCardView(rec: AccessRequest, cls: AccessClass, delivery: string | null, rebuildOf: (projectId: string) => unknown): Record<string, unknown> {
  const projectRemoved = projectGone(cls);
  if (cls.kind === 'committed' && rec.decision) rec = { ...rec, decision: { ...rec.decision, applied: true } };
  if (projectRemoved && !rec.notApplied && rec.decision?.verdict !== 'rejected') rec = { ...rec, notApplied: { reason: 'its project was removed from Orchard', at: new Date().toISOString(), cause: 'removed' } };
  const waiting = rec.decision?.verdict === 'approved' && rec.resume?.state === 'waiting' && !rec.notApplied;
  return {
    ...rec,
    summary: summarise(rec.changes),
    lines: rec.changes.map((c) => ({ kind: c.kind, change: describeChange(c), reach: reachOf(c) })),
    delivery,
    projectRemoved,
    rebuild: waiting ? (rebuildOf(rec.projectId) ?? null) : null,
    cancellable: !projectRemoved && (cls.kind === 'live' || cls.kind === 'edited'), // r6 Cancel button (r8: same classification)
  };
}

/** `classify` against the request's project as the registry has it now (memoised per call). */
export function classOf(rec: AccessRequest, memo: ProjectMemo = new Map()): AccessClass {
  return classify(rec, readProject(rec.projectId, memo));
}

/**
 * FEAT-200 r7 — WHO OWNS "committed": the project's settings record (registry `accessCommitted`), written in the SAME
 * atomic registry save that folds the request's ops into the settings. r8: read through `classify`. true = committed
 * by the settings record (or already final-committed); false = not; null = the registry cannot be read (unknown — a
 * caller that would claim "not applied" must not act on it).
 */
export function committedInSettings(r: AccessRequest, memo: ProjectMemo = new Map()): boolean | null {
  const c = classOf(r, memo);
  if (c.kind === 'unknown') return null;
  return c.kind === 'committed' || (c.kind === 'final' && r.decision?.verdict === 'approved' && r.decision.applied === true && !r.notApplied);
}

/** The STORE says approved-pending (its own derived mark only). */
function storePending(r: AccessRequest): boolean {
  return r.decision?.verdict === 'approved' && r.decision.applied === false && !r.notApplied;
}

/**
 * FEAT-200 r5/r8 — approved, not applied, not closed, of the CURRENT incarnation and not committed by the settings
 * record: `classify` says live or edited (an edited one is still pending until the commit pass cancels it).
 */
export function isApprovedPending(r: AccessRequest, memo?: ProjectMemo): boolean {
  const k = classOf(r, memo).kind;
  return k === 'live' || k === 'edited';
}

/** FEAT-200 r8 — every record not final yet (undecided, or store-pending): the commit pass's ONE worklist, by project. */
export function listOpen(): AccessRequest[] {
  return readStore().records.filter((r) => !isFinal(r)).sort(bySeq);
}

/**
 * FEAT-200 r7 — the committed set a commit writes: the current ids still worth keeping (their store mark has not
 * landed yet) plus the ids this commit adds. An id leaves only once this store records it committed (or the record is
 * gone), so the set stays small and never drops an unreconciled fact. An unreadable store keeps every current id.
 */
export function committedSetAfter(current: string[], add: string[]): string[] {
  const read = readStore();
  const keep = read.ok
    ? current.filter((id) => { const r = read.records.find((x) => x.id === id); return !!r && storePending(r); })
    : current.slice();
  return [...new Set([...keep, ...add])];
}

function bySeq(a: AccessRequest, b: AccessRequest): number {
  return (a.decision?.seq ?? 0) - (b.decision?.seq ?? 0) || (a.decision?.at ?? '').localeCompare(b.decision?.at ?? '') || a.id.localeCompare(b.id);
}

/** FEAT-200 r5 — approved-pending records (all projects, or one), in approval order (`isApprovedPending`). Unreadable store = none. */
export function listApprovedPending(projectId?: string): AccessRequest[] {
  const memo: ProjectMemo = new Map();
  return readStore().records.filter((r) => (projectId === undefined || r.projectId === projectId) && storePending(r) && isApprovedPending(r, memo)).sort(bySeq);
}

/**
 * FEAT-200 r5/r8 — one project's STORE-pending records in approval order, or null when the store cannot be read. Not
 * classified here: the caller classifies each against the project snapshot it folds onto (`liveFor`).
 */
export function pendingOverlayFor(projectId: string): AccessRequest[] | null {
  const read = readStore();
  if (!read.ok) return null;
  return read.records.filter((r) => r.projectId === projectId && storePending(r)).sort(bySeq);
}

/** Can the overlay be trusted right now? (An unreadable store must not read as "no pending approvals".) */
export function storeReadable(): boolean {
  return readStore().ok;
}

export interface AccessConfig { env: Record<string, string>; ports: Array<{ hostPort: number; containerPort: number }> }

/**
 * FEAT-200 r5 — fold records' ops onto a base config, in the order given: env = set (last wins), ports = set
 * semantics on the host port (a later op mapping the same host port replaces it). Pure. The desired config is
 * `foldAccess(base, listApprovedPending(p))`; a commit is `base := foldAccess(base, pending)` — so a commit can
 * never change the desired config (it is the same fold), and so can never trigger a recreate.
 */
export function foldAccess(base: AccessConfig, recs: AccessRequest[]): AccessConfig {
  const env = { ...base.env };
  const ports = base.ports.map((p) => ({ hostPort: p.hostPort, containerPort: p.containerPort }));
  for (const r of recs) {
    for (const c of r.changes) {
      switch (c.kind) {
        case 'env': env[c.key] = c.value; break;
        case 'port': {
          const i = ports.findIndex((x) => x.hostPort === c.hostPort);
          if (i >= 0) ports[i] = { hostPort: c.hostPort, containerPort: c.containerPort };
          else ports.push({ hostPort: c.hostPort, containerPort: c.containerPort });
          break;
        }
      }
    }
  }
  return { env, ports };
}

export type AccessStoreErrorCode = 'unknown' | 'already-decided' | 'unreadable' | 'project-removed';
export class AccessStoreError extends Error {
  readonly code: AccessStoreErrorCode;
  constructor(code: AccessStoreErrorCode, message: string) { super(message); this.code = code; this.name = 'AccessStoreError'; }
}

/**
 * The USER's decision, written once. An approval becomes APPROVED-PENDING (`applied:false`, next `seq` in the
 * project): it joins the desired container config, and NOTHING is written to the project settings (FEAT-200 r5).
 * A rejection is terminal (`applied:true`). Refuses a second decision (FEAT-164 r2: a replay must not re-apply).
 */
export function beginDecision(id: string, verdict: AccessVerdict, basis?: AccessBasis): AccessRequest {
  const read = readStore();
  if (!read.ok) throw new AccessStoreError('unreadable', 'the access-request store could not be read; nothing was decided');
  const rec = read.records.find((r) => r.id === id);
  if (!rec) throw new AccessStoreError('unknown', `no access request ${id}`);
  if (rec.decision) throw new AccessStoreError('already-decided', `access request ${id} was already ${rec.decision.verdict}; a decision is honoured once`);
  // r8: a request is decided only in the incarnation it was raised for (never approved onto a project re-added under
  // its id); the commit pass closes it as removed. Unknown (registry unreadable) decides nothing.
  const cls = classOf(rec);
  if (cls.kind === 'unknown') throw new AccessStoreError('unreadable', 'the project registry could not be read; nothing was decided');
  if (cls.kind === 'removed' || rec.notApplied?.cause === 'removed') throw new AccessStoreError('project-removed', `access request ${id} was raised for a project that has since been removed from Orchard${cls.kind === 'removed' && cls.where === 'reincarnated' ? ' (a project added later has the same id)' : ''}; it cannot be decided here, and its session is told it is not in effect`);
  if (cls.kind !== 'undecided') throw new AccessStoreError('already-decided', `access request ${id} cannot be decided (it is ${cls.kind})`);
  const at = new Date().toISOString();
  const seq = 1 + Math.max(0, ...read.records.filter((r) => r.projectId === rec.projectId).map((r) => r.decision?.seq ?? 0));
  rec.decision = { verdict, at, by: 'user', applied: verdict === 'rejected', ...(verdict === 'approved' ? { seq, ...(basis ? { basis } : {}) } : {}) };
  rec.resume = { state: 'waiting', at, text: null, rowId: null, error: null };
  writeAll(read.records);
  return rec;
}

/**
 * FEAT-200 r5 — the COMMIT's record step: these approved-pending records were observed in a running container and
 * their ops have ALREADY been folded into the settings. r7: that settings write also named them in the project's
 * committed set (the owner of the fact); this is the derived mark, reconciled from it — a crash or a failed write
 * here leaves them committed-by-settings, and the next pass marks them (`listCommittedUnmarked`), never re-deciding.
 * Freezes each one's message in the same write. Returns the ids marked; a record not store-pending is skipped.
 */
export function markCommitted(texts: Record<string, string>): string[] {
  const read = readStore();
  if (!read.ok) return [];
  const at = new Date().toISOString();
  const done: string[] = [];
  const memo: ProjectMemo = new Map();
  for (const rec of read.records) {
    // r8: only a request the settings record of its OWN incarnation names as committed is marked committed.
    if (!(rec.id in texts) || !storePending(rec) || classOf(rec, memo).kind !== 'committed') continue;
    rec.decision!.applied = true;
    rec.resume = { state: 'frozen', at, text: texts[rec.id]!, rowId: null, error: null };
    done.push(rec.id);
  }
  if (done.length) writeAll(read.records);
  return done;
}

/**
 * FEAT-200 r8 — which classes each not-applied cause may close. 'removed' is the only one that applies to a removed
 * incarnation (and to an undecided record); every "never written" cause needs the current incarnation and no commit.
 */
const MAY_CLOSE: Record<NotAppliedCause, ReadonlyArray<AccessClass['kind']>> = {
  cancelled: ['live', 'edited'],
  refused: ['live'],
  'save-failed': ['live'],
  superseded: ['live', 'edited'],
  removed: ['removed'],
};

/**
 * FEAT-200 r5 — approved-pending records that will NOT be applied (docker refused a port they need, or the user's
 * settings change superseded them): mark terminal and freeze each message, in ONE write. Touches no setting —
 * the record simply leaves the overlay. Returns the ids marked (a record no longer pending is skipped).
 */
export function markNotApplied(items: Array<{ id: string; reason: string; text: string }>, cause: NotAppliedCause): string[] {
  const read = readStore();
  if (!read.ok) return [];
  const at = new Date().toISOString();
  const done: string[] = [];
  const memo: ProjectMemo = new Map();
  for (const it of items) {
    const rec = read.records.find((r) => r.id === it.id);
    // r7/r8: the structural backstop — a cause is written only when the classifier allows it, so no caller can write
    // "never written" over a committed id, over an unknown state, or over a removed project's request.
    if (!rec || !MAY_CLOSE[cause].includes(classOf(rec, memo).kind)) continue;
    rec.notApplied = { reason: it.reason, at, cause };
    rec.resume = { state: 'frozen', at, text: it.text, rowId: null, error: null };
    done.push(rec.id);
  }
  if (done.length) writeAll(read.records);
  return done;
}

/** The resume checker's write. Never moves backwards from 'queued', and a frozen text is never replaced. */
export function noteResume(id: string, patch: Partial<AccessResume>): AccessRequest | null {
  const read = readStore();
  if (!read.ok) return null;
  const rec = read.records.find((r) => r.id === id);
  if (!rec || (!rec.decision && !rec.notApplied)) return null;
  const cur: AccessResume = rec.resume ?? { state: 'waiting', at: new Date().toISOString(), text: null, rowId: null, error: null };
  if ((cur.state === 'queued' || cur.state === 'undeliverable') && patch.state && patch.state !== cur.state) return rec;
  const text = cur.text ?? patch.text ?? null;
  rec.resume = { ...cur, ...patch, text, at: new Date().toISOString() };
  writeAll(read.records);
  return rec;
}
