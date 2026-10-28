/**
 * FEAT-200 — the container-access request CHANNEL (agent → server, raise-only), the port COLLISION check
 * (shared by every writer of `container.ports`), and the RESUME checker (server → requesting session).
 *
 * CHANNEL. A container agent writes one JSON file into the root of its session-history directory, which is
 * bind-mounted into every container (`container-manager.ts` `accessInboxPaths`):
 *
 *     .orchard-access.<sdkSessionId>.<nonce>.json      (write `<name>.tmp`, then `mv` — the reader skips .tmp)
 *     { "reason": "...", "env": { "K": "V" }, "ports": [ { "containerPort": 3000, "hostPort": 3000 } ] }
 *
 * The server polls, raises a PENDING record, deletes the file, and writes a courtesy reply
 * `.orchard-access.<sdkSessionId>.<nonce>.reply`. Nothing on this channel can decide, apply or approve: the
 * poller's only write to state is `raiseAccess`. The authoritative record lives in the data dir, which no
 * container can see.
 *
 * HOSTILE FILES. The directory is agent-writable, so every entry may be a symlink, a FIFO, a device, huge,
 * or half-written. The reader opens O_RDONLY|O_NOFOLLOW|O_NONBLOCK (a symlink fails ELOOP, a FIFO cannot
 * block the server), requires a regular file <= 64 KiB from fstat of the SAME fd, and never echoes file
 * content into a reply. A file that does not parse is retried while it is young (a writer may still be
 * writing — the agent is told to tmp+mv, but the reader does not rely on it) and refused once it is old.
 * The reply is created O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, so it can never overwrite or follow anything.
 * The layout is flat on purpose: the file name is the only path component the agent controls.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import * as acc from './access-requests.ts';
import type { AccessChange, AccessRequest } from './access-requests.ts';
import type { Project, PortPublish } from './registry.ts';
import { incarnationOf } from './registry.ts';

export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ENV_KEYS = 16;
/** A request file that still does not parse after this long is refused (it was not merely mid-write). */
const PARTIAL_GRACE_MS = 5_000;
/** Courtesy replies are removed after this long. */
const REPLY_TTL_MS = 10 * 60_000;

const NAME_RE = /^\.orchard-access\.([A-Za-z0-9][A-Za-z0-9-]{7,63})\.([A-Za-z0-9_-]{1,64})\.json$/;
const REPLY_RE = /^\.orchard-access\.[A-Za-z0-9-]{8,64}\.[A-Za-z0-9_-]{1,64}\.reply$/;

export interface ChannelDeps {
  listContainerProjects(): Project[];
  inboxDirOf(p: Project): string;
  /** True iff `sdkSessionId` names a live session of project `p` (the requester must be running). */
  sessionLive(p: Project, sdkSessionId: string): boolean;
  /** Turn a request body into typed changes; throws with a user-facing reason (same validator as settings). */
  parseChanges(p: Project, body: Record<string, unknown>): AccessChange[];
  portConflicts(p: Project, ports: PortPublish[]): Promise<string[]>;
  onRaised(rec: AccessRequest): void;
  log?(s: string): void;
  now?(): number;
}

function openNoFollow(file: string): number {
  return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
}

