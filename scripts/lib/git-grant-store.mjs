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
import { isFixturePath } from './agent-git-policy.mjs';

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

/** A hard ceiling so even a "single-use" grant cannot sit armed forever.
 *  FEAT-201 — raised 6h → 24h so a TIMED pass can span a long autonomous run (the
 *  user asked to grant 1h/8h/24h without re-granting every 30 min). 24h is the
 *  largest named preset in the Git-tab picker; anything longer than a day is served
 *  by the "until I turn it off" standing grant (permanentGrantOf, survives restart),
 *  so a timed pass genuinely never needs more, and this ceiling still guarantees a
 *  timed pass cannot linger indefinitely. Note this constant is ALSO the fallback
 *  ttl for a `scope:'once'` grant when the caller names none (below); widening it to
 *  24h is cosmetic there — a once-grant self-expires on its first permitted write. */
export const MAX_GRANT_MS = 24 * 60 * 60 * 1000; // 24h
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
export function grantGitWrite(projectKey, { scope = 'once', ttlMs, grantedVia = 'user', note = '', repo = null, now = Date.now() } = {}) {
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
    // FEAT-164 grant binding: the repo identity this grant was given for. The shim-decide
    // route honours it only while the project's path still resolves to it (else revokes).
    // ...plus the local remotes recorded at grant time (repo-identity grantBindingOf): the only local push targets.
    repo: repo && typeof repo === 'object' ? {
      toplevel: String(repo.toplevel), commonDir: repo.commonDir ?? null,
      remotes: Array.isArray(repo.remotes) ? repo.remotes.filter((r) => r && typeof r === 'object').map((r) => ({ toplevel: String(r.toplevel), commonDir: r.commonDir ?? null })) : [],
      networkKeys: Array.isArray(repo.networkKeys) ? repo.networkKeys.filter((k) => typeof k === 'string' && k) : [],
    } : null,
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

/** Remove any TIMED/single-use grant for a project, and REVOKE every live claim on
 * it (FEAT-164 r4: the project's revocation generation moves, so no claim minted
 * before this instant can authorise another write — revocation always wins). The
 * generation moves even when no timed grant is present: the DELETE route calls this
 * after clearing the permanent setting, and a spent once-grant's live call must stop
 * too. Returns true if a timed grant was present. */
export function revokeGitWrite(projectKey) {
  if (projectKey) revocationGen.set(projectKey, genOf(projectKey) + 1);
  return grants.delete(projectKey);
}

/*
 * ── FEAT-164 r4 — THE STORE IS THE ONLY AUTHORITY ───────────────────────────────
 * The property broke three times, each time because something OTHER than the
 * store's current answer authorised a write:
 *   r1 (verify run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9): consume re-read the
 *      permanent setting after a mid-gate revoke and spent an independent once-grant;
 *   r2 (verify run 01a10bbd-44d2-7420-8d4e-e1e73b939a22): a re-entrant decision in
 *      the gate peeked the same un-reserved once-grant (one once-grant, two writes);
 *   r3 (verify run 01a10ca5-0fb3-7032-a8c0-5374865424e8): BUG-231's per-call window
 *      kept authorising the call's next commit after the grant was revoked, and a
 *      claim reserved before a revoke still committed (the claim cached the answer).
 *
 * So no claim, window, hook or shim HOLDS authorisation. They hold a claim HANDLE,
 * and every git write asks the store, AT THE MOMENT OF THE WRITE, through ONE call:
 *
 *   claimGrant(projectKey)  — mints a handle. Reads the permanent setting once
 *                             (permanent first), else the live timed grant, and
 *                             RESERVES a once-grant's use (a nested or concurrent
 *                             claimer cannot take it). null → no grant → deny.
 *                             A handle authorises NOTHING by itself.
 *   useClaim(claim, now)    — THE allow. True iff, right now: the handle was minted
 *                             here and has not ended; the project's revocation
 *                             generation is the one it was minted under; it has not
 *                             lapsed (CLAIM_MAX_MS); and the grant it was minted
 *                             under is STILL the store's grant — the same timed grant
 *                             object, unexpired, or the same permanent setting
 *                             (same grantedAt incarnation). A reserved once-claim
 *                             spends its use HERE, atomically, and only once per
 *                             handle; later uses of a spent handle re-validate but
 *                             never spend again. The permanent re-read only NARROWS
 *                             (revoked → false); it never redirects a spend to
 *                             another grant, so r1 cannot recur. Invalid → false,
 *                             and the handle ENDS (its reservation returns).
 *   endClaim(claim)         — idempotent end; a still-reserved use returns.
 *   settleClaim(claim, 'commit'|'release') — the r3 single-write form, kept:
 *                             'commit' = useClaim then end; 'release' = end. Throws
 *                             on a second settle or a handle not minted here.
 *
 * Synchronous throughout, so nothing interleaves between check and spend. grantView
 * / permanentGrantOf are DISPLAY reads; no enforcement path may act on them. The
 * later self-grant check (A/B/C fork, not chosen) belongs in claimGrant only.
 *
 * Semantic change from r3, deliberate: r3 let a claim taken before a revoke still
 * commit ("a revoke governs the NEXT claim"). Now a revoke, an expiry, a lapse or a
 * replacement that lands between claim and use (mid-gate, mid-call) DENIES the write.
 * Callers pass the clock as read AFTER their gate ran, never a pre-gate timestamp.
 */
/*
 * BUG-231 r6 — the lapse must EXCEED the longest a single foreground Bash call can
 * run, or it breaks ordinary use. r5 set this to 5 min, so a live, non-withdrawn
 * call that legitimately runs longer (e.g. `npm test && git commit` where the tests
 * take 6 min) had its commit DENIED when the lapse withdrew its still-open call. The
 * Claude Code Bash tool caps a single call at `timeout` ≤ 600000 ms (10 min). Orchard
 * does NOT set or override that cap anywhere — no BASH_MAX_TIMEOUT_MS / BASH_DEFAULT_
 * TIMEOUT_MS in settings.json or the env passthrough (checked 2026-10-06) — so there is
 * no single source to derive from; we take the harness max (10 min) and add a 5-min
 * margin for gate/startup/clock-skew slack, giving 15 min. A withdrawn/revoked/expired
 * call is still denied IMMEDIATELY (that is the store's generation/expiry check, not
 * this lapse); this bound only governs when an otherwise-live call's own handle lapses.
 * CALL_TOMBSTONE_MS (below) stays far above this so an orphan tombstone outlives it.
 */
export const BASH_MAX_TIMEOUT_MS = 600 * 1000; // Claude Code Bash tool hard cap (10 min)
export const CLAIM_MAX_MS = BASH_MAX_TIMEOUT_MS + 5 * 60 * 1000; // 15 min

/** projectKey → revocation generation (bumped by revokeGitWrite). Memory-only. */
const revocationGen = new Map();
function genOf(projectKey) { return revocationGen.get(projectKey) ?? 0; }

/** claim → { g, projectKey, kind, gen, permAt, at, state: 'reserved'|'live'|'spent'|'ended' }.
 * Module-private: a claim is an opaque handle only this module can read. */
const claims = new WeakMap();
/** Number of `useClaim` calls that answered true. The FEAT-164 r4 structural test
 * checks that every granted write maps 1:1 onto one of these. */
let authorisations = 0;

/** The live timed grant for a project, purging an expired one. Reservations are
 * NOT counted here: a reserved once-grant is still live (it may be released). */
function liveTimedGrant(projectKey, now) {
  const g = grants.get(projectKey);
  if (!g) return null;
  if (now >= g.expiresAt || g.remainingUses <= 0) { grants.delete(projectKey); return null; }
  return g;
}

/** Drop reservations whose claim ended or lapsed (CLAIM_MAX_MS) — lazy, on every read. */
function reapLapsed(g, now) {
  if (!g.holds) return;
  for (const c of g.holds) {
    const st = claims.get(c);
    if (!st || st.state !== 'reserved' || now - st.at >= CLAIM_MAX_MS) g.holds.delete(c);
  }
}

/** Uses of a timed grant still claimable now. */
function available(g, now) {
  if (g.remainingUses === Infinity) return Infinity;
  reapLapsed(g, now);
  return g.remainingUses - (g.holds ? g.holds.size : 0);
}

/** Mint a claim handle (see the block above). Authorises nothing until useClaim. */
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
  const kind = perm ? 'permanent' : g.remainingUses === Infinity ? 'duration' : 'once';
  const claim = Object.freeze({ scope: view.scope, view: Object.freeze({ ...view }) });
  claims.set(claim, {
    g, projectKey, kind, gen: genOf(projectKey), permAt: perm ? perm.grantedAt : null,
    at: now, state: kind === 'once' ? 'reserved' : 'live',
  });
  if (kind === 'once') (g.holds ??= new Set()).add(claim);
  return claim;
}

