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
 * ── FEAT-164 round 3 — THE ONE GRANT AUTHORITY: claimGrant → settleClaim ──────
 * The property: a git-write grant decision is taken EXACTLY ONCE, and a once-grant
 * is spent EXACTLY ONCE. It broke twice while "decide" (peekGrant) and "spend"
 * (consumeGrant) were two calls on mutable state with the leak gate running
 * between them:
 *   r1 (verify run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9): consume re-read the
 *      permanent setting after a mid-gate revoke and spent an independent
 *      once-grant;
 *   r2 (verify run 01a10bbd-44d2-7420-8d4e-e1e73b939a22): a re-entrant decision
 *      inside the gate peeked the same un-reserved once-grant, so one once-grant
 *      authorised two writes.
 * Both are the gap between deciding and spending, so the gap is gone, not guarded:
 *
 *   claimGrant(projectKey)  — the ONLY way to obtain a grant decision. One
 *                             synchronous call reads the permanent setting ONCE
 *                             (permanent answers first), else the live timed grant,
 *                             and for a once-grant RESERVES its use on the spot. A
 *                             nested or concurrent caller sees the reservation and
 *                             cannot claim that use. Returns an opaque frozen claim,
 *                             or null (no grant → deny).
 *   settleClaim(claim, 'commit'|'release') — the claim's ONE ending. 'commit'
 *                             spends the reserved use (permanent/duration: nothing
 *                             to spend) and returns true only if the claim was still
 *                             valid; the caller may permit the write ONLY on true.
 *                             'release' returns the use (a failed gate, an error).
 *                             A second settle, or anything not minted here, throws.
 *                             Never re-reads grant state.
 *
 * Nothing else decides. grantView/permanentGrantOf are DISPLAY reads for routes
 * and the UI; no enforcement path may act on them. A later caller-identity or
 * sealing check (the FEAT-164 self-grant fork, not chosen) belongs in claimGrant
 * and nowhere else.
 *
 * A revoke or replacement after the claim governs the NEXT claim: settling an
 * orphaned grant object touches only that object. The decision instant is claim
 * time, so a TTL lapsing during the gate does not undo a claim; a claim left
 * unsettled for CLAIM_MAX_MS lapses — its reservation is freed and its commit
 * refuses (fail closed), so a lost claim cannot pin a once-grant until its TTL.
 */
export const CLAIM_MAX_MS = 5 * 60 * 1000;

/** claim → { g, projectKey, at, settled }. Module-private: a claim is an opaque
 * capability that only this module can read or settle. */
const claims = new WeakMap();

/** The live timed grant for a project, purging an expired one. Reservations are
 * NOT counted here: a reserved once-grant is still live (it may be released). */
function liveTimedGrant(projectKey, now) {
  const g = grants.get(projectKey);
  if (!g) return null;
  if (now >= g.expiresAt || g.remainingUses <= 0) { grants.delete(projectKey); return null; }
  return g;
}

/** Drop reservations whose claim lapsed (CLAIM_MAX_MS) — lazy, on every read. */
function reapLapsed(g, now) {
  if (!g.holds) return;
  for (const c of g.holds) {
    const st = claims.get(c);
    if (!st || st.settled || now - st.at >= CLAIM_MAX_MS) g.holds.delete(c);
  }
}

/** Uses of a timed grant still claimable now. */
function available(g, now) {
  if (g.remainingUses === Infinity) return Infinity;
  reapLapsed(g, now);
  return g.remainingUses - (g.holds ? g.holds.size : 0);
}

/**
 * THE decision. Returns a frozen claim `{ scope, view }` or null. See the block
 * above: the only call that can authorise a git write.
 */