/** Read one request file defensively. `null` = skip for now (young and unparseable); throws = refuse it. */
export function readRequestFile(file: string, now: number): { body: Record<string, unknown> } | null {
  let fd: number;
  try { fd = openNoFollow(file); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error('the request file is a symlink; write a regular file');
    if (code === 'ENOENT') return null;
    throw new Error(`the request file could not be opened (${code ?? 'error'})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('the request is not a regular file');
    if (st.size > MAX_REQUEST_BYTES) throw new Error(`the request file is larger than ${MAX_REQUEST_BYTES} bytes`);
    const buf = Buffer.alloc(Math.min(st.size, MAX_REQUEST_BYTES) + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r <= 0) break;
      n += r;
      if (n > MAX_REQUEST_BYTES) throw new Error(`the request file is larger than ${MAX_REQUEST_BYTES} bytes`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(buf.subarray(0, n).toString('utf8')); } catch {
      if (now - st.mtimeMs < PARTIAL_GRACE_MS) return null; // possibly still being written: look again next poll
      throw new Error('the request file is not valid JSON (write it to <name>.tmp, then mv it into place)');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the request must be a JSON object');
    return { body: parsed as Record<string, unknown> };
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

function writeReply(dir: string, base: string, reply: Record<string, unknown>): void {
  const file = path.join(dir, `${base}.reply`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch { return; } // already there, or something the agent planted: never overwrite, never follow
  try { fs.writeSync(fd, `${JSON.stringify(reply, null, 2)}\n`); } catch { /* courtesy only */ } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}

let polling = false;

/** One pass over every container project's inbox. Re-entrancy-safe; never throws. */
export async function pollInboxes(deps: ChannelDeps): Promise<number> {
  if (polling) return 0;
  polling = true;
  let raised = 0;
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? ((s: string) => console.warn(s));
  try {
    let projects: Project[] = [];
    try { projects = deps.listContainerProjects(); } catch { return 0; }
    for (const p of projects) {
      const dir = deps.inboxDirOf(p);
      let names: string[];
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory()) continue;
        names = fs.readdirSync(dir).filter((n) => n.startsWith('.orchard-access.'));
      } catch { continue; }
      for (const name of names) {
        const file = path.join(dir, name);
        if (REPLY_RE.test(name)) {
          try { const st = fs.lstatSync(file); if (now - st.mtimeMs > REPLY_TTL_MS) fs.unlinkSync(file); } catch { /* gone */ }
          continue;
        }
        const m = NAME_RE.exec(name);
        if (!m) continue; // a .tmp being written, or not ours
        const sid = m[1]!;
        const base = name.slice(0, -'.json'.length);
        let reply: Record<string, unknown>;
        try {
          const got = readRequestFile(file, now);
          if (!got) continue;
          if (!deps.sessionLive(p, sid)) throw new Error(`no live session ${sid} in project ${p.name}; name the file with your own $ORCHARD_SESSION`);
          const reason = typeof got.body.reason === 'string' ? got.body.reason.trim() : '';
          if (!reason) throw new Error('"reason" is required: say what you need it for, in one or two sentences');
          if (reason.length > 2000) throw new Error('"reason" is longer than 2000 characters');
          const changes = deps.parseChanges(p, got.body);
          const ports = changes.filter((c): c is Extract<AccessChange, { kind: 'port' }> => c.kind === 'port').map((c) => ({ hostPort: c.hostPort, containerPort: c.containerPort }));
          const conflicts = ports.length ? await deps.portConflicts(p, ports) : [];
          const rec = acc.raiseAccess({ projectId: p.id, projectIncarnation: incarnationOf(p), projectName: p.name, sdkSessionId: sid, reason, changes, conflicts });
          raised++;
          log(`[orchard] FEAT-200: access REQUEST ${rec.id} raised by session ${sid} for project ${p.id} (${p.name}): ${acc.summarise(changes)}${conflicts.length ? ` — CONFLICT: ${conflicts.join('; ')}` : ''}. INERT until the user decides.`);
          deps.onRaised(rec);
          reply = {
            ok: true, id: rec.id, status: 'pending', conflicts,
            message: conflicts.length
              ? `Raised ${rec.id}, but it cannot be approved as asked: ${conflicts.join('; ')}. End your turn now; the user sees the conflict on the card.`
              : `Raised ${rec.id}. The user approves or rejects it on a card. END YOUR TURN NOW. You will be resumed with "access granted: …" once the container has it, or "denied: …".`,
          };
        } catch (err) {
          reply = { ok: false, error: (err as Error).message };
          log(`[orchard] FEAT-200: access request file ${name} in project ${p.id} REFUSED: ${(err as Error).message}`);
        }
        try { fs.unlinkSync(file); } catch { /* gone */ }
        writeReply(dir, base, reply);
      }
    }
  } finally {
    polling = false;
  }
  return raised;
}

/* ───────────────────────────── request body → typed changes ───────────────────────────── */

export interface ParseDeps {
  /** Validates env exactly as the settings PATCH does (throws its message). */
  validateEnv(env: Record<string, unknown>): Record<string, string>;
  validatePorts(ports: unknown): PortPublish[];
  /** The project's BASE settings (what the user set + committed approvals). `previous` is read from here. */
  currentEnv(p: Project): Record<string, string>;
  currentPorts(p: Project): PortPublish[];
  /**
   * FEAT-200 r5 — the DESIRED config (base + approved-pending overlay). A port is checked against it (an approved,
   * not-yet-applied publish already claims its host port); an env var already desired AND set is not a change.
   * Absent = the base (pre-r5 callers).
   */
  desired?(p: Project): { env: Record<string, string>; ports: PortPublish[] };
}

export function parseChanges(p: Project, body: Record<string, unknown>, d: ParseDeps): AccessChange[] {
  for (const k of Object.keys(body)) if (!['reason', 'env', 'ports'].includes(k)) throw new Error(`unknown field "${k}" (a request has "reason", "env" and/or "ports")`);
  const changes: AccessChange[] = [];
  if (body.env != null) {
    if (typeof body.env !== 'object' || Array.isArray(body.env)) throw new Error('"env" must be an object of NAME: "value"');
    if (Object.keys(body.env).length > MAX_ENV_KEYS) throw new Error(`at most ${MAX_ENV_KEYS} env vars per request`);
    const env = d.validateEnv(body.env as Record<string, unknown>);
    const cur = d.currentEnv(p);
    const want = d.desired?.(p).env ?? cur;
    for (const [key, value] of Object.entries(env)) {
      if (cur[key] === value && want[key] === value) continue; // already set exactly so: not a change
      changes.push({ kind: 'env', key, value, previous: Object.prototype.hasOwnProperty.call(cur, key) ? cur[key]! : null });
    }
  }
  if (body.ports != null) {
    if (!Array.isArray(body.ports)) throw new Error('"ports" must be an array of { "containerPort": N, "hostPort": N }');
    // hostPort defaults to containerPort; the host address is never accepted (loopback only).
    const raw = body.ports.map((x) => (x && typeof x === 'object' && !Array.isArray(x) && (x as Record<string, unknown>).hostPort === undefined)
      ? { ...(x as Record<string, unknown>), hostPort: (x as Record<string, unknown>).containerPort } : x);
    const ports = d.validatePorts(raw);
    const cur = d.desired?.(p).ports ?? d.currentPorts(p);
    for (const pp of ports) {
      const same = cur.find((c) => c.hostPort === pp.hostPort);
      if (same && same.containerPort === pp.containerPort) continue;
      if (same) throw new Error(`host port ${pp.hostPort} is already published (or approved to be published) by this project to container port ${same.containerPort}; ask for a different host port`);
      changes.push({ kind: 'port', hostIp: '127.0.0.1', hostPort: pp.hostPort, containerPort: pp.containerPort });
    }
  }
  if (!changes.length) throw new Error('nothing to change: ask for at least one env var or port that the project does not already have');
  return changes;
}

/* ───────────────────────────── port collisions ───────────────────────────── */

export interface ConflictDeps {
  otherProjects(p: Project): Array<{ id: string; name: string; ports: PortPublish[] }>;
  /** Host ports published by containers on the daemon other than this project's own. Throws on docker error. */
  publishedElsewhere(p: Project): Array<{ hostPort: number; hostIp: string; container: string }>;
  /** This project's own running container holds exactly 127.0.0.1:hostPort. */
  ownHolds(p: Project, hostPort: number): boolean;
  hostPortFree(port: number): Promise<{ free: boolean; why?: string }>;
}

/**
 * Every reason `ports` cannot be published for project `p` right now. Run by EVERY writer of
 * `container.ports` (the request channel, the approval, a user PATCH or create). ADVISORY (FEAT-200 r3): docker's
 * own start is the authority — a port taken after this check is refused there, the working container is kept
 * (container-manager `swapContainer`), and the approved request docker refused fails and leaves the desired config (`failRefused`).
 */
export async function findPortConflicts(p: Project, ports: PortPublish[], d: ConflictDeps): Promise<string[]> {
  const out: string[] = [];
  let others: Array<{ id: string; name: string; ports: PortPublish[] }> = [];
  try { others = d.otherProjects(p); } catch (err) { out.push(`could not read the other projects' ports (${(err as Error).message})`); }
  let elsewhere: Array<{ hostPort: number; hostIp: string; container: string }> | null = null;
  try { elsewhere = d.publishedElsewhere(p); } catch (err) { out.push(`could not ask Docker which ports are in use (${(err as Error).message.split('\n')[0]}), so no port can be approved right now`); }
  for (const pp of ports) {
    const owner = others.find((o) => o.ports.some((x) => x.hostPort === pp.hostPort));
    if (owner) { out.push(`host port ${pp.hostPort} is already published by project “${owner.name}”`); continue; }
    const c = elsewhere?.find((x) => x.hostPort === pp.hostPort);
    if (c) { out.push(`host port ${pp.hostPort} is already published by container ${c.container}`); continue; }
    if (d.ownHolds(p, pp.hostPort)) continue; // this project's own container already holds exactly this binding
    const probe = await d.hostPortFree(pp.hostPort);
    if (!probe.free) out.push(`host port ${pp.hostPort} is already in use on this machine${probe.why ? ` (${probe.why})` : ''}`);
  }
  return out;
}

function probeBind(host: string, port: number): Promise<{ free: boolean; code?: string }> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve({ free: false, code: err.code ?? err.message }));
    srv.listen({ host, port, exclusive: true, ...(host.includes(':') ? { ipv6Only: true } : {}) }, () => srv.close(() => resolve({ free: true })));
  });
}

