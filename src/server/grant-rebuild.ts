/**
 * FEAT-175 — A CONTAINER FOLLOWS ITS GIT-WRITE GRANT, BUT NEVER UNDER LIVE WORK.
 *
 * r2 REDESIGN (independent adjudication after IV run 01a12c66: property 3 broke twice — a project-list read
 * failure after a revoke lost the revoke; a restart with a revoke pending plus docker unreadable held nothing).
 * Both came from EDGE detection (a grant fingerprint diff that one failed read could consume) and from unknown
 * state failing OPEN. This module is now LEVEL-based over two declared facts:
 *
 *   DESIRED  the mode the grant asks for now: `cm.desiredGitMode(project)` ('rw' under a scoped standing grant
 *            or a live duration grant, else 'ro'), read LIVE at every use. Timed grants die with the server,
 *            so after a restart desired is 'ro' by construction. Any read failure → 'unknown'.
 *   ACTUAL   the mode the container was CREATED with: declared in its `claude-station.git-mode` label and
 *            reported synchronously by container-manager at create (`onContainerGitMode`), refreshed by a docker
 *            read every tick. The cache starts 'unknown'; any docker or registry error resets it to 'unknown'.
 *
 *   HOLD     hold(P) = phase(P) ∈ {rebuilding, failed}  ∨  (desired ≠ rw ∧ actual ∉ {ro, none}).
 *            Read at the chokepoints (AgentSession.send/sendGated, startSessionAdmitting, the outbox probe).
 *            Unknown on either side fails CLOSED: a container whose .git may be writable takes no new turn
 *            unless the grant positively says rw. Every hold is a retryable 'rebuild-hold' refusal, so typed
 *            input lands in the durable outbox and is delivered afterwards in order.
 *   RECONCILE whenever desired and actual are both known and differ, the project is PENDING; it is recreated
 *            at the first moment every session of it is idle (no turn, no `working` agent, closeLifetime 'no',
 *            no delivery/resume in flight, every lease attached to such a session). Idle sessions are closed
 *            resumably (FEAT-160 reap) and resume on their next message. The automatic path never passes
 *            forceOver (no TERM/KILL); only the user's "Rebuild now" does.
 *
 * Deleted with the redesign: grant fingerprints and change sets, the unevaluated carry, drift signatures,
 * the pending-state file, and cause inference. Nothing is remembered that the two facts do not already say.
 *
 * Cards (Needs-You): a failed rebuild; a blocker the rebuild will not stop by itself (a background shell, an
 * unknown lifetime, a stray lease); a read-only change still waiting after 10 min (git writes past the grant's
 * end); and ACTUAL unknown for more than 2 min (turns are held and Orchard cannot read why).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Phase = 'pending' | 'rebuilding' | 'failed';
export type Mode = 'ro' | 'rw';
export type Actual = Mode | 'none' | 'unknown';
export type Desired = Mode | 'unknown';
/**
 * BUG-254 r4 — the project container's credential (single-file) bind drift, an
 * orthogonal reason to recreate-when-idle: 'stale' (a proven host↔container
 * inode mismatch — the account `.credentials.json` was replaced on the host and
 * the running container still holds the old frozen inode, so every session in it
 * fails "expired"), 'unknown' (the container could not be read to decide — kept
 * PENDING and retried, never recreated on), or 'clean'. It NEVER holds turns
 * (unlike the git tightening): a stale credential does not make .git writable,
 * and the fix is a recreate once the project is idle, not a gate on new work.
 */
export type CredDrift = 'clean' | 'stale' | 'unknown';
export type BlockerKind = 'turn' | 'agent' | 'shell' | 'unknown' | 'lease' | 'delivery' | 'starting';

export interface Blocker { kind: BlockerKind; label: string; sessionId?: string }

export interface SessionLike {
  id: string;
  label: string;
  sdkKey: string | null;
  closed: boolean;
  busy: boolean;
  working(): boolean;
  /** Identity of the turn running now (e.g. its start time); used to tell "the turn the user saw" from a later one. */
  turnKey?(): string | number | null;
  closeLifetime(): Promise<{ lifetime: 'yes' | 'unknown' | 'no'; source: string }>;
  close(reason: string, opts: { resumable: true }): Promise<void>;
}
export interface LeaseLike { id: string; state: 'reserved' | 'attached' | 'draining'; sessionId: string | null; createdAt: number; orphan: boolean }
export interface ProjectLike { id: string; name: string; isolation: string }