/** Is the store's CURRENT answer still the grant this claim was minted under? */
function stillValid(st, claim, now) {
  if (st.state === 'ended') return false;
  if (genOf(st.projectKey) !== st.gen) return false; // revoked since
  if (now - st.at >= CLAIM_MAX_MS) return false; // lapsed
  if (st.kind === 'permanent') {
    const perm = permanentGrantOf(st.projectKey); // narrows only, never redirects
    return !!perm && perm.grantedAt === st.permAt;
  }
  const g = st.g;
  if (now >= g.expiresAt) return false; // expired since
  if (st.state === 'spent') return true; // this handle consumed the once-grant's use
  if (grants.get(st.projectKey) !== g) return false; // revoked / replaced since
  if (st.kind === 'once') return g.holds?.has(claim) === true && g.remainingUses > 0;
  return true;
}

function endState(st, claim) {
  st.state = 'ended';
  st.g?.holds?.delete(claim); // a still-reserved once-use returns to the grant
}

/**
 * THE allow. True iff the store, now, still stands behind this claim; a reserved
 * once-claim spends its use here, once. False ends the claim. Never throws.
 */
export function useClaim(claim, now = Date.now()) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (!st) return false;
  if (!stillValid(st, claim, now)) { endState(st, claim); return false; }
  if (st.state === 'reserved') {
    const g = st.g;
    g.holds.delete(claim);
    g.remainingUses -= 1;
    if (g.remainingUses <= 0 && grants.get(g.projectKey) === g) grants.delete(g.projectKey);
    st.state = 'spent';
  }
  authorisations += 1;
  return true;
}