/**
 * Is host port `port` free on BOTH loopback addresses right now? Loopback is two addresses (FEAT-200 IV r2, the
 * IPv6 door): a program listening only on [::1]:port is not seen by a 127.0.0.1 bind, yet `localhost:port` on this
 * machine may reach it instead of the container. A host without IPv6 loopback (EADDRNOTAVAIL / EAFNOSUPPORT) has
 * no such door. ADVISORY like every pre-check: docker's start is the authority for 127.0.0.1, and a [::1] listener
 * that appears after the publish is the named residual (the granted text says "use 127.0.0.1, not localhost").
 */
export async function hostPortFree(port: number): Promise<{ free: boolean; why?: string }> {
  const v4 = await probeBind('127.0.0.1', port);
  if (!v4.free) return { free: false, why: v4.code === 'EADDRINUSE' ? 'something is listening on it' : v4.code };
  const v6 = await probeBind('::1', port);
  if (!v6.free && v6.code !== 'EADDRNOTAVAIL' && v6.code !== 'EAFNOSUPPORT') {
    return { free: false, why: v6.code === 'EADDRINUSE' ? 'something is listening on [::1] (IPv6 loopback), so localhost could reach it instead of the container' : `[::1]: ${v6.code}` };
  }
  return { free: true };
}

/* ───────────────────────────── commit on success, resume on decision ───────────────────────────── */
/*
 * FEAT-200 r5 — COMMIT ON SUCCESS (independent design review 0a294aac, after the revert property broke in r3 and r4
 * through four doors: a shared env key, a shared host port, stale provenance after a user delete, chained refusals).
 * The old shape wrote the settings on approval and, when docker refused, tried to REVERT one request's share of
 * settings several requests had written — a value in shared settings has no owner and `previous` goes stale, so every
 * compare-and-set guess leaked. Now:
 *
 *   desired(p)  = foldAccess(base settings, approved-pending records in approval order)   (container-manager reads it)
 *   approve     = record approved-pending. The settings are NOT written.
 *   commit      = once a RUNNING container is drift-clean against desired, fold every pending record into the base
 *                 settings (settings first, then mark committed) — desired is unchanged by construction, so no recreate.
 *   refusal     = the records needing a refused host port are marked failed and leave the overlay. NOTHING in the
 *                 settings is touched, so there is nothing to undo, and a user edit can never be overwritten.
 *   user edit   = (r6) any settings write that CHANGES a key or host port a pending request names bumps that key's
 *                 edit version (registry `accessEdits`, stamped by updateProject in the same atomic save); the
 *                 request recorded those versions at approval, so it is no longer live (`liveFor`: out of the
 *                 overlay at once) and the commit pass below CANCELS it ("cancelled: the user edited …"). Structural,
 *                 never by value: K old→new→old or add-then-delete still cancels. Decided here only — the save route
 *                 writes the settings and nothing else.
 *
 * Base settings therefore have exactly two writers: the user, and the commit of approvals a running container was
 * seen to carry. Final settings = the user's edits + the committed approvals in approval order (last wins on a key).
 */

