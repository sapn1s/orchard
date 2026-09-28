/**
 * Restart survival for driven `direct` sessions (FEAT-015).
 *
 * A driven `direct` session's `claude` CLI is, by default, a direct child of the
 * server inside the systemd unit's cgroup. The unit is KillMode=control-group,
 * so `systemctl restart` reaps the whole cgroup — every live session and every
 * in-process Task sub-agent dies. This module decouples that CLI from the server:
 *
 *  1. PROCESS SURVIVAL — the CLI is launched inside its OWN transient systemd
 *     scope (`systemd-run --user --scope`), which lands it in a separate cgroup
 *     under app.slice, NOT under claude-station.service. A control-group kill of
 *     the service therefore no longer reaches it. (Verified: a `--scope`
 *     grandchild survives `systemctl --user stop` of a KillMode=control-group
 *     transient service.)
 *
 *  2. TRANSPORT SURVIVAL — the CLI's stdio is owned by a small broker process
 *     (`session-host.mjs`) that lives in that same scope, not by the server. The
 *     server talks to the broker over a unix socket. When the server dies the
 *     socket drops, but the broker keeps the CLI's stdin open and keeps draining
 *     its stdout, so the in-flight turn runs to completion and the CLI writes its
 *     transcript to disk. A restarted server RE-ADOPTS surviving brokers by
 *     scanning the hosts dir.
 *
 * RE-ATTACH (BUG-187). A restarted server does not have to leave a surviving
 * CLI without a responder. The SDK's `query()` accepts a `spawnClaudeCodeProcess`
 * override, and `attachSurvivable()` below returns one that spawns NOTHING: it
 * connects to the existing broker's socket, so the SDK's normal first
 * `initialize` becomes the running CLI's REPEATED initialize. The CLI answers it
 * as its stdin owner (`hooks_applied: true`), cancels the hook callbacks it was
 * still waiting on (the model retries them against the new responder), and
 * redelivers its pending permission prompts with their original request ids
 * (measured on CLI 2.1.281, BUG-187 round 2). The broker speaks a small in-band
 * protocol with its client (`orchard_broker_*` lines, protocol 2) which the
 * transport below strips before the SDK sees a byte.
 */
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as outcomes from './outcomes.ts';
import { RequestFloor } from './request-floor.mjs';

import { dataDir, dataDirMode, ensureDir, isInside, projectRoot } from '../lib/paths.ts';
/*
 * ARCH-001: this module no longer decides liveness. It OWNS the broker records
 * and the transport; the verdict about what they mean comes from the one
 * authority, so the survivor site and the bridge site cannot drift apart again
 * (which is exactly what BUG-033 → BUG-038 was).
 */
import { asProbe, livenessOfSurvivalHandle, livenessOfSurvivor, pidAlive, type Liveness, type LivenessProbe } from './liveness.ts';

/** Minimal structural mirror of the SDK's SpawnedProcess (its own type is not exported at runtime). */
export interface SpawnedProcessLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface SurvivalSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

export interface HostStatus {
  hostPid: number;
  claudePid: number | null;
  sock: string;
  status: string;
  stationSessionId?: string;
  resumeHint?: string | null;
  /** BUG-187 I1 — the project this session belongs to (absent on an older broker's record). */
  projectId?: string | null;
  /**
   * The CLI's ACTUAL on-disk session id (the transcript file name), learned by
   * the broker from the CLI's stream-json `init` message and written back here.
   * For a fresh session this is the newly-minted id (which `resumeHint` never
   * carries); for a non-fork resume it equals `resumeHint`. This is the field a
   * restarted server matches an incoming resume against so it never spawns a
   * second `claude --resume` onto the same transcript (BUG-022).
   */
  sdkSessionId?: string | null;
  state: 'starting' | 'running' | 'draining' | 'exited';
  exitCode: number | null;
  signal: string | null;
  startedAt?: string;
  updatedAt?: string;
  /**
   * FEAT-064 (BUG-048's drain truth surface) — carried on EVERY broker status
   * heartbeat: how many background tasks the CLI's own level frames report
   * live, their sniffed ids, the broker's current lifetime answer, and the
   * moment a reap/commit was FIRST declined because of held work (null until a
   * decline happens). Consumed by the resume-refusal payload, /api/health and
   * the BUG-045 drain-wait chip so "still draining" names WHAT holds it.
   * Optional: a status file written by an older broker simply lacks them.
   */
  backgroundLive?: number;
  backgroundTaskIds?: string[];
  backgroundLifetime?: 'yes' | 'unknown' | 'no';
  drainHeldSince?: string | null;
  /**
   * FEAT-065 — the broker's live turn-boundary tracker, refreshed on every
   * boundary transition (not only on drain heartbeats). The stdin-delivery
   * gate injects a queued message into a drain-held survivor ONLY when this is
   * `false` (foreground provably idle); a mid-foreground-drain survivor keeps
   * the queue-and-wait refusal. Optional: older brokers' files lack it, and an
   * absent value is treated as "not provably idle" (never injected).
   */
  midTurn?: boolean;
  /**
   * BUG-072 — the visibility half of the same declarations:
   *  - `midTurnSince`: when the CURRENT foreground turn opened (stamped at the
   *    boundary, cleared at its `result`), so a delivered turn renders an
   *    HONEST clock instead of a stopwatch started when a surface found out
   *    (BUG-033). Absent = not knowable → the client renders "—".
   *  - `backgroundTasks`: the same lanes `backgroundTaskIds` names, with the
   *    engine's own `task_type` and the moment THIS broker first saw the lane,
   *    so the running strip can label them (`local_bash`, `local_agent`) rather
   *    than showing a bare id. `backgroundTaskIds` stays as-is for every
   *    existing reader (FEAT-064's refusal payload, health).
   * Optional: an older broker's status file simply lacks them and readers fall
   * back to ids-only / unknown — never to a fabricated value.
   */
  midTurnSince?: string | null;
  backgroundTasks?: { id: string; type: string | null; since: string | null }[];
  /**
   * BUG-117 — WHO created this broker (see `HostOwner`). Written at the spawn
   * site, echoed by the broker on every status write, and checked before any
   * adoption reaps it. Optional: a record written before this landed has none,
   * and `ownerEntitlesAdoption` says what happens then.
   */
  owner?: HostOwner;
  /**
   * BUG-187 — broker protocol 2 declarations. All optional: an older broker's
   * record simply lacks them, and every reader treats an absent value as
   * UNKNOWN — never as "attached", never as "healthy", never as `no`.
   *  - `protocol`/`seq`/`statusWriteFailedAt`: freshness (H1). A reader can tell
   *    a stale record from a fresh one, and a failed write is declared.
   *  - `startedTasks`: lanes started (e.g. revived) that the level may not list (H2).
   *  - `responder`/`responderLostAt`/`adoptedAt`: is anyone attached to answer
   *    this CLI, and since when not.
   *  - `refusals`/`pendingRequests`/`pendingUnowned`/`lanes`: the request floor's
   *    ledger (H4/H5); a lane is `blocked` once refused, then `stopRequested`,
   *    then `stopped` (or `stopUnconfirmed`).
   *  - `acceptingInput`: false from the moment the broker ended the CLI's stdin (H7).
   */
  protocol?: number;
  seq?: number;
  statusWriteFailedAt?: string | null;
  startedTasks?: string[];
  responder?: 'attached' | 'none';
  responderLostAt?: string | null;
  adoptedAt?: string | null;
  refusals?: number;
  pendingRequests?: number;
  pendingUnowned?: number;
  lanes?: BrokerLane[];
  acceptingInput?: boolean;
}