export function claimGrant(projectKey, now = Date.now()) {
  if (!projectKey || typeof projectKey !== 'string') return null;
  const perm = permanentGrantOf(projectKey); // read ONCE, here, for this decision
  let g = null;
  let view;
  if (perm) {
    view = perm;
  } else {
    g = liveTimedGrant(projectKey, now);
    if (!g || available(g, now) <= 0) return null;
    view = viewGrant(g, now);
  }
  const claim = Object.freeze({ scope: view.scope, view: Object.freeze({ ...view }) });
  claims.set(claim, { g, projectKey, at: now, settled: false });
  if (g && g.remainingUses !== Infinity) (g.holds ??= new Set()).add(claim);
  return claim;
}

/** True once a claim has been settled (or was never minted here). Never throws. */
export function claimSettled(claim) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  return !st || st.settled;
}

/**
 * End a claim, exactly once. 'commit' → true iff the write may proceed (the claim
 * was live; a once-grant's reserved use is spent). 'release' → returns the use;
 * always false. Throws on a second settle or a claim this module did not mint.
 */
export function settleClaim(claim, outcome, now = Date.now()) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (!st) throw new TypeError('settleClaim: not a claim from claimGrant (FEAT-164 r3: one authority)');
  if (st.settled) throw new Error('settleClaim: claim already settled (FEAT-164 r3: a decision ends once)');
  if (outcome !== 'commit' && outcome !== 'release') throw new TypeError(`settleClaim: outcome must be 'commit' or 'release'`);
  st.settled = true;
  const g = st.g;
  const held = !g || g.remainingUses === Infinity || (g.holds?.has(claim) ?? false);
  g?.holds?.delete(claim);
  if (outcome === 'release') return false;
  if (now - st.at >= CLAIM_MAX_MS) return false; // lapsed: its reservation may already be someone else's
  if (!g || g.remainingUses === Infinity) return true; // permanent / duration: nothing to spend
  if (!held) return false; // defensive: a once-claim without its reservation never permits
  g.remainingUses -= 1;
  if (g.remainingUses <= 0 && grants.get(g.projectKey) === g) grants.delete(g.projectKey);
  return true;
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
export function recordGitWrite({ projectKey, offender, command, sessionLabel = null, grantScope = null, gatePassed = null, outcome = 'permitted', decision = null, now = Date.now() }) {
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
    // BUG-231 — the ONE grant decision this write was authorised under. Every record
    // of one Bash tool call (the hook's, and each invocation the shim redeemed against
    // it) names the same decision, so a reader groups them instead of guessing.
    decision: typeof decision === 'string' && decision ? decision : null,
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

/** A serialisable DISPLAY view of the grant for a project (or null): permanent
 * first, as claimGrant resolves it. Not a decision — enforcement uses claimGrant.
 * A once-grant whose use is reserved by an in-flight claim still shows, with
 * `remainingUses` = uses still claimable and `reserved` = uses in flight. */
export function grantView(projectKey, now = Date.now()) {
  const perm = permanentGrantOf(projectKey);
  if (perm) return perm;
  const g = liveTimedGrant(projectKey, now);
  return g ? viewGrant(g, now) : null;
}

/** Register (or clear) the durable audit sink. index.ts wires the host log file. */
export function setGitWriteAuditSink(fn) { auditSink = typeof fn === 'function' ? fn : null; }

/** TEST-ONLY: forget every grant and clear the ledger. */
export function _resetGitGrantsForTest() { grants.clear(); ledger.length = 0; ledgerSeq = 0; confirmCaps.clear(); auditSink = null; permanentSource = null; }

function viewGrant(g, now) {
  const bounded = g.remainingUses !== Infinity;
  return {
    projectKey: g.projectKey,
    scope: g.scope,
    remainingUses: bounded ? available(g, now) : null,
    reserved: bounded ? g.remainingUses - available(g, now) : 0,
    grantedAt: g.grantedAt,
    grantedVia: g.grantedVia,
    note: g.note,
    expiresAt: new Date(g.expiresAt).toISOString(),
    expiresInMs: Math.max(0, g.expiresAt - now),
  };
}