export interface ResumeDeps {
  getProject(id: string): Project | null;
  /** The FEAT-175 reconciler's level read: does the running container match the project's DESIRED env/ports? */
  accessDriftOf(p: Project): 'clean' | 'stale' | 'unknown';
  /**
   * The reconciler's phase for the project (null = nothing pending). While it is non-null the container is about
   * to be, or is being, recreated — a remove→create window reads as "no container" — so an approval waits.
   */
  rebuildPhaseOf(p: Project): string | null;
  /** What the RUNNING container carries (null = none running / unreadable). */
  liveAccessOf(p: Project): { env: string[]; ports: string[] } | null;
  /**
   * FEAT-200 r5 — fold these approved-pending records' ops into the project's BASE settings (current settings, re-read;
   * ops not a snapshot) and write them. Throws when it cannot (the records then stay pending; nothing is lost).
   * r7: the write is `commitPlanFor(...)` in ONE registry save, so it also names them in the committed set.
   */
  commitBase(p: Project, recs: AccessRequest[]): void;
  /** Put `text` in the session's durable outbox under `nonce`; returns the row id. Throws when it cannot. */
  enqueue(rec: AccessRequest, nonce: string, text: string): string;
  /**
   * FEAT-200 r3 — create (or start) the project's container when NONE is running, inside its slot; a running one
   * or any lease means "do nothing". It is built from the desired config, so a refused port there fails its record.
   */
  ensureNotRunning?(p: Project): Promise<unknown>;
  /** Run the checker again (after an ensure finished). */
  kick?(): void;
  /**
   * FEAT-200 r8 — is the requesting session running right now? Asked only for a record whose project incarnation is
   * gone (removed, perhaps re-added under the same id): its message is sent only to a running session, never by
   * resuming a closed one into another project. Absent = not running.
   */
  sessionLive?(rec: AccessRequest): boolean;
  /**
   * FEAT-200 r8 — withdraw the message under `nonce` from the session's outbox (or reserve the nonce as withdrawn when
   * there is none), so it is never sent. Returns the outbox row's state afterwards: 'discarded' = it will never be sent;
   * anything else = it was already sent / is being sent (it cannot be withdrawn). Absent = nothing was ever queued.
   */
  withdraw?(rec: AccessRequest, nonce: string, text: string): { state: string; rowId: string };
  log?(s: string): void;
}

/** FEAT-200 r3/r5 — the requester's message when docker refused a host port the approved change needed. */
export function notAppliedTextFor(rec: AccessRequest, reason: string): string {
  const what = acc.summarise(rec.changes);
  return `[station] Container access request ${rec.id} was approved, but could not be applied: ${reason}. None of it was applied: the project's container runs without ${what} (a container that was running before was kept as it was), and it was never written to the project settings. If you still need it, raise a new request (for a port, choose a different host port) or ask the user.`;
}

/** FEAT-200 r6 — the requester's message when the USER cancelled the approved change before it was applied (an edit of a key/port it names, or Cancel on its card). */
export function cancelledTextFor(rec: AccessRequest, reason: string): string {
  const what = acc.summarise(rec.changes);
  return `[station] Container access request ${rec.id} (${what}) was cancelled: ${reason}. None of it was applied, and it was never written to the project settings; the user's own setting stands. Ask the user before relying on it, or raise a new request.`;
}

/** FEAT-200 r6 — the requester's message when the container carried the change but writing it to the project settings failed. */
export function saveFailedTextFor(rec: AccessRequest, reason: string): string {
  const what = acc.summarise(rec.changes);
  return `[station] Container access request ${rec.id} (${what}) was approved, but could not be saved: ${reason}. It is not in the project settings, so the container is rebuilt without it once no session is working; do not rely on it. Tell the user, or raise the request again.`;
}

/**
 * FEAT-200 r7/r8 — the project INCARNATION the request was raised for is gone (removed; possibly re-added under the same
 * id, which is a different project). Whether a commit ever landed there is not claimed — only what is true now.
 */
export function projectRemovedTextFor(rec: AccessRequest): string {
  const what = acc.summarise(rec.changes);
  if (!rec.decision) return `[station] Container access request ${rec.id} (${what}) was not decided: its project was removed from Orchard, so it is not in effect. Ask the user before relying on it, or raise a new request.`;
  return `[station] Container access request ${rec.id} (${what}) was approved, but its project was removed from Orchard, so it is not in effect. Ask the user before relying on it, or raise a new request.`;
}

/** FEAT-200 r7 — a request committed to the settings of a project that has since stopped using a container. */
export function committedNoContainerTextFor(rec: AccessRequest, p: Project): string {
  const what = acc.summarise(rec.changes);
  return `[station] Container access request ${rec.id} (${what}) was approved and saved to the project settings, but project ${p.name} no longer runs in a container, so it is not in effect. Ask the user before relying on it.`;
}

/** FEAT-200 r6 — the user's reason line for an edit of named keys/ports after approving. */
export function editedReason(touched: string[]): string {
  return `the user edited ${touched.join(', ')} in the project settings after approving it`;
}

/** FEAT-200 r5 — the requester's message when its project was removed or stopped using a container before it was applied. */
export function supersededTextFor(rec: AccessRequest, reason: string): string {
  const what = acc.summarise(rec.changes);
  return `[station] Container access request ${rec.id} (${what}) was approved, but superseded before it was applied: ${reason}. None of it was applied. Ask the user before relying on it, or raise a new request.`;
}

const LOOPBACK_HINT = ' Reach a published port at 127.0.0.1:<host port> on the host, not localhost.';

/**
 * The frozen message for a FINAL record. A committed approval is described from what the running container carries;
 * `laterSet` names env keys a LATER approval in the same commit set to another value (last approval wins).
 */