/** End a claim. Idempotent, never throws. */
export function endClaim(claim) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (st && st.state !== 'ended') endState(st, claim);
}

/** True once a claim has ended (or was never minted here). Never throws. */
export function claimSettled(claim) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  return !st || st.state === 'ended';
}

/**
 * The single-write form: 'commit' → useClaim then end (true iff the write may
 * proceed); 'release' → end, always false. Throws on a second settle or a claim
 * this module did not mint.
 */
export function settleClaim(claim, outcome, now = Date.now()) {
  const st = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (!st) throw new TypeError('settleClaim: not a claim from claimGrant (FEAT-164 r3: one authority)');
  if (st.state === 'ended') throw new Error('settleClaim: claim already settled (FEAT-164 r3: a decision ends once)');
  if (outcome !== 'commit' && outcome !== 'release') throw new TypeError(`settleClaim: outcome must be 'commit' or 'release'`);
  const ok = outcome === 'commit' ? useClaim(claim, now) : false;
  endClaim(claim);
  return ok;
}

/*
 * ── BUG-231 r5 — PER-CALL CLAIM STATE LIVES HERE, AND ITS END IS TERMINAL ─────────
 * The 5th break (verify run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9): the per-call window
 * lived in git-grant.mjs and was dropped by a TIME-based reap at CLAIM_MAX_MS while its
 * call was still in flight. The "this call was withdrawn" fact went with it, so the
 * call's next written-out commit found no window, decided afresh on the independent
 * path and spent a fresh re-grant. The window's mere existence decided behaviour, and
 * time — not the call ending — destroyed it. Reopening a known call id did the same.
 *
 * So the call's claim state is the STORE's, keyed by call id (binding + tool_use_id):
 *   status 'open'      — the handle may still authorise (useCallClaim asks useClaim).
 *   status 'withdrawn' — TERMINAL for the call: the store refused it once (revoke,
 *                        expiry, replacement, or the CLAIM_MAX_MS lapse). Every later
 *                        written-out write of that call is denied; nothing re-decides it.
 *   status 'ended'     — the call-end signal arrived (Post / deny / supersession /
 *                        SubagentStop / turn end / session close). A tombstone only:
 *                        its id can never be decided again, and it no longer matches
 *                        shim writes (git after the call ended is not the call's).
 * Time never deletes a not-ended record before CALL_TOMBSTONE_MS, far longer than any
 * foreground call lives; the lapse only ENDS THE HANDLE (a reserved use returns) and
 * withdraws the call. Unknown id → not valid, not usable.
 */