/** BUG-187 H5 — one lane's floor state, as the broker declares it. */
export interface BrokerLane {
  id: string;
  refusals: number;
  blockedSince: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  stopUnconfirmed: boolean;
}

/**
 * BUG-033 / ARCH-001 — GROUND TRUTH about the process behind a survivable
 * session, read on demand from /proc + the broker's own status file.
 * `'unknown'` is a first-class answer (the broker has not reported yet): a
 * caller must never read it as either "alive" or "dead". The rungs themselves
 * live in `liveness.ts`; this is the narrow shape they are consumed as.
 */
export type SurvivalProbe = LivenessProbe;

/** The handle the AgentSession keeps so it can reap its own broker on a real close. */
export interface SurvivalHandle {
  statusPath: string;
  sock: string;
  hostKey: string;
  /** SIGTERM the broker → graceful CLI stdin-EOF → turn drains → CLI+broker exit. */
  reap(): void;
  /**
   * BUG-033 / ARCH-001 — is the CLI behind this session actually still there?
   * Ground truth, never a timer. A pure delegation to the authority
   * (`livenessOfSurvivalHandle`), which owns the rungs and their order.
   */
  probe(): SurvivalProbe;
  /** The same answer, unreduced — evidence, `since` and the FEAT-057 `ended` slot. */
  livenessNow(): Liveness;
  /** BUG-187 — the in-band channel to the broker (protocol 2), or its absence. */
  broker: BrokerChannel;
}

/**
 * BUG-187 H3 — the client side of the broker's in-band protocol. The broker's
 * `orchard_broker_*` lines are consumed here and never reach the SDK.
 *  - `hello`: resolves with the broker's hello (`accepted`, `protocol`), or
 *    `null` for a pre-protocol-2 broker (no hello within the window) or a
 *    closed socket.
 *  - `reclaim`: resolves with the broker's reclaim verdict after this client's
 *    `initialize` was answered, or `null` if none arrives.
 *  - `lifetimeQuery()`: the broker's OWN lifetime answer (the one it holds its
 *    drain on), or `null` on timeout / old broker.
 */
export interface BrokerChannel {
  hello: Promise<BrokerHello | null>;
  reclaim: Promise<{ ok: boolean; reason?: string } | null>;
  lifetimeQuery(timeoutMs?: number): Promise<BrokerLifetimeAnswer | null>;
  deliver(message: unknown, timeoutMs?: number): Promise<{ accepted: boolean; reason?: string } | null>;
}
export interface BrokerHello { accepted: boolean; protocol: number; hostKey?: string; reason?: string }
export interface BrokerLifetimeAnswer { lifetime: 'yes' | 'unknown' | 'no'; seq: number; statusWriteFailedAt: string | null; midTurn?: boolean }

const BROKER_LINE_START = '{"type":"orchard_broker_';
/** How long a connected client waits for a hello before concluding "old broker". */
const HELLO_WINDOW_MS = Number(process.env.CLAUDE_STATION_BROKER_HELLO_MS ?? 1500);

/**
 * Wire a connected broker socket to the SDK-facing streams, stripping the
 * broker's own lines out of the stream and routing them to the channel.
 * Returns the channel. Lines are forwarded whole; a partial line waits for its
 * newline (the SDK parses whole lines anyway).
 */
function wireBrokerSocket(
  s: net.Socket,
  stdin: PassThrough,
  stdout: PassThrough,
  channel: BrokerChannelImpl,
  /**
   * BUG-187 B5 (attach facade only): a line tap on both directions, so the
   * request floor can run CLIENT-side for an older broker that has none.
   * `cli(line)` sees each CLI→SDK line; `sdk(line)` sees each SDK→CLI line and
   * returns false to DROP it (a second answer to an id the floor already
   * settled). Without a tap, stdin is piped straight through as before.
   */
  tap?: { cli: (line: string) => void; sdk: (line: string) => boolean },
): void {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  s.on('data', (d: Buffer) => {
    buf += decoder.write(d);
    let start = 0;
    let nl: number;
    let out = '';
    while ((nl = buf.indexOf('\n', start)) >= 0) {
      const line = buf.slice(start, nl);
      start = nl + 1;
      if (line.startsWith(BROKER_LINE_START)) {
        let m: Record<string, unknown> | null = null;
        try { m = JSON.parse(line); } catch { m = null; }
        if (m) channel.onLine(m);
        continue;
      }
      tap?.cli(line);
      out += `${line}\n`;
    }
    buf = buf.slice(start);
    if (out) stdout.write(out);
  });
  if (!tap) {
    stdin.pipe(s);
  } else {
    const inDecoder = new StringDecoder('utf8');
    let inBuf = '';
    stdin.on('data', (d: Buffer | string) => {
      inBuf += typeof d === 'string' ? d : inDecoder.write(d);
      let nl: number;
      let out = '';
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, nl);
        inBuf = inBuf.slice(nl + 1);
        if (tap.sdk(line)) out += `${line}\n`;
      }
      if (out && !s.destroyed) { try { s.write(out); } catch { /* socket gone */ } }
    });
    stdin.on('end', () => { try { s.end(); } catch { /* ignore */ } });
  }
  channel.attachSocket(s);
}