export function resumeTextFor(rec: AccessRequest, p: Project | null, live: { env: string[]; ports: string[] } | null, laterSet: Record<string, string> = {}): string {
  const what = acc.summarise(rec.changes);
  if (rec.notApplied) {
    switch (rec.notApplied.cause) {
      case 'superseded': return supersededTextFor(rec, rec.notApplied.reason);
      case 'cancelled': return cancelledTextFor(rec, rec.notApplied.reason);
      case 'save-failed': return saveFailedTextFor(rec, rec.notApplied.reason);
      default: return notAppliedTextFor(rec, rec.notApplied.reason);
    }
  }
  if (rec.decision?.verdict === 'rejected') {
    return `[station] denied: ${what}. The user rejected container access request ${rec.id}; nothing was changed. Continue without it, or ask the user how they want to proceed.`;
  }
  if (!p) return projectRemovedTextFor(rec); // r8: never "Nothing was applied" — a commit may have landed in the removed project
  if (!live) return `[station] Container access request ${rec.id} (${what}) was approved; Orchard could not read the container to confirm it. Check before relying on it.`;
  const overridden = rec.changes.filter((c) => c.kind === 'env' && c.key in laterSet && laterSet[c.key] !== c.value);
  const missing = rec.changes.filter((c) => !overridden.includes(c) && (c.kind === 'env'
    ? !live.env.includes(`${c.key}=${c.value}`)
    : !live.ports.includes(`${c.hostIp}:${c.hostPort}->${c.containerPort}/tcp`)));
  const note = overridden.length
    ? ` Note: ${overridden.map((c) => (c.kind === 'env' ? `${c.key} is now ${JSON.stringify(laterSet[c.key])}, set by a later approved request` : '')).join('; ')}.`
    : '';
  if (!missing.length) return `[station] access granted: ${what}, continue. The container was rebuilt with it.${note}${rec.changes.some((c) => c.kind === 'port') ? LOOPBACK_HINT : ''}`;
  const kept = rec.changes.filter((c) => !missing.includes(c) && !overridden.includes(c));
  return `[station] Container access request ${rec.id} was approved, but ${missing.map(acc.describeChange).join('; ')} ${missing.length === 1 ? 'is' : 'are'} not in the container now.${kept.length ? ` In place: ${kept.map(acc.describeChange).join('; ')}.` : ''}${note} Ask the user before relying on the missing part.`;
}

let checking = false;

/** FEAT-200 r3 — the create-only ensure per project: one in flight, backed off after a failure (never a hot loop). */
const creating = new Map<string, { inFlight: boolean; attempts: number; nextAt: number; error: string | null }>();
const CREATE_BACKOFF_MS = [5_000, 30_000, 60_000, 120_000, 300_000];
function startCreate(p: Project, deps: ResumeDeps, log: (s: string) => void): string {
  const now = Date.now();
  const st = creating.get(p.id) ?? { inFlight: false, attempts: 0, nextAt: 0, error: null };
  creating.set(p.id, st);
  if (st.inFlight) return 'waiting: creating the container';
  if (now < st.nextAt) return st.error ? `waiting: could not create the container yet (${st.error}); retrying` : 'waiting: no running container yet';
  st.inFlight = true;
  void Promise.resolve().then(() => deps.ensureNotRunning!(p)).then(
    () => { st.inFlight = false; st.error = null; st.attempts = 0; st.nextAt = Date.now() + 2_000; },
    (err: unknown) => {
      st.inFlight = false;
      st.error = (err as Error).message.split('\n')[0]!.slice(0, 300);
      st.nextAt = Date.now() + CREATE_BACKOFF_MS[Math.min(st.attempts, CREATE_BACKOFF_MS.length - 1)]!;
      st.attempts++;
      log(`[orchard] FEAT-200: could not create ${p.name}'s container for an approved access request: ${st.error}`);
    },
  ).finally(() => { try { deps.kick?.(); } catch { /* the timer runs the checker anyway */ } });
  return 'waiting: creating the container';
}

/* ───────────────────────────── docker refused an approved change ───────────────────────────── */

export interface Refusal {
  projectId: string;
  /** Host ports the attempt ADDED (not on the previous container) that docker refused. */
  refused: Array<{ hostPort: number; containerPort: number }>;
  reason: string;
}

/**
 * FEAT-200 r5 — docker refused host port(s) a recreate added. Every APPROVED-PENDING record of the project with a
 * port op on a refused host port is marked failed ("approved, but could not be applied: <docker's reason>") and so
 * leaves the overlay. NOTHING is written to the settings. `basePorts` = the host ports in the project's base
 * settings (the user's own): a refused one of those is not any request's, so retrying cannot help.
 * Returns 'retry' iff at least one record failed and no refused port is in the base; else 'stop'. Never throws.
 */
export function failRefused(r: Refusal, basePorts: number[], log: (s: string) => void = (s) => console.warn(s), p: Project | null = null): 'retry' | 'stop' {
  try {
    const hosts = new Set(r.refused.map((x) => x.hostPort));
    // r6: a request the user's edit already cancelled (not live) was not in the attempt; the commit pass tells it why.
    // r8: only LIVE records (`classify`, via liveFor against the snapshot when given; markNotApplied re-classifies each
    // against the registry anyway, and 'refused' may close only a live record of the current incarnation).
    const owners = acc.listApprovedPending(r.projectId).filter((rec) => (!p || liveFor(rec, p)) && rec.changes.some((c) => c.kind === 'port' && hosts.has(c.hostPort)));
    const failed = acc.markNotApplied(owners.map((rec) => ({ id: rec.id, reason: r.reason, text: notAppliedTextFor(rec, r.reason) })), 'refused');
    for (const id of failed) {
      const rec = owners.find((x) => x.id === id)!;
      log(`[orchard] FEAT-200: approved access request ${id} for project ${r.projectId} could not be applied: docker refused (${r.reason}); it leaves the desired config (nothing in the settings to undo) and session ${rec.sdkSessionId} is told`);
    }
    const inBase = r.refused.filter((x) => basePorts.includes(x.hostPort));
    if (inBase.length) userPortRefusals.set(r.projectId, { ports: inBase.map((x) => x.hostPort), reason: r.reason, at: new Date().toISOString() });
    if (inBase.length) log(`[orchard] FEAT-200: project ${r.projectId}: host port(s) ${inBase.map((x) => x.hostPort).join(', ')} set in the project settings were refused by docker (${r.reason}); the settings are left as the user set them and the previous container is kept — change the port in the project settings.`);
    return failed.length > 0 && inBase.length === 0 ? 'retry' : 'stop';
  } catch (err) {
    log(`[orchard] FEAT-200: could not record a refused access change for project ${r.projectId}: ${(err as Error).message}`);
    return 'stop';
  }
}