export interface GrantRebuildDeps<P extends ProjectLike = ProjectLike> {
  /** Throws when the registry cannot be read. */
  listProjects(): P[];
  /** The desired mode now; throws (→ 'unknown') when the project or its grant cannot be read. */
  desiredOf(projectId: string): Mode;
  /** The container's actual mode from docker: 'unknown' on any read error. */
  readActual(p: P): Actual;
  /**
   * BUG-254 r4 — the credential-bind drift read LIVE from docker. Optional: absent
   * means this reconciler instance only follows git-write grants (the FEAT-175
   * behaviour). 'stale' recreates when idle; 'unknown' is retried and never acted
   * on; 'clean' lets the entry drop.
   */
  readCredDrift?(p: P): CredDrift;
  /**
   * BUG-254 r4/r9 — true once boot lease-recovery has run. EVERY recreate (a git-mode
   * mismatch as much as a stale credential) is withheld until then, so a restart's
   * surviving (recovered) leases are in place before the reconciler could ever
   * close/recreate a container under a survivor it cannot yet see. Absent = always
   * ready (a git-only instance that wires no leasesReady needs no gate).
   */
  leasesReady?(): boolean;
  sessionsOf(projectId: string): SessionLike[];
  leasesOf(projectId: string): LeaseLike[];
  deliveryBusy(sdkKey: string): boolean;
  reserve(sdkKey: string): () => void;
  recreate(p: P, opts: { force: boolean; captured: string[]; onLog: (s: string) => void }): Promise<void>;
  settled(projectId: string, sdkKeys: string[]): void;
  logFile?: string | null;
  now?: () => number;
  log?: (s: string) => void;
  leaseSettleMs?: number;
  tickMs?: number;
}

interface Entry {
  projectId: string;
  projectName: string;
  phase: Phase;
  desired: Mode;
  /** This entry is (also) reconciling a git-write grant mismatch, not only a credential bind. */
  gitDriven: boolean;
  /** BUG-254 r4 — the last credential-bind drift read; 'stale' recreates when idle, 'unknown' is retried. */
  cred: CredDrift;
  since: number;
  blockers: Blocker[];
  strayBlockedSince: number | null;
  error: string | null;
  attempts: number;
  nextTryAt: number;
  driving: boolean;
}

/*
 * IV 1d4639a9 (property 1): a refused "Rebuild now" stayed ARMED as a flag on the entry and a later ordinary
 * pass force-recreated the container in the middle of a NEW turn. A force is now a ONE-SHOT INTENT bound to the
 * user's single press: an argument of exactly one drive pass, never stored. It carries what the user saw — which
 * sessions existed and which turn each was running — and every outcome of that pass (refused, dropped as stale
 * or superseded, failed, completed) consumes it and is reported back to the user.
 */
interface ForcePress {
  at: number;
  /** session id → the turn it was running at the press (null = idle). */
  turns: Map<string, string | number | null>;
  decide(outcome: string): void;
}
const FORCE_TTL_MS = 30_000;

export interface GrantRebuildView {
  phase: Phase | 'unknown';
  holds: boolean;
  tightens: boolean;
  desired: Desired;
  actual: Actual;
  since: string;
  message: string;
  waitingOn: string[];
  error: string | null;
  nextTryAt: string | null;
}

export interface GrantRebuildRailItem {
  id: string;
  projectId: string;
  projectName: string;
  severity: 'high' | 'medium';
  title: string;
  question: string;
  actions: Array<{ id: 'retry' | 'force'; label: string }>;
}

export class RebuildHoldError extends Error {
  readonly retryable = true;
  readonly code = 'rebuild-hold';
  constructor(message: string) { super(message); this.name = 'RebuildHoldError'; }
}
export class RebuildGateError extends Error {
  readonly code: 'rebuild-failed' | 'abandoned';
  constructor(code: 'rebuild-failed' | 'abandoned', message: string) { super(message); this.code = code; this.name = 'RebuildGateError'; }
}

const OVERRUN_CARD_MS = 10 * 60_000;
const UNKNOWN_CARD_MS = 2 * 60_000;
const STRAY_LEASE_GRACE_MS = 60_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