class BrokerChannelImpl implements BrokerChannel {
  hello: Promise<BrokerHello | null>;
  reclaim: Promise<{ ok: boolean; reason?: string } | null>;
  #resolveHello!: (h: BrokerHello | null) => void;
  #resolveReclaim!: (r: { ok: boolean; reason?: string } | null) => void;
  #socket: net.Socket | null = null;
  #seq = 0;
  #waiters = new Map<string, (m: Record<string, unknown> | null) => void>();
  #helloSeen: BrokerHello | null = null;
  constructor() {
    this.hello = new Promise((r) => { this.#resolveHello = r; });
    this.reclaim = new Promise((r) => { this.#resolveReclaim = r; });
  }
  attachSocket(s: net.Socket): void {
    this.#socket = s;
    // No hello inside the window = a pre-protocol-2 broker (it never sends one).
    const t = setTimeout(() => this.#resolveHello(null), HELLO_WINDOW_MS);
    t.unref?.();
    s.on('close', () => {
      this.#resolveHello(null);
      this.#resolveReclaim(null);
      for (const w of this.#waiters.values()) w(null);
      this.#waiters.clear();
    });
  }
  get protocol(): number { return this.#helloSeen?.protocol ?? 0; }
  onLine(m: Record<string, unknown>): void {
    const kind = String(m.type).slice('orchard_broker_'.length);
    if (kind === 'hello') {
      this.#helloSeen = { accepted: m.accepted === true, protocol: Number(m.protocol) || 0, hostKey: m.hostKey as string | undefined, reason: m.reason as string | undefined };
      this.#resolveHello(this.#helloSeen);
    } else if (kind === 'reclaim') {
      this.#resolveReclaim({ ok: m.ok === true, reason: typeof m.reason === 'string' ? m.reason : undefined });
    } else if (kind === 'lifetime_a' || kind === 'deliver_ack') {
      const key = `${kind}:${String(kind === 'lifetime_a' ? m.id : m.delivery_id)}`;
      const w = this.#waiters.get(key);
      if (w) { this.#waiters.delete(key); w(m); }
    }
  }
  #ask(kind: 'lifetime_q' | 'deliver', payload: Record<string, unknown>, answerKind: string, idField: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const s = this.#socket;
    if (!s || s.destroyed || this.protocol < 2) return Promise.resolve(null);
    const id = `c${++this.#seq}`;
    return new Promise((resolve) => {
      const key = `${answerKind}:${id}`;
      const t = setTimeout(() => { this.#waiters.delete(key); resolve(null); }, timeoutMs);
      t.unref?.();
      this.#waiters.set(key, (m) => { clearTimeout(t); resolve(m); });
      try { s.write(`${JSON.stringify({ type: `orchard_broker_${kind}`, [idField]: id, ...payload })}\n`); } catch { clearTimeout(t); this.#waiters.delete(key); resolve(null); }
    });
  }
  async lifetimeQuery(timeoutMs = 2000): Promise<BrokerLifetimeAnswer | null> {
    const m = await this.#ask('lifetime_q', {}, 'lifetime_a', 'id', timeoutMs);
    if (!m) return null;
    const lt = m.lifetime;
    if (lt !== 'yes' && lt !== 'no' && lt !== 'unknown') return null;
    return { lifetime: lt, seq: Number(m.seq) || 0, statusWriteFailedAt: (m.statusWriteFailedAt as string | null) ?? null, midTurn: m.midTurn === true };
  }
  async deliver(message: unknown, timeoutMs = 5000): Promise<{ accepted: boolean; reason?: string } | null> {
    const m = await this.#ask('deliver', { message }, 'deliver_ack', 'delivery_id', timeoutMs);
    if (!m) return null;
    return { accepted: m.accepted === true, reason: typeof m.reason === 'string' ? m.reason : undefined };
  }
}

export function hostsDir(): string {
  return path.join(dataDir(), 'session-hosts');
}

const HOST_SCRIPT = path.join(projectRoot(), 'src', 'server', 'session-host.mjs');

let systemdRunOk: boolean | null = null;
/** Is `systemd-run --user` usable here? Cached — checked once per process. */
export function systemdRunAvailable(): boolean {
  if (systemdRunOk !== null) return systemdRunOk;
  try {
    // `--version` needs no bus; a real launch needs the user manager, so also
    // require XDG_RUNTIME_DIR (the user bus socket path) to be present.
    const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', timeout: 4000 });
    systemdRunOk = r.status === 0 && !!process.env.XDG_RUNTIME_DIR;
  } catch {
    systemdRunOk = false;
  }
  return systemdRunOk;
}

/**
 * Should driven `direct` sessions be launched to survive a server restart?
 * On by default; `CLAUDE_STATION_SURVIVE=0` forces the legacy in-cgroup spawn
 * (used by the verification harness as its FAILURE control, and available as an
 * operator kill-switch). Requires systemd-run — without it survival is not
 * achievable against a control-group kill, so we fall back honestly rather than
 * pretend (the session runs exactly as before).
 */
export function survivalEnabled(): boolean {
  if (process.env.CLAUDE_STATION_SURVIVE === '0') return false;
  return systemdRunAvailable();
}

/**
 * BUG-117 / BUG-114 — WHO created this host.
 *
 * Two properties are needed and neither can be a bare pid. Adoption must let the
 * production service reclaim its OWN hosts across its own restart (a new pid
 * every time), and it must NOT let a stray/scratch server reap hosts it never
 * created. So the identity is the pair the record can be checked against: the
 * data dir the host lives under, plus the port its creator serves on — stable
 * across a restart of that server, different for anything else on the machine.
 *
 * `pid` + `pidStart` (the kernel's start-ticks for that pid, so pid reuse cannot
 * impersonate it) are carried too, but only as a LIVENESS token for the broker's
 * orphan bound (BUG-114) — never as the adoption entitlement.
 */
export interface HostOwner {
  mode: 'isolated' | 'shared';
  dataDir: string;
  port: number;
  pid: number;
  pidStart: string | null;
  startedAt: string;
}

/** The kernel's start-ticks for a pid (field 22 of /proc/<pid>/stat), or null. */
export function pidStartToken(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return after[19] ?? null; // field 22 overall = index 19 after the comm field
  } catch { return null; }
}

/** This process's owner identity. */
export function hostOwner(): HostOwner {
  return {
    mode: dataDirMode(),
    dataDir: dataDir(),
    port: Number(process.env.PORT ?? 4317),
    pid: process.pid,
    pidStart: pidStartToken(process.pid),
    startedAt: new Date().toISOString(),
  };
}

/**
 * BUG-117 — may THIS process reap that host? Presence in the directory used to
 * be the whole entitlement, so any process that resolved the path (including one
 * that resolved it by accident, through a misspelled isolation knob) could drain
 * every broker on the machine, the user's live session included.
 *
 *  - An ISOLATED server owns its hosts dir by construction: the dir is its own
 *    scratch tree, so everything in it is its own. Unchanged behaviour — no
 *    verification suite loses its restart-adoption, including the ones that
 *    re-boot on a DIFFERENT port against the same scratch data dir.
 *  - A SHARED (default data dir) server may reap only records whose owner
 *    declares the same port — that is the production service reclaiming its own
 *    hosts across a restart, and nothing else.
 *  - A record with NO owner is pre-BUG-117 (written by an older broker; the
 *    user's live host is one right now). It is adopted only by a shared server
 *    on the DEFAULT port — i.e. the production service itself — so the upgrade
 *    does not orphan a live session, while a stray boot on an ephemeral port
 *    still cannot touch it. That path disappears after one restart.
 */
export function ownerEntitlesAdoption(record: HostStatus, me: HostOwner = hostOwner()): boolean {
  if (me.mode === 'isolated') return true;
  const owner = record.owner;
  if (!owner || typeof owner.port !== 'number') return me.port === 4317;
  return owner.port === me.port;
}

function newHostKey(): string {
  // BUG-114: an isolated (verification) server's hosts are named apart from the
  // production service's, so a cleanup glob can be aimed at test hosts ONLY —
  // `claude-station-host-t-*.scope` provably cannot match a production host.
  const prefix = dataDirMode() === 'isolated' ? 't' : 'h';
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The exit code/signal a broker RECORDED for its CLI when the socket closed on
 * us (it only closes it once the CLI has exited). One reader for both facades
 * (spawn and BUG-187 attach), so the broker's verdict is read in one place.
 */
function recordedExit(st: HostStatus | null): [number | null, NodeJS.Signals | null] {
  if (st && st.state === 'exited') return [st.exitCode, (st.signal as NodeJS.Signals | null) ?? null];
  return [null, null];
}

/**
 * Launch the CLI under a broker in its own systemd scope and return a
 * SpawnedProcess the SDK can drive. Synchronous return (the SDK requires it):
 * the returned stdin/stdout are PassThroughs that buffer until the broker's
 * unix socket is up, then relay to it. Killing this transport only DISCONNECTS
 * the socket — it never reaps the broker/CLI; that is `handle.reap()`'s job, so
 * a mere transport teardown (SDK abort, server exit) leaves the CLI running.
 */
export function spawnSurvivable(
  o: SurvivalSpawnOptions,
  meta: { stationSessionId: string; resumeHint?: string | null; projectId?: string | null },
): { proc: SpawnedProcessLike; handle: SurvivalHandle } {
  ensureDir(hostsDir());
  const key = newHostKey();
  const sock = path.join(hostsDir(), `${key}.sock`);
  const statusPath = path.join(hostsDir(), `${key}.json`);
  const errlog = path.join(hostsDir(), `${key}.err`);
  const controlPath = path.join(hostsDir(), `${key}.ctl.json`);

  const owner = hostOwner();
  fs.writeFileSync(controlPath, JSON.stringify({
    sock, status: statusPath, errlog,
    command: o.command, args: o.args,
    // BUG-117/BUG-114: the creating server's identity travels WITH the host —
    // it is the adoption entitlement (server side) and the broker's orphan
    // liveness token (host side).
    owner,
    meta: { stationSessionId: meta.stationSessionId, resumeHint: meta.resumeHint ?? null, projectId: meta.projectId ?? null, owner },
  }), { mode: 0o600 });

  // The broker (and thus the CLI) lands in a fresh transient scope cgroup,
  // escaping the service's control-group kill. `--collect` reaps the scope unit
  // when it exits so nothing accumulates in systemd.
  const runArgs = [
    '--user', '--scope', '--quiet', '--collect',
    `--unit=claude-station-host-${key}`,
    process.execPath, HOST_SCRIPT, controlPath,
  ];
  // `systemd-run --user --scope` must reach the per-user systemd manager, which
  // needs XDG_RUNTIME_DIR (the user-bus socket dir) and, on some setups,
  // DBUS_SESSION_BUS_ADDRESS. The SDK hands us `{...process.env}`, so inside a
  // `systemctl --user` service these are already present (that is why survival
  // works in the real deploy). This is belt-and-braces: if a future caller ever
  // curates the env and strips them, re-inject them from the server process (and
  // derive the bus address from XDG_RUNTIME_DIR) so the scope can still form,
  // rather than silently failing to escape the cgroup. `survivalEnabled()`
  // already gated us off if XDG_RUNTIME_DIR is absent everywhere.
  const runEnv: Record<string, string | undefined> = { ...o.env };
  if (!runEnv.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) runEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (!runEnv.DBUS_SESSION_BUS_ADDRESS) {
    if (process.env.DBUS_SESSION_BUS_ADDRESS) runEnv.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
    else if (runEnv.XDG_RUNTIME_DIR) runEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runEnv.XDG_RUNTIME_DIR}/bus`;
  }
  // Capture systemd-run's own stderr so a scope-creation failure is diagnosable
  // (fd2 is the launcher's until it execs the broker in-place; after that it is
  // the broker's stderr, which is rare and equally worth surfacing).
  const launcher = spawn('systemd-run', runArgs, {
    cwd: o.cwd ?? process.cwd(),
    env: runEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  launcher.unref();
  let launcherStderr = '';
  launcher.stderr?.on('data', (d) => {
    if (launcherStderr.length < 8192) launcherStderr += d.toString('utf8');
  });
  launcher.on('error', (err) => {
    // Could not even exec systemd-run — survival cannot happen for this session.
    if (!everConnected && !exited) failScopeLaunch(`systemd-run could not be spawned: ${err.message}`, null, null);
  });

  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const channel = new BrokerChannelImpl();
  let socket: net.Socket | null = null;
  let killed = false;
  let exited = false;
  let everConnected = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    signalCode = signal;
    try { stdout.end(); } catch { /* ignore */ }
    emitter.emit('exit', code, signal);
  };

  const readStatus = (): HostStatus | null => {
    try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as HostStatus; } catch { return null; }
  };

  /**
   * The scope could NOT be created — the broker did NOT launch inside its own
   * cgroup, so the CLI is NOT restart-protected. NEVER let this masquerade as a
   * working survivable session: log it LOUDLY (journalctl for the service),
   * record a `scopeLaunchFailed` flag in the status file, and settle the facade
   * as an error/exit immediately (instead of a silent ~30s socket timeout). The
   * caller/SDK then fails the spawn visibly rather than believing survival is on.
   */
  let scopeFailed = false;
  const failScopeLaunch = (reason: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (scopeFailed || exited || everConnected) return;
    scopeFailed = true;
    const detail = (launcherStderr.trim() || reason).slice(0, 2000);
    console.error(
      `[orchard] FATAL survival: systemd scope could NOT be created for session ` +
      `${meta.stationSessionId} — the session-host broker did not launch, so this driven CLI is ` +
      `NOT protected against a server-restart control-group kill. Cause: ${detail}`,
    );
    try {
      fs.writeFileSync(statusPath, JSON.stringify({
        hostPid: -1, claudePid: null, sock, status: statusPath,
        stationSessionId: meta.stationSessionId, resumeHint: meta.resumeHint ?? null,
        state: 'exited', exitCode: code, signal: signal ?? null,
        scopeLaunchFailed: true, error: detail,
        updatedAt: new Date().toISOString(),
      }), { mode: 0o600 });
    } catch { /* best effort — the loud log is the primary signal */ }
    emitter.emit('error', new Error(`survival scope launch failed: ${detail}`));
    emitExit(code, signal);
  };
  // A FAST nonzero exit of `systemd-run` BEFORE we ever connected means the scope
  // could not be created (it errored before exec'ing the broker). In the SUCCESS
  // path systemd-run EXECs the broker IN-PLACE — that pid stays alive as the
  // broker and this 'exit' fires only much later when the broker itself ends
  // (the socket-close handler settles that), guarded here by `everConnected`.
  launcher.on('exit', (code, signal) => {
    if (!everConnected && !exited && (code === null || code !== 0)) {
      failScopeLaunch(`systemd-run exited ${code ?? 'null'}${signal ? `/${signal}` : ''} before the broker came up`, code, signal);
    }
  });

  // Connect to the broker once its socket exists. Poll briefly — the broker
  // spawns fast, but a cold systemd-run has some latency.
  let connectAttempts = 0;
  const tryConnect = () => {
    if (killed || exited) return;
    if (!fs.existsSync(sock)) {
      if (++connectAttempts > 300) { // ~30s
        emitter.emit('error', new Error(`session-host socket never appeared at ${sock}`));
        emitExit(null, null);
        return;
      }
      setTimeout(tryConnect, 100);
      return;
    }
    const s = net.connect(sock);
    s.on('connect', () => {
      socket = s;
      everConnected = true; // the broker is up in its scope — this is NOT a scope-launch failure
      // BUG-187: the broker's in-band lines are stripped here, never reach the SDK.
      wireBrokerSocket(s, stdin, stdout, channel);
    });
    s.on('close', () => {
      if (killed) { emitExit(exitCode, signalCode); return; }
      // Socket closed without our asking — the broker ended it, which it only
      // does when the CLI has exited. Read the recorded exit code.
      const [code, sig] = recordedExit(readStatus());
      emitExit(code, sig);
    });
    s.on('error', () => { /* close handler settles exit */ });
  };
  setTimeout(tryConnect, 60);

  const proc: SpawnedProcessLike = {
    stdin,
    stdout,
    get killed() { return killed; },
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(_signal: NodeJS.Signals): boolean {
      // DISCONNECT ONLY. The SDK calls kill() on close/abort; that must not reap
      // the survivable CLI. We drop the socket and synthesise an exit so the
      // SDK's own teardown completes, while the broker + CLI live on until
      // handle.reap() (a real session close) or a boot-time re-adopt.
      killed = true;
      try { if (socket) socket.destroy(); } catch { /* ignore */ }
      emitExit(exitCode, signalCode);
      return true;
    },
    on(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.on(event, listener); },
    once(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.once(event, listener); },
    off(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.off(event, listener); },
  } as SpawnedProcessLike;

  /** The authority's verdict on THIS transport, from the two rungs only it has. */
  const livenessNow = (): Liveness =>
    livenessOfSurvivalHandle({ exitLatched: exited, everConnected, status: readStatus() });

  const handle: SurvivalHandle = {
    statusPath,
    sock,
    hostKey: key,
    reap() { reapHost(statusPath); },
    /*
     * ARCH-001 — a pure delegation to the single authority. The rungs (exit
     * latch → status-file absence after a connect → the broker's own verdict →
     * live-pid checks) and their ORDER live in `liveness.ts`; duplicating any
     * of them here is precisely how the bridge site and the survivor site came
     * to disagree. Nothing may be added to this body but the call.
     */
    probe(): SurvivalProbe {
      return asProbe(livenessNow());
    },
    livenessNow,
    broker: channel,
  };

  return { proc, handle };
}

/** The attach facade's handle: a survival handle whose reap is GATED on a confirmed adoption. */
export interface AttachHandle extends SurvivalHandle {
  /** Set by the bridge once hello.accepted + init success (+ protocol-2 reclaim.ok) all arrived. */
  confirmAdoption(): void;
  readonly adoptionConfirmed: boolean;
  /**
   * BUG-187 B3/B5 — an OLDER broker (no floor of its own) whose engine did not
   * apply this server's hooks: run the shared request floor here, client-side.
   * A hook callback the SDK leaves unanswered past its grace is refused; a
   * permission prompt the SDK surfaced (a card) is OWNED and never refused.
   * Its limit, stated: a request the CLI emitted before this attach reached
   * nobody, so no client can see it — the broker would have to replay it.
   */
  enableClientFloor(): void;
}

/**
 * BUG-187 S1 — the ATTACH facade. Same `SpawnedProcessLike` shape as
 * `spawnSurvivable`'s, but it spawns NOTHING: it connects to an existing
 * broker's socket, so the SDK's first `initialize` becomes the running CLI's
 * repeated initialize (it re-registers this server's hooks, cancels the hook
 * callbacks it was waiting on, and redelivers pending permission prompts).
 *
 * `kill()` only disconnects (exactly like spawnSurvivable's). `reap()` is a
 * NO-OP until the bridge confirms the adoption: a losing or failed adopter must
 * never SIGTERM a broker another server owns (review round 2, point 3).
 */
export function attachSurvivable(st: HostStatus): { proc: SpawnedProcessLike; handle: AttachHandle } {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const channel = new BrokerChannelImpl();
  let socket: net.Socket | null = null;
  let killed = false;
  let exited = false;
  let everConnected = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let adoptionConfirmed = false;
  const statusPath = st.status;
  let floor: RequestFloor | null = null;
  let floorTicker: ReturnType<typeof setInterval> | null = null;
  const tap = {
    cli: (line: string) => {
      if (!floor || !line.includes('"control_')) return;
      let m: Record<string, any> | null = null;
      try { m = JSON.parse(line); } catch { return; }
      if (m?.type === 'control_request') floor.onCliRequest(m, m.request?.subtype === 'can_use_tool' ? 'sdk' : null);
      else if (m?.type === 'control_cancel_request') floor.onCliCancel(m.request_id);
    },
    sdk: (line: string) => {
      if (!floor || !line.includes('"control_response"')) return true;
      let m: Record<string, any> | null = null;
      try { m = JSON.parse(line); } catch { return true; }
      const rid = m?.response?.request_id;
      return rid == null ? true : floor.onClientResponse(rid, 'sdk');
    },
  };

  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    signalCode = signal;
    try { stdout.end(); } catch { /* ignore */ }
    emitter.emit('exit', code, signal);
  };
  const readStatus = (): HostStatus | null => {
    try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as HostStatus; } catch { return null; }
  };

  // Connect at once — the broker is already up. A missing socket is an exit.
  setImmediate(() => {
    if (killed || exited) return;
    const s = net.connect(st.sock);
    s.on('connect', () => {
      socket = s;
      everConnected = true;
      wireBrokerSocket(s, stdin, stdout, channel, tap);
    });
    s.on('close', () => {
      if (floorTicker) { clearInterval(floorTicker); floorTicker = null; }
      if (killed) { emitExit(exitCode, signalCode); return; }
      const [code, sig] = recordedExit(readStatus());
      emitExit(code, sig);
    });
    s.on('error', () => { /* the close handler settles exit */ });
  });

  const proc: SpawnedProcessLike = {
    stdin,
    stdout,
    get killed() { return killed; },
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(_signal: NodeJS.Signals): boolean {
      killed = true;
      try { if (socket) socket.destroy(); } catch { /* ignore */ }
      emitExit(exitCode, signalCode);
      return true;
    },
    on(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.on(event, listener); },
    once(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.once(event, listener); },
    off(event: 'exit' | 'error', listener: (...a: any[]) => void) { emitter.off(event, listener); },
  } as SpawnedProcessLike;

  const livenessNow = (): Liveness =>
    livenessOfSurvivalHandle({ exitLatched: exited, everConnected, status: readStatus() });
  const hostKey = path.basename(statusPath).replace(/\.json$/, '');
  const handle: AttachHandle = {
    statusPath,
    sock: st.sock,
    hostKey,
    reap() {
      if (!adoptionConfirmed) {
        console.log(`[orchard] BUG-187: not reaping broker ${st.hostPid} (${hostKey}) — this server never confirmed its adoption, so it has no claim to end it`);
        return;
      }
      reapHost(statusPath);
    },
    probe(): SurvivalProbe { return asProbe(livenessNow()); },
    livenessNow,
    broker: channel,
    confirmAdoption() { adoptionConfirmed = true; },
    get adoptionConfirmed() { return adoptionConfirmed; },
    enableClientFloor() {
      if (floor) return;
      floor = new RequestFloor({
        write: (frame) => { if (socket && !socket.destroyed) { try { socket.write(`${JSON.stringify(frame)}\n`); } catch { /* gone */ } } },
        log: (msg) => console.log(`[orchard] BUG-187 client-side floor (broker ${st.hostPid}): ${msg}`),
      });
      floorTicker = setInterval(() => floor?.tick(), 500);
      floorTicker.unref?.();
    },
  };
  return { proc, handle };
}

/**
 * BUG-187 S3 / B4 — THE one close gate for a brokered session. Every automatic
 * close (detached fuse, socket release, shutdown) asks this, and only a `no`
 * closes. The broker is the lifetime's owner (ARCH-010): its own answer — the
 * one it holds its drain on — is asked in-band. Missing evidence is never `no`:
 *  - protocol 2: the in-band `lifetime_q`; no answer within the timeout → unknown;
 *  - an older broker (no in-band channel): `no` only if its record says `no`
 *    AND the record is newer than the last frame this bridge received AND the
 *    bridge's own unfiltered level is empty; anything else → unknown.
 *
 * BUG-187 round 6 — LIVE REVIVED WORK IS NEVER A `no`. The engine keeps a
 * SendMessage-revived lane OUT of its background level, so an older broker's
 * fresh `no` record and an empty raw level are exactly what live revived work
 * looks like from outside. The bridge's first-hand revived-live evidence
 * (`revivedLive`) therefore outranks a `no` from ANY branch — the answer
 * becomes `unknown` (conflicting evidence), which never closes. It is applied
 * once, here, over every branch, so no branch can forget it.
 */
export async function brokerLifetimeForClose(
  handle: Pick<SurvivalHandle, 'statusPath' | 'broker'> | null,
  bridge: { lastFrameAt: number; levelRawEmpty: boolean; levelSeenSinceAttach?: boolean; revivedLive?: boolean },
  timeoutMs = 2000,
): Promise<{ lifetime: 'yes' | 'unknown' | 'no'; source: string }> {
  const r = await brokerLifetimeEvidence(handle, bridge, timeoutMs);
  if (r.lifetime === 'no' && bridge.revivedLive) {
    return {
      lifetime: 'unknown',
      source: `conflicting evidence: ${r.source} — but this bridge holds a LIVE revived background lane, which the engine keeps out of its level; never read as no`,
    };
  }
  return r;
}
async function brokerLifetimeEvidence(
  handle: Pick<SurvivalHandle, 'statusPath' | 'broker'> | null,
  bridge: { lastFrameAt: number; levelRawEmpty: boolean; levelSeenSinceAttach?: boolean; revivedLive?: boolean },
  timeoutMs: number,
): Promise<{ lifetime: 'yes' | 'unknown' | 'no'; source: string }> {
  if (!handle) return { lifetime: 'unknown', source: 'no broker handle' };
  const hello = await Promise.race([handle.broker.hello, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref?.())]);
  if (hello && hello.protocol >= 2) {
    const a = await handle.broker.lifetimeQuery(timeoutMs);
    if (!a) return { lifetime: 'unknown', source: 'the broker did not answer the lifetime query in time' };
    return { lifetime: a.lifetime, source: `the broker's own answer (seq ${a.seq})` };
  }
  let st: HostStatus | null = null;
  try { st = JSON.parse(fs.readFileSync(handle.statusPath, 'utf8')) as HostStatus; } catch { st = null; }
  if (!st) return { lifetime: 'unknown', source: 'the broker record is missing or unreadable' };
  /*
   * BUG-187 round 2 — a broker so old it declares NO lifetime at all. The only
   * owner-grade evidence left is the ENGINE's own level, which the CLI re-sends
   * right behind the answer to an adopter's repeated initialize. Use it only
   * when it arrived after this attach (first-hand, fresh); otherwise unknown.
   */
  if (st.backgroundLifetime === undefined && bridge.levelSeenSinceAttach) {
    const live = !bridge.levelRawEmpty || !!bridge.revivedLive;
    return { lifetime: live ? 'yes' : 'no', source: 'an older broker that declares no lifetime; the engine\'s own level, re-sent on this server\'s re-initialize' };
  }
  const updated = st.updatedAt ? Date.parse(st.updatedAt) : NaN;
  if (st.backgroundLifetime === 'no' && Number.isFinite(updated) && updated > bridge.lastFrameAt && bridge.levelRawEmpty) {
    return { lifetime: 'no', source: 'an older broker record says no, is newer than the last frame, and the unfiltered level is empty' };
  }
  return { lifetime: st.backgroundLifetime === 'yes' ? 'yes' : 'unknown', source: `an older broker record (lifetime ${st.backgroundLifetime ?? 'absent'}), not corroborated` };
}

/**
 * BUG-187 S2 — does this surviving broker hold work a responder must attach to?
 * Live lanes (level, ids or started), a turn in flight, or (protocol 2) an
 * unresolved control request. A broker with none of these is idle and is reaped
 * exactly as before.
 */
export function survivorNeedsAdoption(st: HostStatus): { adopt: boolean; why: string } {
  const lanes = (st.backgroundTasks?.length ?? 0) + (st.startedTasks?.length ?? 0);
  const ids = st.backgroundTaskIds?.length ?? 0;
  if (lanes > 0 || ids > 0) return { adopt: true, why: `${Math.max(lanes, ids)} live lane(s)` };
  if (st.midTurn === true) return { adopt: true, why: 'a turn in flight' };
  if ((st.protocol ?? 0) >= 2 && (st.pendingRequests ?? 0) > 0) return { adopt: true, why: `${st.pendingRequests} unresolved control request(s)` };
  if (st.backgroundLifetime === 'yes' || st.backgroundLifetime === 'unknown') return { adopt: true, why: `background lifetime ${st.backgroundLifetime}` };
  /*
   * BUG-187 round 2 — an OLDER broker whose record declares NOTHING about its
   * work (no lifetime, no turn state, no lanes) is not evidence of idleness; it
   * is absence of evidence. Adopt it: re-attaching a responder to an idle CLI
   * costs nothing (the close gate then sees the engine's own level), while
   * reaping one with live work repeats the incident.
   */
  if ((st.protocol ?? 0) < 2 && st.backgroundLifetime === undefined && st.midTurn === undefined) {
    return { adopt: true, why: 'an older broker that declares nothing about its work — unknown, not idle' };
  }
  return { adopt: false, why: 'idle — no live lanes, no turn in flight, nothing pending' };
}

/**
 * BUG-187 H8 / L2 — consume broker TOMBSTONES (`<key>.ended.json`) into the
 * FEAT-057 outcome store, then delete them. A broker writes one just before it
 * removes its status record, so the reason a session stopped reaches the user
 * even when no poll happened to land between the last status write and exit.
 * Only records inside this server's own hosts dir, and only records this server
 * is entitled to (the same rule as adoption).
 */
export function consumeTombstones(me: HostOwner = hostOwner()): number {
  const dir = hostsDir();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.ended.json')); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let t: Record<string, any> | null = null;
    try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { t = null; }
    if (!t || t.tombstone !== 1) { continue; }
    // Entitlement: the same rule as adoption (BUG-117), on the owner the broker
    // stamped into its tombstone.
    if (!ownerEntitlesAdoption({ owner: t.owner ?? undefined } as HostStatus, me)) continue;
    const sess = t.session ?? {};
    const lanes: BrokerLane[] = Array.isArray(t.lanes) ? t.lanes : [];
    try {
      for (const l of lanes) {
        if (!l.stopRequestedAt) continue;
        outcomes.record({
          stationSessionId: sess.stationSessionId ?? null,
          sdkSessionId: sess.sdkSessionId ?? sess.resumeHint ?? null,
          agentId: l.id,
          row: 'agent',
          label: 'background agent',
          kind: 'killed',
          detail:
            `stopped by Orchard: its tool calls were refused ${l.refusals} time(s) because Orchard was not attached to this session, ` +
            `so it could not do any more work (${l.stoppedAt ? 'the engine confirmed the stop' : 'the stop was sent but not confirmed'})`,
          at: Date.parse(t.endedAt) || Date.now(),
        });
      }
      if (Number(t.refusals) > 0 && !lanes.some((l) => l.stopRequestedAt)) {
        outcomes.record({
          stationSessionId: sess.stationSessionId ?? null,
          sdkSessionId: sess.sdkSessionId ?? sess.resumeHint ?? null,
          agentId: 'main',
          row: 'main',
          label: 'main',
          kind: 'unknown',
          detail: `the session ended after ${t.refusals} tool call(s) were refused because Orchard was not attached (${t.reason})`,
          at: Date.parse(t.endedAt) || Date.now(),
        });
      }
    } catch { /* the store is best effort; the file is still consumed below */ }
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    n++;
  }
  return n;
}

/*
 * ARCH-001 — `probeSurvivorHost()` and the local `pidAlive()` used to live
 * here. They are now `livenessOfSurvivor()` / `pidAlive()` in `liveness.ts`:
 * the SAME rungs the bridge site uses, so a third state-holder cannot repeat
 * BUG-038's mistake by inventing its own.
 */

/**
 * Dispose of a survivor the authority has PROVEN dead.
 *
 * Two halves, and the first one matters: if the broker's own process is somehow
 * still around, SIGTERM it. Its CLI is gone, so it has nothing left to mind —
 * and before ARCH-001 a corpse like that was still returned by
 * `scanSurvivingHosts`, so boot's `adoptSurvivingHosts` reaped it as a matter
 * of course. Now that the scan drops it on sight, nothing else would ever
 * signal it, and it would sit in its own systemd scope forever: exactly the
 * "two claude-station-host-* scopes alive, one live session" leak BUG-038
 * observed. Then sweep its files, so it stops misleading the next reader and
 * stops blocking sends.
 */
/*
 * BUG-117 — the corpse sweep is ENTITLED too, and this is the choke point.
 *
 * The original fix gated `adoptSurvivingHosts`, but that gate only filters the
 * records `scanSurvivingHosts()` RETURNS — and the scan destroys anything it
 * judges dead on the way past, before the gate is ever consulted. So the
 * ownership check had a bypass that was reachable from `/api/health`, not just
 * from boot: a record whose declared state is `exited` while its pid is still
 * running (exactly the ARCH-001 shape) was SIGTERMed and deleted by any server
 * that could see it, owner or not. Same entitlement as adoption: a server may
 * only sweep corpses it can prove are its own.
 */
export function dropDeadSurvivorHost(st: HostStatus, me: HostOwner = hostOwner()): void {
  if (!ownerEntitlesAdoption(st, me)) return;
  if (pidAlive(st.hostPid)) {
    try { process.kill(st.hostPid, 'SIGTERM'); } catch { /* already gone */ }
  }
  cleanupHostFiles(st);
}

/** SIGTERM a broker so it gracefully drains its CLI's current turn and exits. */
export function reapHost(statusPath: string): void {
  let st: HostStatus | null = null;
  try { st = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as HostStatus; } catch { return; }
  if (!st || !Number.isInteger(st.hostPid)) return;
  if (!pidAlive(st.hostPid)) return;
  try { process.kill(st.hostPid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Every surviving broker that is NOT proven dead, sweeping the corpses it finds.
 *
 * ARCH-001: this used to be `pidAlive(hostPid)` and nothing else — so a broker
 * whose CLI had already exited (or which had itself recorded `state:'exited'`)
 * stayed in the list, and `/api/health` + `doctor` presented it as "SURVIVED a
 * restart … turn draining" while nothing was running. That is BUG-038's bug at
 * a third site; it is now the authority's single verdict, and a proven-dead
 * record is swept here instead of lingering to mislead the next reader.
 */
export function scanSurvivingHosts(): HostStatus[] {
  const dir = hostsDir();
  let names: string[] = [];
  const me = hostOwner(); // BUG-117: computed once — the sweep below is entitlement-gated
  // BUG-187 L2: tombstones are consumed into the outcome store, never read as hosts.
  try { consumeTombstones(me); } catch { /* best effort */ }
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.ctl.json') && !n.endsWith('.ended.json')); } catch { return []; }
  const out: HostStatus[] = [];
  for (const n of names) {
    let st: HostStatus | null = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as HostStatus; } catch { continue; }
    if (!st || !Number.isInteger(st.hostPid)) continue;
    if (livenessOfSurvivor(st).state === 'dead') dropDeadSurvivorHost(st, me); // a corpse: signal + tidy, never report it as running
    else out.push(st);
  }
  return out;
}

/**
 * The still-alive surviving broker (if any) that is driving a `claude` CLI on
 * the given on-disk `sdkSessionId` — i.e. the process still writing that
 * transcript file. Used by the WS `start`/resume guard so a resume that arrives
 * while a prior server's survivor is still draining (or awaiting boot re-adopt)
 * is refused instead of spawning a SECOND `claude --resume` onto the same
 * transcript (BUG-022 — the two would interleave and lose the in-flight turn).
 *
 * Matches on the broker-recorded `sdkSessionId` (the actual transcript id) and,
 * as a belt-and-braces guard for the brief pre-`init` window where that is not
 * yet known, on a non-null `resumeHint` (the id the CLI was told to resume,
 * which for a non-fork resume is the same file). Only brokers whose host process
 * is still alive are considered — a fully drained + reaped survivor is gone from
 * the scan and no longer blocks resumes.
 */
export function survivingHostForSdkSession(sdkSessionId: string): HostStatus | null {
  if (!sdkSessionId) return null;
  for (const st of scanSurvivingHosts()) {
    if (st.sdkSessionId === sdkSessionId) return st;
    if (st.resumeHint && st.resumeHint === sdkSessionId) return st;
  }
  return null;
}

/**
 * BUG-072 — the same lookup for a surface that only has "the id the tab is
 * looking at", which may be the STATION id (a tab that lived through the
 * restart still holds it) or the SDK id. Same records, same scan; used by the
 * read-only running/health surfaces, never by the send guard (that one matches
 * the sdk id deliberately, because it is the transcript's identity).
 */
export function survivingHostForSession(id: string): HostStatus | null {
  if (!id) return null;
  for (const st of scanSurvivingHosts()) {
    if (st.sdkSessionId === id) return st;
    if (st.resumeHint && st.resumeHint === id) return st;
    if (st.stationSessionId && st.stationSessionId === id) return st;
  }
  return null;
}

/*
 * BUG-117 — the delete targets are CONFINED to this server's own hosts dir.
 *
 * `st.status` is an absolute path read out of the record's own JSON, and this
 * function used to `rmSync` it and its three siblings wherever it pointed. So
 * the hosts-dir scoping that BUG-114's context pack calls the isolation
 * boundary was defeated by a path stored in data: a record sitting in a scratch
 * hosts dir names the REAL one, and a scratch server deletes the user's live
 * host's `.json`/`.sock`/`.err`/`.ctl.json`. That is not hypothetical — it
 * happened to this machine's live session on 2026-08-25 while this ticket was
 * being verified, and the unlinked socket inode was not recoverable without
 * restarting the user's broker.
 *
 * A record may only ever cause deletions inside the directory it was found in.
 */
function cleanupHostFiles(st: HostStatus): void {
  const dir = hostsDir();
  if (!st.status || !isInside(dir, st.status)) return;
  const base = st.status.replace(/\.json$/, '');
  for (const f of [st.status, `${base}.sock`, `${base}.err`, `${base}.ctl.json`]) {
    if (!isInside(dir, f)) continue;
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * On server boot, re-adopt every surviving broker: log it, then gracefully reap
 * it so its in-flight turn drains to completion and the CLI writes its final
 * transcript. This finalises the thread (no orphaned CLI left idling, no lost
 * work) and makes it continue by normal resume-from-disk. Returns the count.
 *
 * `log` lets the caller surface each re-adopt; kept side-effect-light so a boot
 * with no survivors is a no-op.
 */
export type AdoptDisposition = 'adopted' | 'responder-only' | 'refused' | 'reaped';
export function adoptSurvivingHosts(
  log: (msg: string) => void = () => {},
  /**
   * BUG-187 S2 — when given, a surviving broker that holds live work (see
   * `survivorNeedsAdoption`) is handed to this callback to be ADOPTED (a
   * responder re-attached) instead of being SIGTERMed. Idle survivors are reaped
   * as before. Omitted = the pre-BUG-187 behaviour (reap everything).
   */
  adopt?: (st: HostStatus, why: string) => void,
): number {
  const me = hostOwner();
  const alive: HostStatus[] = [];
  for (const st of scanSurvivingHosts()) {
    /*
     * BUG-117 — entitlement, not mere presence. Before this, every record in the
     * resolved hosts dir was reaped unconditionally, so a server that resolved
     * that dir by ACCIDENT (a misspelled isolation knob) drained the user's live
     * session at boot. A host this server is not entitled to is left strictly
     * alone and named in the log, so the skip is visible rather than silent.
     */
    if (!ownerEntitlesAdoption(st, me)) {
      log(
        `[orchard] NOT adopting surviving session host (broker pid ${st.hostPid}, state ${st.state}) — ` +
        `it was created by a different server (owner ${st.owner ? `port ${st.owner.port}, ${st.owner.mode}` : 'unrecorded (pre-BUG-117)'}) ` +
        `and this server (port ${me.port}, ${me.mode} data dir) has no claim on it. Leaving it running.`,
      );
      /*
       * BUG-117 residual, made LOUD rather than left silent. The entitlement key
       * is (data dir, port) — port has to be in it, because dropping it is
       * exactly the hole this ticket closed: a stray shared boot in the real data
       * dir would adopt the user's live host again. But that means changing the
       * production service's PORT strands every host stamped with the old one:
       * unadoptable forever, and — because they are `shared`-owned — deliberately
       * exempt from BUG-114's orphan bound, so nothing else bounds them either.
       * That is the user's own brokers holding a CLI with no one able to reclaim
       * them. It cannot be auto-healed without reopening the hole, so it is
       * announced with the one remedy that is safe.
       */
      if (
        st.owner && me.mode === 'shared' && st.owner.mode === 'shared' &&
        st.owner.dataDir === me.dataDir && st.owner.port !== me.port
      ) {
        log(
          `[orchard] WARNING: that host was created by a SHARED server in THIS data dir on port ` +
          `${st.owner.port}, and this server is on port ${me.port}. If the service's PORT changed, its own ` +
          `hosts can never be reclaimed and nothing will bound them — reap them deliberately by pid, or ` +
          `restart the service on port ${st.owner.port} once to let it drain them.`,
        );
      }
      continue;
    }
    alive.push(st);
  }
  for (const st of alive) {
    const need = adopt ? survivorNeedsAdoption(st) : { adopt: false, why: 'adoption not offered' };
    if (adopt && need.adopt) {
      log(
        `[orchard] re-adopting surviving session host (broker pid ${st.hostPid}, CLI pid ${st.claudePid ?? '?'}, ` +
        `state ${st.state}, protocol ${st.protocol ?? 1}) — ${need.why}: re-attaching a responder instead of draining it`,
      );
      try { adopt(st, need.why); } catch (err) {
        // Could not even attempt the adoption: the pre-BUG-187 graceful reap (its drain holds while lanes live).
        log(`[orchard] adoption of broker pid ${st.hostPid} could not be attempted (${(err as Error).message}) — falling back to the graceful reap`);
        reapHost(st.status);
      }
      continue;
    }
    log(
      `[orchard] re-adopting surviving session host (broker pid ${st.hostPid}, CLI pid ${st.claudePid ?? '?'}, ` +
      `state ${st.state}) — draining its in-flight turn to completion; the thread continues via resume-from-disk (${need.why})`,
    );
    reapHost(st.status);
  }
  return alive.length;
}