/* ───────────────────────────── the user's edits win (r6) ───────────────────────────── */

/**
 * FEAT-200 r6 — is this approved-pending record still LIVE against `p` (the project snapshot whose base settings it is
 * folded onto)? No: the user (any settings write but the commit) changed an env key or host port it names since the
 * approval, by edit version — or the project was removed and re-added. ONE predicate, read by the overlay (so a
 * cancelled request leaves the desired config at once), the refusal handler, and the commit pass (which writes the
 * cancellation). Pure.
 */
export function liveFor(rec: AccessRequest, p: Project): boolean {
  // r8: the one classifier — not committed, same incarnation, nothing it names edited.
  return acc.classify(rec, p).kind === 'live';
}

/**
 * FEAT-200 r7 — THE commit write, built in one place (index.ts commitBase writes exactly this, in ONE registry save
 * with `{ accessCommit: true, committed }`): the records' ops folded onto the CURRENT base settings (re-read by the
 * caller; ops, not a snapshot, so a user edit made since is kept) AND the project's committed set naming them. So
 * "R's ops are in the settings" and "R is committed" are one atomic fact; no crash or failed store write between two
 * writes can separate them, because there is no second write that decides it.
 */
export function commitPlanFor(base: acc.AccessConfig, currentCommitted: string[], recs: AccessRequest[]): acc.AccessConfig & { committed: string[] } {
  const f = acc.foldAccess(base, recs);
  return { env: f.env, ports: f.ports, committed: acc.committedSetAfter(currentCommitted, recs.map((r) => r.id)) };
}

/**
 * FEAT-200 r6 — the desired-config overlay hook body (index.ts → container-manager `setAccessOverlay`): base folded
 * with the project's LIVE approved-pending records in approval order. An unreadable store THROWS (never "no
 * overlay": a container already carrying an approved change would read as drifted and be recreated without it).
 */
export function overlayFor(p: Project, base: acc.AccessConfig): acc.AccessConfig {
  const recs = acc.pendingOverlayFor(p.id);
  if (recs === null) throw new Error('the access-request store cannot be read, so the desired container access config is unknown');
  const live = recs.filter((rec) => liveFor(rec, p));
  return live.length ? acc.foldAccess(base, live) : base;
}

/**
 * FEAT-200 r11 — the decide route's (approve AND reject) record-state refusal, as ONE function so the standing text
 * property (scripts/verify-feat-200-text-property.mjs) drives it in every end state. Texts unchanged from r8: a decided
 * request is honoured once; a request raised for a removed incarnation (open, or already closed as removed) is never
 * decided here. null = the route goes on to its approve gates / beginDecision (which re-checks synchronously).
 */
export function decideRefusal(rec: AccessRequest): { code: 'already-decided' | 'project-removed'; error: string } | null {
  if (rec.decision) return { code: 'already-decided', error: `access request ${rec.id} was already ${rec.decision.verdict}; a decision is honoured once` };
  if (acc.classOf(rec).kind === 'removed' || rec.notApplied?.cause === 'removed') return { code: 'project-removed', error: `access request ${rec.id} was raised for a project that has since been removed from Orchard; a project added later has the same id. It cannot be approved here; its session is told it is not in effect.` };
  return null;
}

/**
 * FEAT-200 r6 — the user's Cancel on an approved-pending request's card. Synchronous (nothing can interleave a commit
 * between the check and the write); a record already committed or decided otherwise is refused, never re-opened.
 */
export function cancelByUser(id: string, projectId: string): { ok: true; rec: AccessRequest } | { ok: false; code: 'unknown' | 'not-pending' | 'unreadable' | 'project-removed'; error: string } {
  if (!acc.storeReadable()) return { ok: false, code: 'unreadable', error: 'the access-request store cannot be read right now; nothing was cancelled' };
  const rec = acc.getAccess(id);
  if (!rec || rec.projectId !== projectId) return { ok: false, code: 'unknown', error: `no access request ${id} in project ${projectId}` };
  // r8: classified ONCE, by the one classifier. A removed incarnation's request is never "cancelled … never written"
  // (the commit pass closes it as removed); an unknown state cancels nothing.
  const cls = acc.classOf(rec);
  if (cls.kind === 'unknown') return { ok: false, code: 'unreadable', error: 'the project registry cannot be read right now; nothing was cancelled' };
  // r11 (IV r10 ee013774): "gone" is read off the same classification BEFORE finality (acc.projectGone), as the card and
  // the decide route do — a request already final when its project was removed or replaced (closed as removed while
  // undecided, or committed into the removed incarnation) never reads "reject it instead" (reject is refused) nor
  // "already applied to the container and saved" (not true of a project re-added under the same id).
  if (acc.projectGone(cls)) return { ok: false, code: 'project-removed', error: `access request ${id} was made for a project that has since been removed from Orchard; it is not in effect, and there is nothing to cancel here` };
  if (cls.kind !== 'live' && cls.kind !== 'edited') {
    const state = !rec.decision ? 'not decided yet (reject it instead)' : rec.decision.verdict === 'rejected' ? 'rejected' : rec.notApplied ? `already closed (${rec.notApplied.cause ?? 'refused'})` : 'already applied to the container and saved';
    return { ok: false, code: 'not-pending', error: `access request ${id} cannot be cancelled: it is ${state}` };
  }
  const reason = 'the user cancelled it after approving it, before it was applied';
  const done = acc.markNotApplied([{ id, reason, text: cancelledTextFor(rec, reason) }], 'cancelled');
  if (!done.length) return { ok: false, code: 'not-pending', error: `access request ${id} could not be cancelled (its state changed)` };
  return { ok: true, rec: acc.getAccess(id) ?? rec };
}