export const CALL_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
/** binding → Map(toolUseId → { agentKey, projectKey, claim, status, at, data }). Memory-only. */
const calls = new Map();
let lastGlobalSweep = 0;

function sweepBinding(binding, m, now) {
  for (const [id, r] of [...m]) {
    if (now - r.at >= CALL_TOMBSTONE_MS) { if (r.claim) endClaim(r.claim); m.delete(id); continue; }
    if (r.status === 'open') {
      const st = claims.get(r.claim);
      if (!st || st.state === 'ended' || now - st.at >= CLAIM_MAX_MS) withdraw(r);
    }
  }
  if (m.size === 0) calls.delete(binding);
}
function sweep(binding, now) {
  if (now - lastGlobalSweep >= 60_000 || now < lastGlobalSweep) {
    lastGlobalSweep = now;
    for (const [b, m] of [...calls]) sweepBinding(b, m, now);
    return;
  }
  const m = binding ? calls.get(binding) : null;
  if (m) sweepBinding(binding, m, now);
}
function withdraw(r) { if (r.claim) endClaim(r.claim); r.claim = null; r.status = 'withdrawn'; }
function recOf(binding, toolUseId) { return binding && toolUseId ? calls.get(binding)?.get(toolUseId) : undefined; }

/** The store's answer for a call id: 'unknown' | 'open' | 'withdrawn' | 'ended'. */
export function callClaimState(binding, toolUseId, now = Date.now()) {
  sweep(binding, now);
  return recOf(binding, toolUseId)?.status ?? 'unknown';
}

/**
 * Bind a claim handle to a call id. False (and the handle ENDS) when the id is already
 * known in any state: one call id is decided once. `data` is the caller's non-authority
 * bookkeeping (slots, gate fingerprint, record), freed when the call ends.
 */
export function openCallClaim({ binding, toolUseId, agentKey = 'main', projectKey, claim, data = {} }, now = Date.now()) {
  if (!binding || !toolUseId || !claims.get(claim)) { endClaim(claim); return false; }
  sweep(binding, now);
  let m = calls.get(binding);
  if (m?.has(toolUseId)) { endClaim(claim); return false; }
  if (!m) { m = new Map(); calls.set(binding, m); }
  m.set(toolUseId, { agentKey: agentKey ?? 'main', projectKey, claim, status: 'open', at: now, data });
  return true;
}

/**
 * BUG-231 r7 — record a call id as TERMINALLY DENIED when NO claim was opened for it: the
 * pre-claim refusals (no grant for the project, or any deny before openCallClaim). Every
 * other terminal outcome already tombstones an EXISTING record (useCallClaim → withdraw,
 * endCallClaims → ended, the CLAIM_MAX_MS lapse → withdraw, the 24h sweep → delete); this
 * is the one path that otherwise left NO record at all, so the id settled to 'unknown' and
 * a once-grant issued AFTER the deny let the SAME id retry and steal it (verify run
 * 01a10e18, probe 7f57e10c4704). A 'withdrawn' tombstone keyed by the call id makes the id
 * (a) undecidable again — callClaimState != 'unknown', the hook refuses the retry — and
 * (b) deny a shim write of the same call — findCallFor returns a not-ended match with its
 * slots, and redeemGitWrite denies any status != 'open'. A call id that has ever been
 * denied stays denied for its life; a grant issued after a deny reaches only the agent's
 * NEXT Bash call (a new id), the normal retry shape. Idempotent; never throws. */
