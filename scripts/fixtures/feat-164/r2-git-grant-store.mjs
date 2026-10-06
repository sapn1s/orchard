/**
 * git-grant-store.mjs — FEAT-108 round 2. Runtime, per-project, revocable grants
 * that lift the git-write block WITHOUT relaunching a session.
 *
 * WHY THIS EXISTS (the user, verbatim): "regarding doing git commits, pls change
 * that there is some way for orchestrator to invoke or through subagent, to allow
 * git commands, as it depends per time/project." The round-1 block (git-write-
 * policy.mjs) was all-or-nothing per LAUNCH: the only lift was the env var
 * ORCHARD_ALLOW_GIT_WRITE, which must be set BEFORE the session starts, so a
 * mid-session "please commit" could not be honoured without throwing the session
 * away and relaunching. This adds a grant the user can turn on for a live session.
 *
 * ── WHERE THE GRANT LIVES, AND WHY THAT IS THE WHOLE SELF-GRANT DEFENCE ───────
 * The grant lives ONLY in THIS host-server process's memory. It is deliberately
 * NOT persisted to the registry, NOT to any file under the project, and NOT
 * carried on an environment variable. That single choice closes the two
 * self-grant holes the ticket names:
 *
 *   1. ENV VAR ("an agent can set environment variables for processes it
 *      spawns"). The runtime's git-write decision runs INSIDE this host process
 *      and reads THIS process's grant map. An agent's Bash exporting
 *      ORCHARD_ALLOW_GIT_WRITE=1 (or anything else) only changes the environment
 *      of the CHILD it spawns; it can never reach into the host process's memory
 *      to plant a grant. (The env hatch itself is read from the HOST env at
 *      launch — a child cannot change that either.)
 *
 *   2. WRITING THE CONFIG ITSELF. Because the grant is never read back from the
 *      registry JSON or any on-disk file, an agent that writes
 *      `settings.gitWrite = …` into the registry with its Bash tool grants
 *      nothing: the runtime does not consult that file for the decision. The
 *      only mutator of this map is the dashboard grant route / the CLI, both of
 *      which are explicit USER actions.
 *
 * A server restart clears every grant (the map is memory-only) — deliberately
 * FAIL-CLOSED: the block re-arms on restart and a forgotten grant cannot persist
 * across it. The trade the user set governs: losing a grant is accepted; a
 * silent standing permission is the hazard.
 *
 * RESIDUAL, STATED HONESTLY: the server binds 127.0.0.1 with "no auth tier —
 * deliberately out of scope" (src/server/index.ts). A DIRECT (host) session's
 * Bash therefore has the same localhost reach the user's own browser has, so a
 * determined agent could POST the grant route by curl. That vector is NOT closed
 * by this module — it is neutralised downstream: a granted COMMIT/PUSH still runs
 * the leak gate and is refused on failure (see git-grant.mjs), so the worst a
 * forged grant can produce is a NON-LEAKING commit, never the leak FEAT-108
 * exists to prevent. And every grant + every git write is recorded and announced
 * (below), so a grant is never silent. Container sessions cannot reach the host
 * loopback at all, so they are closed by construction.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** projectKey → active grant. Memory-only; see the header. */
const grants = new Map();
/** Bounded ring of recent agent git writes, for the after-the-fact view. */
const ledger = [];
const LEDGER_CAP = 500;
/** Monotonic id source so a decide-time record can be CONFIRMED later by its
 * executor (the shim), across the two-process split (BUG-184). */
let ledgerSeq = 0;
/**
 * BUG-184 round 3 — a per-HOST-PROCESS random nonce woven into every record id, so
 * ids CANNOT collide across a restart. Without it `ledgerSeq` resets to 0 on a
 * fresh boot and a delayed confirm from BEFORE the restart (`w1`) would land on a
 * DIFFERENT new write that reused the id (attack A3). A new process → a new nonce →
 * old ids never re-mint.
 */