export function createGrantRebuild<P extends ProjectLike>(deps: GrantRebuildDeps<P>) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((s: string) => console.log(s));
  const entries = new Map<string, Entry>();
  /** ACTUAL mode cache. Absent = 'unknown' (the start state). */
  const actual = new Map<string, Actual>();
  const unknownSince = new Map<string, number>();
  const names = new Map<string, string>();
  const reaped = new Set<string>();
  const waiters = new Set<() => void>();
  let timer: NodeJS.Timeout | null = null;

  const wake = () => { for (const w of [...waiters]) w(); };
  const actualOf = (id: string): Actual => actual.get(id) ?? 'unknown';
  function setActual(id: string, a: Actual): void {
    actual.set(id, a);
    if (a === 'unknown') { if (!unknownSince.has(id)) unknownSince.set(id, now()); } else unknownSince.delete(id);
  }
  function desiredOf(id: string): Desired {
    try { const d = deps.desiredOf(id); return d === 'rw' || d === 'ro' ? d : 'unknown'; } catch { return 'unknown'; }
  }
  /** BUG-254 r4 — live credential-bind drift; any read surprise is 'unknown' (retried, never recreated on). */
  function credOf(p: P): CredDrift {
    if (!deps.readCredDrift) return 'clean';
    try { const c = deps.readCredDrift(p); return c === 'stale' || c === 'unknown' ? c : 'clean'; } catch { return 'unknown'; }
  }
  /**
   * BUG-254 r9 — the reconciler may ACT (recreate) at all only once boot lease-recovery has run. Until then
   * a restart's surviving session and its lease are not yet recovered, so sessionsOf()/leasesOf() are
   * known-incomplete and acting on ANY reason could close/recreate under a survivor this reconciler cannot
   * yet see. (r4 gated only the credential reason; r8's independent verify broke the un-gated git path in
   * this exact window.) Absent = always ready (a git-only instance that wires no leasesReady needs no gate).
   */
  const reconcileReady = () => (deps.leasesReady ? deps.leasesReady() : true);

  function audit(event: string, e: Entry | null, extra: Record<string, unknown> = {}): void {
    if (!deps.logFile) return;
    try {
      fs.mkdirSync(path.dirname(deps.logFile), { recursive: true });
      fs.appendFileSync(deps.logFile, JSON.stringify({
        at: new Date(now()).toISOString(), event,
        ...(e ? { projectId: e.projectId, project: e.projectName, phase: e.phase, desired: e.desired, tightens: e.desired === 'ro' } : {}),
        ...extra,
      }) + '\n');
    } catch { /* the console line is the fallback */ }
  }

  function drop(e: Entry, why: string): void {
    entries.delete(e.projectId);
    log(`[orchard] FEAT-175: ${e.projectName}: grant rebuild ${why}`);
    audit('cleared', e, { why, waitedMs: now() - e.since });
    deps.settled(e.projectId, []);
    wake();
  }

  /* ------------------------------------------------------------ the HOLD rule */

  function holdOf(projectId: string): { message: string; reason: 'rebuilding' | 'failed' | 'mismatch' | 'unknown' } | null {
    const e = entries.get(projectId);
    if (e?.phase === 'rebuilding') return { reason: 'rebuilding', message: 'Rebuilding the container for the git-write grant change (any pending image change applies too). Messages are saved and sent when it is ready.' };
    if (e?.phase === 'failed') return { reason: 'failed', message: `Rebuilding the container for the git-write grant failed: ${e.error ?? 'unknown error'}. New messages and sessions wait (nothing typed is lost); it retries automatically.` };
    const d = desiredOf(projectId);
    const a = actualOf(projectId);
    if (d === 'rw' || a === 'ro' || a === 'none') return null;
    if (a === 'unknown' || d === 'unknown') {
      return { reason: 'unknown', message: `Orchard cannot confirm right now that this container's .git is read-only (${a === 'unknown' ? 'its container state could not be read' : 'its git-write grant could not be read'}), so new messages and sessions wait until it can. Nothing typed is lost.` };
    }
    const who = e?.blockers.length ? ` Waiting on: ${e.blockers.map((b) => b.label).join('; ')}.` : '';
    return { reason: 'mismatch', message: `Git writes are being turned off in this container (its git-write grant ended or was revoked). It is recreated with a read-only .git once no session is working; new messages and sessions wait until then.${who}` };
  }

  /* ------------------------------------------------------------ reconcile */

  function tick(): void {
    let projects: P[];
    try { projects = deps.listProjects(); } catch {
      for (const id of new Set([...actual.keys(), ...entries.keys()])) setActual(id, 'unknown'); // registry error → unknown
      wake();
      return;
    }
    const seen = new Set<string>();
    for (const p of projects) {
      if (p.isolation !== 'container') continue;
      seen.add(p.id);
      names.set(p.id, p.name);
      const e = entries.get(p.id);
      let cred: CredDrift = 'clean';
      if (!(e && (e.phase === 'rebuilding' || e.driving))) {
        let a: Actual;
        try { a = deps.readActual(p); } catch { a = 'unknown'; }
        setActual(p.id, a);
        cred = credOf(p);
      }
      if (e && (e.phase === 'rebuilding' || e.driving)) continue;
      const d = desiredOf(p.id);
      const a = actualOf(p.id);
      const mismatch = d !== 'unknown' && (a === 'ro' || a === 'rw') && d !== a;
      // BUG-254 r4 — credential drift is a SECOND reason to recreate when idle, orthogonal to the
      // git grant. 'stale' or 'unknown' keeps an entry PENDING (unknown is retried, never recreated on);
      // it never holds turns (holdOf is git-only). A recreate heals both reasons at once.
      const credActive = (cred === 'stale' || cred === 'unknown') && a !== 'none';
      if (!e && (mismatch || credActive)) {
        add(p, mismatch ? d : (a === 'ro' || a === 'rw' ? a : 'ro'), { gitDriven: mismatch, cred });
      } else if (e && e.phase === 'pending') {
        e.cred = cred;
        e.gitDriven = mismatch;
        if (mismatch) e.desired = d;
        if (!mismatch && !credActive) {
          if (a === 'unknown' || d === 'unknown') continue; // cannot tell git: keep it (and its hold rule) as it is
          drop(e, a === 'none' ? 'cancelled: there is no container (the next start creates it with the current grant)' : 'cancelled: the container already matches the grant and credential');
        }
      } else if (e && e.phase === 'failed') {
        e.cred = cred;
        // BUG-254 r6 — when git is KNOWN to match (d known, a===d), a FAILED entry must not keep holding
        // turns on credential uncertainty: drop it on a CLEAN cred; DOWNGRADE failed->pending on an
        // 'unknown' cred (clears the 'failed' turn-hold and the fixed 3s-retry churn, keeps reprobing);
        // keep 'failed' only on a PROVEN stale bind (a legitimate recreate the next drive() retries).
        if (d !== 'unknown' && a === d) {
          if (cred === 'clean') drop(e, 'resolved: the container now matches the grant');
          else if (cred === 'unknown') { e.phase = 'pending'; e.error = null; e.nextTryAt = 0; audit('pending', e, { from: 'failed', why: 'credential probe unknown while git matches' }); }
          // cred === 'stale': stays failed; drive() recreates on the proven drift
        }
      }
    }
    for (const id of [...actual.keys()]) if (!seen.has(id)) { actual.delete(id); unknownSince.delete(id); }
    for (const [id, e] of entries) if (!seen.has(id) && e.phase !== 'rebuilding') drop(e, 'cancelled: the project is gone or no longer uses a container');
    for (const e of [...entries.values()]) void drive(e);
    wake();
  }

  function add(p: P, d: Mode, how: { gitDriven: boolean; cred: CredDrift }): void {
    const e: Entry = {
      projectId: p.id, projectName: p.name, phase: 'pending', desired: d, gitDriven: how.gitDriven, cred: how.cred,
      since: now(), blockers: [], strayBlockedSince: null,
      error: null, attempts: 0, nextTryAt: 0, driving: false,
    };
    entries.set(p.id, e);
    if (how.gitDriven) {
      log(`[orchard] FEAT-175: ${p.name}: container .git is ${d === 'ro' ? 'rw' : 'ro'} but the grant wants ${d}; it is recreated once no session is working` +
        (d === 'ro' ? ' — new turns and starts are held until then' : ''));
    } else {
      // BUG-254 r4 — a credential-bind recreate never holds turns: it is announced, not gated.
      log(`[orchard] BUG-254: ${p.name}: the container's bound credential is ${how.cred === 'stale' ? 'stale (the account credential was replaced on the host)' : 'unreadable right now'}; ` +
        (how.cred === 'stale' ? 'it is recreated once no session is working — new turns are NOT held' : 'it will be re-checked (no recreate until the drift is proven)'));
    }
    audit('pending', e);
    wake();
  }

  /* ------------------------------------------------------------- idleness */

  function syncBlockers(projectId: string, sessions: SessionLike[], force: boolean): Blocker[] {
    const out: Blocker[] = [];
    for (const s of sessions) {
      if (!s.sdkKey) { out.push({ kind: 'starting', label: `${s.label} is starting`, sessionId: s.id }); continue; }
      if (deps.deliveryBusy(s.sdkKey)) { out.push({ kind: 'delivery', label: `a message is being delivered into ${s.label}`, sessionId: s.id }); continue; }
      if (force) continue;
      if (s.busy) out.push({ kind: 'turn', label: `${s.label} is running a turn`, sessionId: s.id });
      else if (s.working()) out.push({ kind: 'agent', label: `${s.label} has a background agent working`, sessionId: s.id });
    }
    if (!force) {
      for (const l of deps.leasesOf(projectId)) {
        if (l.state === 'attached' && sessions.some((s) => s.id === l.sessionId)) continue;
        out.push({ kind: 'lease', label: l.state === 'draining' ? `processes of a closed session are still running in the container (${l.id})` : l.state === 'reserved' ? `a session is being admitted (${l.id})` : `an exec holds the container (${l.id})` });
      }
    }
    return out;
  }

  function noteBlockers(e: Entry, blockers: Blocker[]): void {
    e.blockers = blockers;
    const stray = blockers.some((b) => b.kind === 'shell' || b.kind === 'unknown' || b.kind === 'lease');
    if (!stray) e.strayBlockedSince = null;
    else if (e.strayBlockedSince === null) e.strayBlockedSince = now();
  }

  function turnOf(s: SessionLike): string | number | null {
    if (!s.busy && !s.working()) return null;
    try { return s.turnKey?.() ?? 'busy'; } catch { return 'busy'; }
  }
  /** Why a press no longer stands for what is running now (null = it still does). */
  function forceStale(press: ForcePress, sessions: SessionLike[]): string | null {
    if (now() - press.at > FORCE_TTL_MS) return 'the press is too old';
    for (const s of sessions) {
      if (!press.turns.has(s.id)) return `${s.label} started after you pressed`;
      const t = turnOf(s);
      if (t !== null && t !== press.turns.get(s.id)) return `${s.label} began a different turn after you pressed`;
    }
    return null;
  }

  async function drive(e: Entry, press?: ForcePress): Promise<void> {
    let outcome = 'nothing to do: the container already matches the grant';
    const said = (o: string) => { outcome = o; };
    if (e.driving || e.phase === 'rebuilding') { press?.decide('refused: a rebuild of this project is already in progress — press again in a moment'); return; }
    if (now() < e.nextTryAt && !press) return;
    e.driving = true;
    try {
      let project: P | null;
      try { project = deps.listProjects().find((p) => p.id === e.projectId) ?? null; } catch { return; } // unreadable: try later
      if (!project || project.isolation !== 'container') { said('refused: the project is gone or no longer uses a container'); drop(e, 'cancelled: the project is gone or no longer uses a container'); return; }
      // LEVEL: act only on the facts as they are now.
      const d = desiredOf(e.projectId);
      const a0 = actualOf(e.projectId);
      if (d === 'unknown' || a0 === 'unknown') { said('refused: the grant or the container state cannot be read right now'); return; }
      // BUG-254 r4 — a PROVEN stale credential bind recreates even when the git mode already matches. An
      // 'unknown' credential never recreates here — it is kept pending and retried by the next tick. (The
      // lease-recovery readiness condition is no longer scoped to this reason; it now gates EVERY recreate
      // below — see reconcileReady, BUG-254 r9.)
      const credStale = e.cred === 'stale';
      if (e.phase === 'pending' && a0 === 'none') return; // no container to act on; the next start binds fresh
      // BUG-254 r6 — PHASE-INDEPENDENT: when git is KNOWN to match (a0===d) and the credential is not
      // PROVEN stale (clean or 'unknown'), never recreate — in ANY phase. The r5 break was a FAILED entry
      // with git-matching + an 'unknown' cred probe sliding past a pending-only guard and recreating.
      // Invariant: credential UNCERTAINTY alone never recreates (nor, via the tick downgrade, holds turns)
      // WHEN GIT IS KNOWN TO MATCH. A real git mismatch (incl a0==='none') still has a0!==d and passes.
      if (a0 === d && !credStale) return;
      // BUG-254 r9 (independent design review) — hold EVERY recreate reason (git mismatch AND stale
      // credential) until boot lease-recovery has run. A no-op (a0===d, clean cred) already returned above,
      // so only a real action reaches here; if recovery has not finished, its idleness inputs are incomplete
      // and it must not act — kept pending, retried the moment recovery flips ready (seconds). A user force
      // is told explicitly and does NOT bypass this (even force cannot protect a survivor it cannot see yet).
      if (!reconcileReady()) {
        if (press) press.decide('refused: Orchard is still recovering surviving sessions after a restart — press again in a moment');
        return;
      }
      e.desired = d;
      const force = !!press;
      const live = () => deps.sessionsOf(e.projectId).filter((s) => !s.closed);
      let sessions = live();
      let checked: Set<string> | null = null;
      if (press) { const why = forceStale(press, sessions); if (why) { said(`dropped: ${why} — nothing was stopped; press again if you still want it`); return; } }
      let blockers = syncBlockers(e.projectId, sessions, force);
      if (blockers.length) { noteBlockers(e, blockers); said(`refused: ${blockers.map((b) => b.label).join('; ')} — nothing was stopped; press again once that is done`); return; }
      if (!force) {
        const lifetimes: Blocker[] = [];
        checked = new Set(sessions.map((s) => s.id));
        for (const s of sessions) {
          let cl: { lifetime: 'yes' | 'unknown' | 'no'; source: string };
          try { cl = await s.closeLifetime(); } catch (err) { cl = { lifetime: 'unknown', source: (err as Error).message }; }
          if (cl.lifetime === 'yes') lifetimes.push({ kind: 'shell', label: `${s.label} has background work the rebuild would stop (${cl.source})`, sessionId: s.id });
          else if (cl.lifetime === 'unknown') lifetimes.push({ kind: 'unknown', label: `${s.label} may have background work (${cl.source})`, sessionId: s.id });
        }
        if (lifetimes.length) { noteBlockers(e, lifetimes); return; }
      }
      if (!entries.has(e.projectId)) { said('dropped: the rebuild is no longer needed'); return; }
      // THE FINAL CHECK and the reap are one synchronous step: nothing can start a turn in between.
      if (desiredOf(e.projectId) !== e.desired) { said('dropped: the grant changed — nothing was stopped'); return; } // next tick decides
      sessions = live();
      if (press) { const why = forceStale(press, sessions); if (why) { said(`dropped: ${why} — nothing was stopped; press again if you still want it`); return; } }
      blockers = syncBlockers(e.projectId, sessions, force);
      // A session that appeared while the lifetimes were awaited was never asked: never reap it unasked.
      if (!force && checked) for (const s of sessions) if (!checked.has(s.id)) blockers.push({ kind: 'starting', label: `${s.label} started while the rebuild was being prepared`, sessionId: s.id });
      if (blockers.length) { noteBlockers(e, blockers); said(`refused: ${blockers.map((b) => b.label).join('; ')} — nothing was stopped`); return; }
      const keys = sessions.map((s) => s.sdkKey).filter((k): k is string => !!k);
      const releases = keys.map((k) => deps.reserve(k));
      const captured = deps.leasesOf(e.projectId).map((l) => l.id);
      // BUG-254 r4 — name the real reason: a git-write grant change, a stale credential bind, or both.
      const gitReason = a0 !== e.desired;
      const why = gitReason && credStale ? 'a git-write grant change and a stale credential bind'
        : gitReason ? 'a git-write grant change (FEAT-175)'
        : 'a stale credential bind — the account credential was replaced on the host (BUG-254)';
      e.phase = 'rebuilding';
      e.blockers = [];
      if (press) { press.decide(`recreating the container now — ${sessions.length} session(s) closed; they resume on their next message`); press = undefined; }
      wake();
      const started = now();
      log(`[orchard] FEAT-175/BUG-254: ${e.projectName}: recreating the container for ${why}${gitReason ? ` (.git ${e.desired})` : ''}; ${sessions.length} idle session(s) closed and resumed on their next message${force ? ' — FORCED by the user' : ''}`);
      audit('rebuilding', e, { sessions: sessions.map((s) => s.id), force, gitReason, credStale, waitedMs: started - e.since });
      for (const s of sessions) reaped.add(s.id);
      try {
        await Promise.all(sessions.map((s) => s.close(`the container is being recreated for ${why}`, { resumable: true }).catch(() => {})));
        if (!force) {
          const deadline = now() + (deps.leaseSettleMs ?? 30_000);
          while (deps.leasesOf(e.projectId).some((l) => captured.includes(l.id)) && now() < deadline) await new Promise((r) => setTimeout(r, 250));
        }
        await deps.recreate(project, { force, captured, onLog: (s) => log(s.trimEnd()) });
        // ACTUAL was reported synchronously by the create (recordActual). Nothing is re-read here.
        entries.delete(e.projectId);
        log(`[orchard] FEAT-175: ${e.projectName}: container recreated (.git ${actualOf(e.projectId)}) after waiting ${Math.round((started - e.since) / 1000)}s` +
          (e.desired === 'ro' ? ' — git writes were possible that long past the grant\'s end (over-run logged)' : ''));
        audit('applied', e, { waitedMs: started - e.since, overrunMs: e.desired === 'ro' ? started - e.since : 0, rebuildMs: now() - started, actual: actualOf(e.projectId) });
      } catch (err) {
        const msg = (err as Error).message;
        let a: Actual;
        try { a = deps.readActual(project); } catch { a = 'unknown'; }
        setActual(e.projectId, a);
        e.attempts += 1;
        e.error = msg;
        e.nextTryAt = now() + BACKOFF_MS[Math.min(e.attempts - 1, BACKOFF_MS.length - 1)]!;
        // Refused with the container intact (still the old, known mode): waiting again. Gone, half-made or
        // unreadable: FAILED — the holds stay (fail closed) and it is retried.
        const intact = a === 'ro' || a === 'rw';
        e.phase = intact ? 'pending' : 'failed';
        if (intact) noteBlockers(e, [{ kind: 'lease', label: `the container could not be recreated yet (${msg.slice(0, 200)})` }]);
        log(`[orchard] FEAT-175: ${e.projectName}: recreating the container for the git-write grant ${intact ? 'was refused' : 'FAILED'} (${msg}); retry in ${Math.round((e.nextTryAt - now()) / 1000)}s`);
        audit(intact ? 'refused' : 'failed', e, { error: msg, attempts: e.attempts, actual: a });
      } finally {
        for (const r of releases) { try { r(); } catch { /* released */ } }
        deps.settled(e.projectId, keys);
        wake();
      }
    } finally {
      e.driving = false;
      // The press is consumed by whatever happened in this pass; it is never kept for a later one.
      press?.decide(outcome);
    }
  }

  /* ------------------------------------------------------------ the gates */

  function turnHoldOf(projectId: string): { message: string } | null {
    const h = holdOf(projectId);
    return h ? { message: h.message } : null;
  }
  function assertTurnAllowed(projectId: string): void {
    const h = holdOf(projectId);
    if (h) throw new RebuildHoldError(h.message);
  }
  async function admissionGate(projectId: string, onStatus: (s: string) => void, abandoned: () => boolean = () => false): Promise<void> {
    let said = '';
    for (;;) {
      const h = holdOf(projectId);
      if (!h) return;
      if (h.reason === 'failed') throw new RebuildGateError('rebuild-failed', h.message);
      if (abandoned()) throw new RebuildGateError('abandoned', 'the start was abandoned while it waited for the container rebuild (its socket closed); nothing was run');
      if (h.message !== said) { said = h.message; onStatus(`waiting: ${h.message}`); }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 1000);
        function done() { clearTimeout(t); waiters.delete(done); resolve(); }
        waiters.add(done);
      });
    }
  }

  /* ------------------------------------------------------------- the views */

  function viewOf(projectId: string): GrantRebuildView | null {
    const e = entries.get(projectId);
    const h = holdOf(projectId);
    if (!e && !h) return null;
    const d = desiredOf(projectId);
    const a = actualOf(projectId);
    return {
      phase: e ? e.phase : 'unknown',
      holds: !!h,
      tightens: (e?.desired ?? d) !== 'rw',
      desired: d,
      actual: a,
      since: new Date(e?.since ?? unknownSince.get(projectId) ?? now()).toISOString(),
      message: h?.message ?? `Git-write grant: the container is recreated with a writable .git once no session is working.${e?.blockers.length ? ` Waiting on: ${e.blockers.map((b) => b.label).join('; ')}.` : ''}`,
      waitingOn: e?.blockers.map((b) => b.label) ?? [],
      error: e?.error ?? null,
      nextTryAt: e?.nextTryAt ? new Date(e.nextTryAt).toISOString() : null,
    };
  }

  function railItems(): GrantRebuildRailItem[] {
    const out: GrantRebuildRailItem[] = [];
    const t = now();
    for (const [id, since] of unknownSince) {
      if (t - since < UNKNOWN_CARD_MS) continue;
      if (entries.get(id)?.phase === 'failed') continue;
      const name = names.get(id) ?? id;
      const mins = Math.max(2, Math.round((t - since) / 60_000));
      out.push({ id: `grant-rebuild:${id}`, projectId: id, projectName: name, severity: 'high',
        title: `Orchard cannot read ${name}'s container for ${mins} min`,
        question: `Docker (or the project registry) has not answered for ${mins} minutes, so Orchard cannot confirm this container's .git mode. New messages and sessions on this project are held until it can (nothing typed is lost). Check that Docker is running.`,
        actions: [{ id: 'retry', label: 'Check again' }] });
    }
    for (const e of entries.values()) {
      const base = { id: `grant-rebuild:${e.projectId}`, projectId: e.projectId, projectName: e.projectName };
      if (out.some((x) => x.id === base.id)) continue;
      if (e.phase === 'failed') {
        out.push({ ...base, severity: 'high',
          title: e.gitDriven ? `Container rebuild for the git-write grant failed — ${e.projectName}` : `Container rebuild for a stale credential failed — ${e.projectName}`,
          question: holdOf(e.projectId)?.message ?? `Rebuild failed: ${e.error}`, actions: [{ id: 'retry', label: 'Retry now' }] });
        continue;
      }
      if (e.phase !== 'pending') continue;
      const stray = e.strayBlockedSince !== null && e.blockers.some((b) => b.kind === 'shell' || b.kind === 'unknown' ||
        (b.kind === 'lease' && t - (e.strayBlockedSince ?? t) >= STRAY_LEASE_GRACE_MS));
      // BUG-254 r4 — the "git writes still possible" overrun card is a GIT-grant concern only; a credential
      // recreate neither makes .git writable nor holds turns, so it only ever surfaces a stuck (stray) recreate.
      const overrun = e.gitDriven && e.desired === 'ro' && t - e.since >= OVERRUN_CARD_MS;
      if (!stray && !overrun) continue;
      const mins = Math.max(1, Math.round((t - e.since) / 60_000));
      const msg = viewOf(e.projectId)?.message ?? '';
      if (!e.gitDriven) {
        out.push({ ...base, severity: 'medium',
          title: `A stale credential cannot be healed in ${e.projectName} — something holds the container`,
          question: `${e.projectName}'s container still binds a credential file that was replaced on the host, so sessions in it fail "expired". It is recreated (sessions resume on their next message) once nothing holds the container, but ${e.blockers.map((b) => b.label).join('; ') || 'work'} has held it for ${mins} min. "Rebuild now" closes those sessions and stops what they are running.`,
          actions: [{ id: 'force', label: 'Rebuild now (stops it)' }] });
        continue;
      }
      out.push({
        ...base,
        severity: e.desired === 'ro' ? 'high' : 'medium',
        title: e.desired === 'ro' ? `Git writes still possible in ${e.projectName} — the grant ended ${mins} min ago` : `Git-write grant waiting on running work — ${e.projectName}`,
        question: `${msg} The rebuild never stops work by itself; "Rebuild now" closes those sessions (they resume on their next message) and stops what they are running.`,
        actions: [{ id: 'force', label: e.desired === 'ro' ? 'Stop that work and apply now' : 'Rebuild now (stops it)' }],
      });
    }
    return out;
  }

  /**
   * The user's action. Retry: look again now (still only when idle). Force ("Rebuild now"): ONE drive pass that
   * carries this press; its outcome comes back here and the press is gone, whatever it was.
   */
  async function request(projectId: string, opts: { force: boolean }): Promise<{ view: GrantRebuildView | null; outcome: string }> {
    if (!opts.force) {
      tick();
      const e = entries.get(projectId);
      if (!e) return { view: viewOf(projectId), outcome: 'nothing to retry: the container matches the grant' };
      e.nextTryAt = 0;
      if (!e.driving) void drive(e);
      return { view: viewOf(projectId), outcome: 'retrying: the rebuild runs as soon as no session is working' };
    }
    let e = entries.get(projectId);
    if (!e) { tick(); e = entries.get(projectId); }
    if (!e) return { view: viewOf(projectId), outcome: 'nothing to rebuild: the container matches the grant' };
    const turns = new Map<string, string | number | null>();
    for (const s of deps.sessionsOf(projectId).filter((x) => !x.closed)) turns.set(s.id, turnOf(s));
    const outcome = await new Promise<string>((resolve) => {
      let done = false;
      const decide = (o: string) => { if (!done) { done = true; resolve(o); } };
      void drive(e!, { at: now(), turns, decide });
    });
    log(`[orchard] FEAT-175: ${e.projectName}: "Rebuild now" — ${outcome}`);
    audit('force', e, { outcome });
    return { view: viewOf(projectId), outcome };
  }

  return {
    start(): void {
      if (timer) return;
      tick();
      timer = setInterval(tick, deps.tickMs ?? 3000);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
    nudge(): void { tick(); },
    tick,
    /** container-manager's synchronous report: this project's container now exists with this .git mode. */
    recordActual(projectId: string, mode: Mode): void { setActual(projectId, mode); wake(); },
    turnHoldOf,
    assertTurnAllowed,
    admissionGate,
    viewOf,
    railItems,
    request,
    wasReaped: (sessionId: string) => reaped.has(sessionId),
    _phaseOf: (projectId: string): Phase | null => entries.get(projectId)?.phase ?? null,
    _actualOf: actualOf,
  };
}

export type GrantRebuild = ReturnType<typeof createGrantRebuild>;