export function denyCallClaim({ binding, toolUseId, agentKey = 'main', projectKey = null, data = {} } = {}, now = Date.now()) {
  if (!binding || !toolUseId) return false;
  sweep(binding, now);
  let m = calls.get(binding);
  if (!m) { m = new Map(); calls.set(binding, m); }
  const existing = m.get(toolUseId);
  if (existing) { if (existing.status === 'open') withdraw(existing); return true; }
  m.set(toolUseId, { agentKey: agentKey ?? 'main', projectKey: projectKey ?? null, claim: null, status: 'withdrawn', at: now, data: data ?? {} });
  return true;
}

/** THE allow for a call's write: true iff the call is open AND the store stands behind its
 * handle now (useClaim). A false answer withdraws the call — terminally. */
export function useCallClaim(binding, toolUseId, now = Date.now()) {
  sweep(binding, now);
  const r = recOf(binding, toolUseId);
  if (!r || r.status !== 'open') return false;
  if (useClaim(r.claim, now)) return true;
  withdraw(r);
  return false;
}

/**
 * The not-ended call of `binding` in `projectKey` whose written-out slots include `verb`
 * (open OR withdrawn — a withdrawn match is the caller's DENY), or null when the write
 * belongs to no live call (the independent path).
 */
export function findCallFor(binding, projectKey, verb, now = Date.now()) {
  sweep(binding, now);
  const m = binding ? calls.get(binding) : null;
  if (!m) return null;
  for (const [toolUseId, r] of m) {
    if (r.status !== 'ended' && r.projectKey === projectKey && r.data?.slots?.includes(verb)) {
      return { toolUseId, status: r.status, data: r.data };
    }
  }
  return null;
}

/** The call-end signal for every not-ended call of `binding` matching `pred({toolUseId, agentKey})`.
 * Its handle ends (a reserved use returns), its bookkeeping is freed, a tombstone stays. */
export function endCallClaims(binding, pred = () => true, now = Date.now()) {
  const m = binding ? calls.get(binding) : null;
  if (m) {
    for (const [toolUseId, r] of m) {
      if (r.status === 'ended' || !pred({ toolUseId, agentKey: r.agentKey })) continue;
      if (r.claim) endClaim(r.claim);
      r.claim = null; r.status = 'ended'; r.data = null;
    }
  }
  sweep(binding, now);
}

/** TEST-ONLY: end and forget every call record. */
export function _resetCallClaimsForTest() {
  for (const m of calls.values()) for (const r of m.values()) if (r.claim) endClaim(r.claim);
  calls.clear(); lastGlobalSweep = 0;
}

/** TEST/DIAGNOSTIC: a binding's not-ended calls (no handles). */
export function _callClaimsOf(binding) {
  const m = binding ? calls.get(binding) : null;
  return m ? [...m].filter(([, r]) => r.status !== 'ended').map(([toolUseId, r]) => ({ toolUseId, status: r.status, agentKey: r.agentKey, data: r.data })) : [];
}

/** TEST/DIAGNOSTIC: how many writes the store has authorised (useClaim → true). */
export function _authorisationCount() { return authorisations; }

/**
 * Record an agent git write for the after-the-fact view. Returns the record.
 *
 * BUG-184 — this records what the host DECIDED, not (yet) what the caller DID. The
 * `outcome` is 'permitted' on the allow path and 'blocked-gate' when a publish was
 * refused for a failed gate. It is NEVER 'executed' here: only the executor moves
 * it there via `confirmGitWrite`, because only the executor observes git's exit.
 * The record carries a stable `id` so that confirmation can find it later.
 */