/**
 * FEAT-200 r6 — host ports the USER set in the project settings that docker refused (kept there by design: the r5
 * review ruled that removing them is the same bug class). Made VISIBLE: the drawer and the container status show
 * docker's reason. Level-filtered on read: a port no longer in the settings, or now published by the running
 * container, is not reported.
 */
const userPortRefusals = new Map<string, { ports: number[]; reason: string; at: string }>();
export function userPortRefusalOf(p: Project, basePorts: number[], livePorts: () => string[] | null): { ports: number[]; reason: string; at: string } | null {
  const r = userPortRefusals.get(p.id);
  if (!r) return null;
  const live = livePorts() ?? [];
  const ports = r.ports.filter((h) => basePorts.includes(h) && !live.some((s) => s.startsWith(`127.0.0.1:${h}->`)));
  if (!ports.length) { userPortRefusals.delete(p.id); return null; }
  return { ...r, ports };
}

/**
 * LEVEL-based, never edge. Each pass:
 *  1. COMMIT: for each project with approved-pending records, once no rebuild is pending and a RUNNING container is
 *     drift-clean against the desired config (base + overlay), fold every pending record into the base settings,
 *     then mark them committed with their frozen message (computed from what the container carries). With no running
 *     container, a create-only ensure builds one from the desired config first (a refused port there fails its record).
 *  2. DELIVER: every final, undelivered record's frozen message goes to the session's durable outbox (nonce
 *     `access-<id>`; the outbox refuses a changed payload under one nonce, so a retry re-uses the same text).
 */
/** r8 — the project read for the classifier: a registry that cannot be read is UNREADABLE (classified unknown), never "removed". */
function projectVia(deps: ResumeDeps, id: string): acc.ProjectRead {
  try { return deps.getProject(id); } catch { return acc.UNREADABLE; }
}