const STORE_BOOT = randomBytes(6).toString('hex');
/**
 * BUG-184 round 3 — id → { token, projectKey } capability binding, held ONLY here
 * and NEVER copied into the public ledger view. The `token` is an unguessable
 * per-record secret returned to the EXECUTOR alone (via the decide response); a
 * confirm must present it AND the owner projectKey to move the record's outcome.
 * This closes the round-2 holes: sequential ids were guessable (A1), and there was
 * no owner binding (A2), so any same-uid peer could forge `executed`/exit 0 for a
 * write that actually failed. Single-use: the capability is DELETED on first
 * confirm, so a replay — even with the real token — is rejected as an anomaly.
 */
const confirmCaps = new Map();

/** Constant-time token compare; false on any type/length mismatch (never throws). */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (candidate.length === 0 || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

/**
 * BUG-184 — a ledger record's lifecycle. The host DECIDES to permit a write, but
 * over the loopback shim path the write EXECUTES in a different process that may
 * abort or fail after the host recorded. So a record's `outcome` is a state
 * machine, and only the executor (ARCH-010: the owner of "did it run") may move a
 * `permitted` record to `executed`/`failed`:
 *   'permitted'    — host authorised it; execution NOT yet observed. A reader must
 *                    NOT read this as a landed commit (the false-proof this ticket
 *                    removes). Stays here forever if the executor never confirms
 *                    (aborted shim consult, dropped callback) — truthful: unknown.
 *   'executed'     — the executor reported git exited 0. The ONLY state meaning the
 *                    write landed.
 *   'failed'       — the executor reported a non-zero / exec-failure git status.
 *   'blocked-gate' — refused at decide because the leak gate failed; never executed.
 */
export const WRITE_OUTCOMES = new Set(['permitted', 'executed', 'failed', 'blocked-gate']);
/** Optional durable sink (index.ts wires this to append a host-side log file). */
let auditSink = null;

/** A hard ceiling so even a "single-use" grant cannot sit armed forever. */
export const MAX_GRANT_MS = 6 * 60 * 60 * 1000; // 6h
/** Default window for a duration grant when the caller names no ttl. */
export const DEFAULT_GRANT_MS = 30 * 60 * 1000; // 30m

/**
 * Grant git writes for a project.
 *   scope 'once'     → the next single permitted git write, then it is spent
 *                      (still bounded by ttl so it cannot linger).
 *   scope 'duration' → every git write until `ttlMs` elapses.
 * `grantedVia` is recorded for the audit trail ('dashboard' | 'cli' | …).
 * Returns the stored grant (a copy).
 */
export function grantGitWrite(projectKey, { scope = 'once', ttlMs, grantedVia = 'user', note = '', now = Date.now() } = {}) {
  if (!projectKey || typeof projectKey !== 'string') throw new Error('grantGitWrite: projectKey required');
  const clampedTtl = Math.min(Math.max(1, Number(ttlMs) || (scope === 'once' ? MAX_GRANT_MS : DEFAULT_GRANT_MS)), MAX_GRANT_MS);
  const grant = {
    projectKey,
    scope: scope === 'duration' ? 'duration' : 'once',
    remainingUses: scope === 'duration' ? Infinity : 1,
    grantedAt: new Date(now).toISOString(),
    expiresAt: now + clampedTtl,
    grantedVia: String(grantedVia || 'user'),
    note: String(note || ''),
  };
  grants.set(projectKey, grant);
  return viewGrant(grant, now);
}

/*
 * ── FEAT-164 — THE PERMANENT GRANT, AND WHY IT IS NOT IN THIS MAP ────────────
 * The user asked for a per-project grant that does not expire. It must survive a
 * restart, so it cannot live in the memory map above: it is a DECLARED PROJECT
 * SETTING (`settings.gitWrite` in the registry, owned by registry.ts and written
 * only by the user-facing grant route). Under ARCH-010 the registry is the one
 * place that holds it; this module READS it at call time through the source
 * index.ts registers and never copies it into the map. So a revoke (the route
 * clearing the setting) bites on the very next git write of a session that is
 * already running, and no second place can hold a different answer.
 *
 * Fail-closed: no source registered, a source that throws (an unreadable or torn
 * registry), or anything other than `{ permanent: true }` reads as "none".
 *
 * RESIDUAL, STATED: reading a grant back from a file reopens self-grant hole 2
 * (header) for a DIRECT (host) session, which can write the registry file with
 * its own uid. That is the same class as the loopback-route residual recorded
 * above, and it is neutralised the same way: a granted commit/push still runs
 * the mandatory leak gate (git-grant.mjs) and is refused on a leak, and every
 * permitted write is recorded and announced. Container sessions reach neither
 * the registry file nor the loopback route.
 */
let permanentSource = null;

/** Register (or clear) the reader of the declared permanent grant. index.ts wires
 * it to the registry's `gitWritePermanentOf`. */
export function setPermanentGrantSource(fn) { permanentSource = typeof fn === 'function' ? fn : null; }

/** The declared permanent grant for a project as a grant view, or null. Never throws. */
export function permanentGrantOf(projectKey) {
  if (!permanentSource || !projectKey) return null;
  let d;
  try { d = permanentSource(projectKey); } catch { return null; }
  if (!d || typeof d !== 'object' || d.permanent !== true) return null;
  return {
    projectKey,
    scope: 'permanent',
    remainingUses: null,
    grantedAt: typeof d.grantedAt === 'string' ? d.grantedAt : null,
    grantedVia: typeof d.grantedVia === 'string' ? d.grantedVia : 'user',
    note: '',
    expiresAt: null,
    expiresInMs: null,
  };
}

/** Remove any TIMED/single-use grant for a project. Returns true if one was
 * present. The permanent grant is a project setting; the route clears that. */
export function revokeGitWrite(projectKey) {
  return grants.delete(projectKey);
}

/*
 * FEAT-164 round 2 — ONE DECISION, ONE INSTANT (ARCH-010). The view peekGrant
 * returns IS the decision: it carries, under this private symbol, the exact grant
 * object it was read from (null when the permanent setting answered). consumeGrant
 * spends only that object and never re-reads grant state. Round 1 re-read the
 * permanent setting at consume time, a second instant after the leak gate had run:
 * a permanent revoke landing in between made the write (correctly authorised by
 * permanent) spend an independent once-grant (independent verify run
 * 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9). A revoke or re-grant after the decision
 * instant does not change that decision; it governs the next one.
 */
const SOURCE = Symbol('git-grant-source');

/**
 * The active grant for a project, or null. Purges an expired one on read so an
 * expired grant is indistinguishable from none. Does NOT consume a single-use
 * grant — the caller consumes (with this same view) only once it permits a write.
 * FEAT-164: a declared permanent grant answers first.
 */
export function peekGrant(projectKey, now = Date.now()) {
  const perm = permanentGrantOf(projectKey);
  if (perm) return Object.defineProperty(perm, SOURCE, { value: null });
  const g = grants.get(projectKey);
  if (!g) return null;
  if (now >= g.expiresAt || g.remainingUses <= 0) { grants.delete(projectKey); return null; }
  return Object.defineProperty(viewGrant(g, now), SOURCE, { value: g });
}

/**
 * Spend the grant a peekGrant DECISION was made on: one use of a single-use grant;
 * nothing for a duration or permanent decision. Called by the runtime AFTER it has
 * decided to permit a git write, so one grant maps to exactly one permitted write.
 * Takes the decision view, not a project key, so it cannot re-derive which grant
 * applied. A grant revoked or replaced since the decision is left alone.
 */
export function consumeGrant(decision, now = Date.now()) {
  if (!decision || typeof decision !== 'object' || !(SOURCE in decision)) {
    throw new TypeError('consumeGrant: pass the view peekGrant returned (FEAT-164 r2: one decision, one instant)');
  }
  const g = decision[SOURCE];
  if (!g || g.scope === 'duration') return; // permanent / time-bounded: nothing to spend
  if (grants.get(g.projectKey) !== g) return; // revoked or replaced since the decision
  g.remainingUses -= 1;
  if (g.remainingUses <= 0 || now >= g.expiresAt) grants.delete(g.projectKey);
}

/**
 * Record an agent git write for the after-the-fact view. Returns the record.
 *
 * BUG-184 — this records what the host DECIDED, not (yet) what the caller DID. The
 * `outcome` is 'permitted' on the allow path and 'blocked-gate' when a publish was
 * refused for a failed gate. It is NEVER 'executed' here: only the executor moves
 * it there via `confirmGitWrite`, because only the executor observes git's exit.
 * The record carries a stable `id` so that confirmation can find it later.
 */
export function recordGitWrite({ projectKey, offender, command, sessionLabel = null, grantScope = null, gatePassed = null, outcome = 'permitted', now = Date.now() }) {
  const rec = {
    // BUG-184 round 3 — id is `w<seq>-<boot>`: the per-process boot nonce makes it
    // globally unique across restarts (A3). It is only a LOOKUP handle, NOT the
    // authority — the unguessable capability token below is what a confirm proves.
    id: `w${++ledgerSeq}-${STORE_BOOT}`,
    at: new Date(now).toISOString(),
    projectKey: projectKey ?? null,
    sessionLabel: sessionLabel ?? null,
    offender: offender ?? null,
    // The command is truncated: the audit is "what kind of write, when", not a
    // place to re-store a payload that might itself carry private text.
    command: typeof command === 'string' ? command.slice(0, 200) : null,
    grantScope: grantScope ?? null,
    // gatePassed records the gate result AT DECIDE TIME (true/false/n-a). It is NOT
    // proof the write landed — `outcome` owns that. Kept for continuity/detail.
    gatePassed: gatePassed === null ? null : !!gatePassed,
    outcome: WRITE_OUTCOMES.has(outcome) ? outcome : 'permitted',
    exitStatus: null,
    executedAt: null,
    // BUG-184 round 3 — rejected confirm attempts (wrong token / wrong owner / a
    // replay). Surfaced so a reader SEES tampering was attempted; never silently
    // dropped. A record with anomalies whose outcome is not a clean 'executed' must
    // read as NOT a pass.
    confirmAnomalies: 0,
  };
  ledger.push(rec);
  // The owner DECLARES the confirm capability ONCE here (ARCH-010): an unguessable
  // token + the owner projectKey. A confirm must present both; nobody re-derives it.
  const token = randomBytes(32).toString('hex');
  confirmCaps.set(rec.id, { token, projectKey: projectKey ?? null });
  if (ledger.length > LEDGER_CAP) {
    const removed = ledger.splice(0, ledger.length - LEDGER_CAP);
    for (const r of removed) confirmCaps.delete(r.id); // drop caps for evicted records
  }
  if (auditSink) { try { auditSink(rec); } catch { /* the durable sink must never break a decision */ } }
  // The token is returned ONLY to the immediate caller (→ the decide response → the
  // executor). It is NOT on the stored `rec`, so it never appears in listGitWrites.
  return { ...rec, confirmToken: token };
}

/**
 * BUG-184 — the EXECUTOR reports what actually happened, moving a `permitted`
 * record to its observed outcome (ARCH-010: the fact "did the write run" is owned
 * by whoever ran it — the FEAT-135 shim after `spawnSync`). Round 3 makes this
 * UNFORGEABLE by a same-uid peer: the caller MUST present the per-record capability
 * `token` AND the owner `projectKey` the owner declared at record time.
 *   - `exitStatus === 0` → 'executed' (the write landed); anything else → 'failed'.
 *   - Wrong/absent token, wrong owner project, an unknown id, or a REPLAY (the
 *     capability is single-use — deleted on first confirm) is REJECTED and recorded
 *     as an anomaly on the record; the outcome is never fabricated or overwritten.
 * Returns { ok, reason, record }. `ok:false` never changed the outcome.
 */
export function confirmGitWrite(id, { token = null, projectKey = null, exitStatus = null, now = Date.now() } = {}) {
  if (!id) return { ok: false, reason: 'missing-id', record: null };
  const rec = ledger.find((r) => r.id === id);
  if (!rec) return { ok: false, reason: 'unknown-record', record: null }; // evicted / never recorded / stale id across restart
  const cap = confirmCaps.get(id);
  const authorized = !!cap && tokenMatches(token, cap.token) && (projectKey ?? null) === cap.projectKey;
  if (!authorized) {
    // Forged/guessed token, foreign owner, or a post-confirm replay (cap consumed):
    // an attack signal, recorded on the record and rejected. Outcome UNCHANGED.
    rec.confirmAnomalies = (rec.confirmAnomalies || 0) + 1;
    if (auditSink) { try { auditSink(rec); } catch { /* never break on a rejection */ } }
    return { ok: false, reason: 'unauthorized-confirm', record: rec };
  }
  if (rec.outcome !== 'permitted') {
    // Valid token but the record is already terminal (a blocked-gate record, or a
    // second confirm slipping in before the cap delete): reject + record anomaly.
    rec.confirmAnomalies = (rec.confirmAnomalies || 0) + 1;
    if (auditSink) { try { auditSink(rec); } catch { /* never break */ } }
    return { ok: false, reason: 'already-terminal', record: rec };
  }
  const status = exitStatus === null || exitStatus === undefined ? null : Number(exitStatus);
  rec.exitStatus = status;
  rec.outcome = status === 0 ? 'executed' : 'failed';
  rec.executedAt = new Date(now).toISOString();
  confirmCaps.delete(id); // single-use — the capability is consumed on first confirm
  if (auditSink) { try { auditSink(rec); } catch { /* the durable sink must never break a confirmation */ } }
  return { ok: true, reason: null, record: rec };
}

/** Most-recent-first copy of the ledger, optionally filtered to one project. */
export function listGitWrites(projectKey = null, limit = 100) {
  const rows = projectKey ? ledger.filter((r) => r.projectKey === projectKey) : ledger;
  return rows.slice(-Math.max(0, limit)).reverse();
}

/** A serialisable view of the grant for a project (or null). */
export function grantView(projectKey, now = Date.now()) {
  // FEAT-164 — the same answer the enforcement path gets: permanent first.
  const perm = permanentGrantOf(projectKey);
  if (perm) return perm;
  const g = grants.get(projectKey);
  if (!g) return null;
  if (now >= g.expiresAt || g.remainingUses <= 0) { grants.delete(projectKey); return null; }
  return viewGrant(g, now);
}

/** Register (or clear) the durable audit sink. index.ts wires the host log file. */
export function setGitWriteAuditSink(fn) { auditSink = typeof fn === 'function' ? fn : null; }

/** TEST-ONLY: forget every grant and clear the ledger. */
export function _resetGitGrantsForTest() { grants.clear(); ledger.length = 0; ledgerSeq = 0; confirmCaps.clear(); auditSink = null; permanentSource = null; }

function viewGrant(g, now) {
  return {
    projectKey: g.projectKey,
    scope: g.scope,
    remainingUses: g.remainingUses === Infinity ? null : g.remainingUses,
    grantedAt: g.grantedAt,
    grantedVia: g.grantedVia,
    note: g.note,
    expiresAt: new Date(g.expiresAt).toISOString(),
    expiresInMs: Math.max(0, g.expiresAt - now),
  };
}