export function recordGitWrite({ projectKey, offender, command, sessionLabel = null, grantScope = null, gatePassed = null, outcome = 'permitted', decision = null, targetRepo = null, sourceProjectKey = null, now = Date.now() }) {
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
    // FEAT-190 — the resolved TARGET repo this write reached (identity, never the session's own
    // project row) and the SOURCE project whose grant covered it. Together they let the git page
    // show "which repos this grant reached" and drive the per-repo opt-out. null for same-repo /
    // legacy writes. targetRepo: { toplevel, commonDir, label? }.
    targetRepo: targetRepo && typeof targetRepo === 'object'
      ? { toplevel: typeof targetRepo.toplevel === 'string' ? targetRepo.toplevel : null, commonDir: typeof targetRepo.commonDir === 'string' ? targetRepo.commonDir : null, label: typeof targetRepo.label === 'string' ? targetRepo.label.slice(0, 200) : null }
      : null,
    sourceProjectKey: typeof sourceProjectKey === 'string' && sourceProjectKey ? sourceProjectKey : null,
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

/* ─────────── FEAT-190 — CROSS-REPO REACH LOG (display / opt-out source ONLY) ───────────
 * A grant covers the OTHER repos a session works in. This log records WHICH repos a source
 * project's grant has touched, so the git page can list them and let the user switch any of them
 * off (the per-repo opt-out, which lives in the grant's `repoOverrides`, keyed by commonDir).
 *
 * FEAT-190 r8 (orchestrator RESCOPE): the reach log has NO allow/deny role. It used to FREEZE a
 * repo's remotes at first contact and refuse a push to any other remote (`remote-not-recorded`);
 * that frozen-remote veto — a destination safeguard the user never asked for, outside the guard's
 * threat model, which broke three times through its keying (grantedAt incarnation, cwd-vs-commonDir)
 * — was removed, not re-keyed. The reach entry is now keyed by (sourceProjectKey, targetCommonDir):
 * the repo identity, no grant incarnation. The remotes recorded on an entry are DISPLAY-only. No
 * decision reads this log; the only decision keyed by commonDir is the per-repo opt-out in
 * governingGrant (which reads the grant's repoOverrides, not this log).
 * DURABLE (index.ts wires a jsonl sink and replays it on boot).
 *   entry: { sourceProjectKey, targetCommonDir, targetToplevel, networkKeys:[], localCommonDirs:[], at }
 */
const crossRepoReach = new Map(); // `${sourceProjectKey}\0${targetCommonDir}` → entry
let crossRepoReachSink = null;
function reachKey(sourceProjectKey, targetCommonDir) {
  return sourceProjectKey && targetCommonDir ? `${sourceProjectKey}\0${targetCommonDir}` : null;
}
/* FEAT-190 follow-up (2026-10-16, "Other repos" showed 8–15 hash-named entries) — throwaway repos
 * are NEVER recorded, replayed or listed. The live log held only `/tmp/claude-<uid>/bash-edit-diff/
 * <hash>` repos: the Claude CLI's own per-edit diff repos, written under a session's grant. Any
 * repo under a fixture root (scratch / system tmp / confined work — defaultFixtureRoots) is a test
 * or tool fixture, not a repo the user governs, so it has no place in the opt-out list. Display
 * only: no decision reads this log. `reachFixtureRoots` null = the live defaults; tests pin it. */
let reachFixtureRoots = null;
/** Test hook: pin the fixture roots the reach filter uses (null = defaultFixtureRoots()). */
export function _setReachFixtureRootsForTest(roots) { reachFixtureRoots = Array.isArray(roots) ? roots : null; }
/** TRUE iff a reach entry/target is a throwaway (fixture-root) repo that must not be recorded. */
export function isFixtureReach({ targetCommonDir = null, targetToplevel = null } = {}) {
  const roots = reachFixtureRoots ?? undefined;
  return isFixturePath(targetCommonDir, roots) || isFixturePath(targetToplevel, roots);
}
/** Register (or clear) the durable sink for reach records. */
export function setCrossRepoReachSink(fn) { crossRepoReachSink = typeof fn === 'function' ? fn : null; }
/** Replay a durable reach record on boot (index.ts reads the jsonl). First-writer wins, so a
 * replay never overwrites an existing entry. Tolerates legacy entries carrying a `grantedAt`
 * field (ignored — it is no longer part of the key). Never throws. */
export function loadCrossRepoReach(rec) {
  if (!rec || typeof rec !== 'object') return;
  const k = reachKey(rec.sourceProjectKey, rec.targetCommonDir);
  if (!k || crossRepoReach.has(k)) return;
  if (isFixtureReach(rec)) return; // a stale throwaway entry from before the filter: never replayed
  crossRepoReach.set(k, {
    sourceProjectKey: rec.sourceProjectKey, targetCommonDir: rec.targetCommonDir,
    targetToplevel: typeof rec.targetToplevel === 'string' ? rec.targetToplevel : null,
    networkKeys: Array.isArray(rec.networkKeys) ? rec.networkKeys.filter((x) => typeof x === 'string') : [],
    localCommonDirs: Array.isArray(rec.localCommonDirs) ? rec.localCommonDirs.filter((x) => typeof x === 'string') : [],
    at: typeof rec.at === 'string' ? rec.at : new Date(Date.now()).toISOString(),
  });
}
/**
 * Record (for the git-page display / opt-out list) that a source project's grant has reached a
 * target repo. Keyed by (sourceProjectKey, targetCommonDir); first-writer wins. `resolved` is the
 * repo's remotes AS GIT RESOLVES THEM NOW (resolvedRemotesOf): { network:[keys], local:[{commonDir}] },
 * kept DISPLAY-only. Never throws.
 */
export function recordCrossRepoReach(sourceProjectKey, { targetCommonDir, targetToplevel = null, resolved = null } = {}, now = Date.now()) {
  const k = reachKey(sourceProjectKey, targetCommonDir);
  if (!k) return null;
  if (isFixtureReach({ targetCommonDir, targetToplevel })) return null; // throwaway repo: never recorded
  const hit = crossRepoReach.get(k);
  if (hit) return hit;
  const entry = {
    sourceProjectKey, targetCommonDir, targetToplevel: typeof targetToplevel === 'string' ? targetToplevel : null,
    networkKeys: resolved && Array.isArray(resolved.network) ? [...new Set(resolved.network.filter((x) => typeof x === 'string'))] : [],
    localCommonDirs: resolved && Array.isArray(resolved.local) ? [...new Set(resolved.local.map((l) => l && l.commonDir).filter((x) => typeof x === 'string'))] : [],
    at: new Date(now).toISOString(),
  };
  crossRepoReach.set(k, entry);
  if (crossRepoReachSink) { try { crossRepoReachSink(entry); } catch { /* durability must never break a decision */ } }
  return entry;
}
/** The reach entry for (sourceProjectKey, targetCommonDir), or null. */
export function crossRepoReachOf(sourceProjectKey, targetCommonDir) {
  return crossRepoReach.get(reachKey(sourceProjectKey, targetCommonDir)) ?? null;
}
/** Every reach entry for a source project (git page: "repos this grant reached"). */
export function crossRepoReachFor(sourceProjectKey) {
  return [...crossRepoReach.values()].filter((e) => e.sourceProjectKey === sourceProjectKey && !isFixtureReach(e));
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

/** FEAT-164 — DISPLAY read of the live TIMED/once grant alone (the standing grant is
 * ignored), or null. The real-repo guard uses it to honour the user's explicit window;
 * it never authorises a write (claimGrant does). */
export function timedGrantView(projectKey, now = Date.now()) {
  const g = projectKey ? liveTimedGrant(projectKey, now) : null;
  return g ? viewGrant(g, now) : null;
}

/** Register (or clear) the durable audit sink. index.ts wires the host log file. */
export function setGitWriteAuditSink(fn) { auditSink = typeof fn === 'function' ? fn : null; }

/** TEST-ONLY: forget every grant and clear the ledger. */
export function _resetGitGrantsForTest() { grants.clear(); revocationGen.clear(); calls.clear(); lastGlobalSweep = 0; authorisations = 0; ledger.length = 0; ledgerSeq = 0; confirmCaps.clear(); auditSink = null; permanentSource = null; crossRepoReach.clear(); crossRepoReachSink = null; reachFixtureRoots = null; }

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
    repo: g.repo ?? null,
  };
}