export function checkResumes(deps: ResumeDeps): void {
  if (checking) return;
  checking = true;
  const log = deps.log ?? ((s: string) => console.warn(s));
  try {
    // r8: ONE worklist (every record not final yet), each record classified ONCE against the ONE current project record
    // by `acc.classify` — committed / removed / edited / live are never decided anywhere else.
    const byProject = new Map<string, AccessRequest[]>();
    for (const rec of acc.listOpen()) byProject.set(rec.projectId, [...(byProject.get(rec.projectId) ?? []), rec]);
    for (const [pid, open] of byProject) {
      try {
        const p0 = projectVia(deps, pid);
        if (p0 === acc.UNREADABLE) continue; // unknown: no mark, no message
        const cls = new Map(open.map((rec) => [rec.id, acc.classify(rec, p0)] as const));
        const of = (k: acc.AccessClass['kind']) => open.filter((rec) => cls.get(rec.id)!.kind === k);
        // REMOVED: the incarnation it was raised for is gone (no row, or a re-added row under the same id). Whether a
        // commit ever landed in the removed project is not claimed: "not in effect" — true of both — never "cancelled",
        // "None of it was applied" or "never written". Closes undecided records too (they can no longer be decided).
        const removed = of('removed');
        if (removed.length) {
          const done = acc.markNotApplied(removed.map((rec) => ({ id: rec.id, reason: 'its project was removed from Orchard', text: projectRemovedTextFor(rec) })), 'removed');
          if (done.length) log(`[orchard] FEAT-200: access request(s) ${done.join(', ')} of project ${pid} closed: the project they were raised for was removed${p0 ? ' (a project added later has the same id; nothing carries over)' : ''}`);
        }
        let recs = of('live');
        const edited = of('edited');
        const already = of('committed'); // committed by the settings record, store mark lost: reconciled, never re-decided
        if (!p0 || (!recs.length && !edited.length && !already.length)) continue;
        const p = p0;
        if (p.isolation !== 'container') {
          const reason = `project ${p.name} no longer uses a container`;
          const pend = [...recs, ...edited];
          if (pend.length) acc.markNotApplied(pend.map((rec) => ({ id: rec.id, reason, text: supersededTextFor(rec, reason) })), 'superseded');
          // r7: committed by the settings record — say so (it IS in the settings), never "None of it was applied".
          if (already.length) acc.markCommitted(Object.fromEntries(already.map((rec) => [rec.id, committedNoContainerTextFor(rec, p)])));
          continue;
        }
        // r6: the user's edit wins. A request whose named keys/ports were edited since approval (same incarnation) is
        // CANCELLED here, in the same synchronous pass that commits the rest.
        if (edited.length) {
          const cancelled = edited.map((rec) => {
            const c = cls.get(rec.id)!;
            const reason = editedReason(c.kind === 'edited' ? c.touched : []);
            return { id: rec.id, reason, text: cancelledTextFor(rec, reason) };
          });
          const done = acc.markNotApplied(cancelled, 'cancelled');
          if (done.length) log(`[orchard] FEAT-200: approved-pending access request(s) ${done.join(', ')} for project ${p.id} CANCELLED: ${cancelled.map((x) => x.reason).join(' | ')}`);
        }
        if (!recs.length && !already.length) continue;
        const note = (why: string) => { for (const rec of [...already, ...recs]) if (rec.resume?.error !== why) acc.noteResume(rec.id, { state: 'waiting', error: why }); };
        const phase = deps.rebuildPhaseOf(p);
        const drift = phase ? `rebuild ${phase}` : deps.accessDriftOf(p);
        if (drift !== 'clean') { note(`waiting: ${drift}`); continue; }
        const live = deps.liveAccessOf(p);
        if (!live) {
          note(deps.ensureNotRunning ? startCreate(p, deps, log) : 'waiting: no running container yet');
          continue;
        }
        // A running container carries the desired config: commit. r7: the settings write names the records in the
        // committed set (same atomic save). Whatever happens after it — a throw, a crash, a failed store write — the
        // records are RE-CLASSIFIED against the re-read settings record; that is the only answer to "committed?".
        let committed = already;
        if (recs.length) {
          let failure: unknown = null;
          try { deps.commitBase(p, recs); } catch (err) { failure = err; }
          const after = projectVia(deps, p.id);
          const k = (rec: AccessRequest) => acc.classify(rec, after).kind;
          const inSet = recs.filter((rec) => k(rec) === 'committed');
          const notIn = recs.filter((rec) => k(rec) === 'live');
          if (failure && notIn.length) {
            const reason = `writing the project settings failed (${(failure as Error).message.split('\n')[0]!.slice(0, 300)})`;
            const done = acc.markNotApplied(notIn.map((rec) => ({ id: rec.id, reason, text: saveFailedTextFor(rec, reason) })), 'save-failed');
            log(`[orchard] FEAT-200: approved access request(s) ${done.join(', ')} for project ${p.id} were in the container but could not be saved: ${reason}`);
          } else if (notIn.length) {
            // A commit write that returned without naming them: nothing is claimed either way; the next pass looks again.
            log(`[orchard] FEAT-200: the settings write for project ${p.id} did not record access request(s) ${notIn.map((r) => r.id).join(', ')} as committed; they stay pending`);
          }
          if (failure && inSet.length) log(`[orchard] FEAT-200: the settings write for project ${p.id} landed (it names ${inSet.map((r) => r.id).join(', ')} as committed) but reported: ${(failure as Error).message.split('\n')[0]}`);
          committed = [...already, ...inSet];
        }
        if (!committed.length) continue;
        committed = committed.slice().sort((a, b) => (a.decision?.seq ?? 0) - (b.decision?.seq ?? 0));
        const texts: Record<string, string> = {};
        committed.forEach((rec, i) => {
          const laterSet: Record<string, string> = {};
          for (const later of committed.slice(i + 1)) for (const c of later.changes) if (c.kind === 'env') laterSet[c.key] = c.value;
          texts[rec.id] = resumeTextFor(rec, p, live, laterSet);
        });
        const done = acc.markCommitted(texts);
        if (done.length) log(`[orchard] FEAT-200: approved access request(s) ${done.join(', ')} for project ${p.id} are in its running container; committed to the project settings`);
      } catch (err) {
        log(`[orchard] FEAT-200: commit check for project ${pid} failed: ${(err as Error).message}`);
      }
    }
    for (const rec of acc.listUnresumed()) {
      // r8: classified like everything else. Unknown (registry unreadable) sends nothing this pass.
      const p = projectVia(deps, rec.projectId);
      const cls = acc.classify(rec, p);
      if (cls.kind === 'unknown' || p === acc.UNREADABLE) continue;
      const where = cls.kind === 'final' ? cls.where : 'current';
      let text = rec.resume?.state === 'frozen' ? rec.resume.text : null;
      if (!text) {
        // A rejection (or a pre-r5 committed record): nothing to read from a container. A removed incarnation's
        // record is never read against the row that took its id.
        text = resumeTextFor(rec, where === 'current' ? p : null, rec.decision?.verdict === 'approved' && p && where === 'current' ? deps.liveAccessOf(p) : null);
        const frozen = acc.noteResume(rec.id, { state: 'frozen', text, error: null });
        text = frozen?.resume?.text ?? text;
      }
      // r8: the project incarnation it was raised for is GONE (removed; its id may name a re-added project now, or later).
      // The outbox resumes a closed session under its projectId, so a queued row would start the removed project's
      // session inside whatever project takes that id. Deliver only to a session that is running; otherwise record it
      // as not sent (terminal; shown on the card). The DELETE route closes a project's sessions, so in practice: not sent.
      if (where !== 'current' && !deps.sessionLive?.(rec)) {
        // An earlier pass may already have put it in the outbox (its "queued" mark then lost): withdraw that row if it
        // can still be withdrawn; if the outbox has already sent it (or is sending it), record that truthfully instead.
        let held: { state: string; rowId: string } | null = null;
        try { held = deps.withdraw?.(rec, `access-${rec.id}`, text) ?? null; } catch (err) {
          acc.noteResume(rec.id, { error: `could not withdraw the resume message yet: ${(err as Error).message}` });
          continue;
        }
        if (held && held.state !== 'discarded') {
          acc.noteResume(rec.id, { state: 'queued', rowId: held.rowId, error: null });
          continue;
        }
        acc.noteResume(rec.id, { state: 'undeliverable', rowId: held?.rowId ?? null, error: `not sent: the session belongs to a project that was removed${where === 'reincarnated' ? '; a project added later has the same id' : ''}, and a closed session is never resumed into another project` });
        log(`[orchard] FEAT-200: access request ${rec.id} — resume message NOT queued: its project was removed${where === 'reincarnated' ? ' (and re-added under the same id)' : ''}; session ${rec.sdkSessionId} is not running and is not resumed into another project`);
        continue;
      }
      try {
        const rowId = deps.enqueue(rec, `access-${rec.id}`, text);
        acc.noteResume(rec.id, { state: 'queued', rowId, error: null });
        log(`[orchard] FEAT-200: access request ${rec.id} (${rec.decision?.verdict ?? 'undecided'}${rec.notApplied ? `, not applied: ${rec.notApplied.cause ?? 'refused'}` : ''}) — resume message queued for session ${rec.sdkSessionId}`);
      } catch (err) {
        acc.noteResume(rec.id, { error: `could not queue the resume message yet: ${(err as Error).message}` });
      }
    }
  } finally {
    checking = false;
  }
}
