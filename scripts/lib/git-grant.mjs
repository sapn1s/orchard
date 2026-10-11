/**
 * git-grant.mjs — FEAT-108 round 2. The runtime decision that folds a per-project
 * grant AND the mandatory leak gate onto the round-1 git-write classifier.
 *
 * ORDER OF DECISIONS (one answer per Bash call):
 *   1. decideGitWrite(command) — the round-1 classifier. If it ALLOWS (a read, or
 *      the launch-time env hatch is open), we are done: allow.
 *   2. It is a git WRITE and the block is on. Is there an active grant for this
 *      project? No grant → deny, exactly as round 1 did.
 *   3. A grant is active. Run the leak gate UNLESS every git write in the command
 *      is a provably-non-publishing local op (GATE_EXEMPT_WRITES). So a publish
 *      (commit/push), an alias (`git -c alias.x=commit x`), an unknown/future verb,
 *      OR a publish CHAINED after a non-publish write (`git add f && git commit`,
 *      FEAT-108 round-4 finding 1) all gate — the mandatory gate can no longer be
 *      skipped by keying on the first offender. Gate FAILS → deny (the grant never
 *      lifts the gate). The gate is over the REPO (working tree + staged), the
 *      content any commit/push would carry into history — the BUG-155 exposure.
 *   4. Permitted: the store authorises the claim (useClaim; spends a once-grant's
 *      reserved use) and the write is RECORDED for the after-the-fact view.
 *
 * FEAT-164 r3/r4 — steps 2-4 are ONE claim HANDLE from the store, the only authority
 * (claimGrant → useClaim → endClaim, git-grant-store.mjs). The handle is minted and a
 * once-grant's use RESERVED before the gate runs; the write is permitted only if the
 * store, asked AFTER the gate, still stands behind that handle (r4: a revoke, expiry
 * or lapse in between denies). A re-entrant or concurrent decision cannot claim the
 * reserved use. Nothing in this module holds an allow or any per-call state: BUG-231
 * r5 moved the call record (handle + withdrawn/ended status) into the store.
 *
 * The gate is INJECTED (`runLeakGate`) so this stays pure and unit-testable; the
 * runtime passes a real subprocess runner (scripts/leak-gate.mjs over the repo).
 * When no runner is available for a publishing write, we FAIL CLOSED — an
 * unverifiable commit is treated as a failed gate, never waved through.
 */
import { randomBytes } from 'node:crypto';
import { decideGitWrite, gitWriteRefusal, gitWriteGateFailedRefusal, offenderForGit, gitWriteBlockEnabled, collectGitWrites, gitWritesReachShim, bareGitWrites, GATE_EXEMPT_WRITES } from './git-write-policy.mjs';
import { claimGrant, useClaim, endClaim, recordGitWrite, callClaimState, openCallClaim, denyCallClaim, useCallClaim, findCallFor, endCallClaims, _callClaimsOf, _resetCallClaimsForTest } from './git-grant-store.mjs';

/** Writes that put content into history / a remote — the leak exposure events. */
export const PUBLISHING_SUBCOMMANDS = new Set(['commit', 'push']);

/**
 * Decide one git write for a session in `projectKey`. ONE grant authority for
 * BOTH enforcement layers (BUG-173): pass either
 *   - `command` — a Bash command STRING (the FEAT-108 PreToolUse hook), or
 *   - `argv`    — the already-isolated git arguments WITHOUT the `git` head (the
 *                 FEAT-135 PATH shim, via /api/git-shim/decide). The shim has no
 *                 shell string; it hands the tokenized invocation straight in.
 * Whichever shape, the SAME grant / leak-gate / single-use-consume tail runs, so
 * the hook and the shim can never reach different decisions for the same grant
 * state (the invariant BUG-173 exists to restore).
 * Returns { allow, offender?, reason?, granted?, gateFailed?, record? }.
 */
export function evaluateGitWrite(opts = {}) {
  const p = prepareEvaluate(opts);
  if (p.done) return p.done;
  // BUG-249 r2 — the repo fingerprint is captured HERE (pre- and post-gate), not inside
  // prepare/finish, so the async composition below can AWAIT it off the event loop. On the
  // sync path the reader is sync and this is identical to the old inline capture.
  const preFp = p.wantsFp ? safeFingerprint(opts.repoFingerprint) : null;
  const gate = p.needsGate ? runGateSync(opts.runLeakGate, p.gateScope) : null;
  const postFp = p.wantsFp ? safeFingerprint(opts.repoFingerprint) : null;
  return p.finish(gate, preFp, postFp);
}

/**
 * BUG-249 — the async composition used by the RUNTIME (PreToolUse hook + /api/git-shim
 * decide), so the ~4.6s leak-gate scan no longer blocks the single-process event loop.
 * It is the SAME decision as the synchronous `evaluateGitWrite` above: `prepareEvaluate`
 * does every store mutation synchronously BEFORE the gate (the once-grant RESERVE that
 * blocks a concurrent claim is taken here, unchanged), `finish` does every store mutation
 * synchronously AFTER it (the spend + record, atomic — no await between check and spend).
 * The ONLY difference is that the gate is AWAITED, so the event loop runs other work
 * while it scans. The injected runner may be sync or async — `runGateAsync` awaits inside
 * its own error boundary (a sync throw, a rejected promise, a missing runner all fail
 * closed). The reserved handle lives in the `finish` closure across the await.
 */
export async function evaluateGitWriteAsync(opts = {}) {
  const p = prepareEvaluate(opts);
  if (p.done) return p.done;
  // BUG-249 r2 — AWAIT the pre/post fingerprint too (not just the gate). The reserve that
  // blocks a concurrent claim already happened synchronously in `prepareEvaluate`; the
  // fingerprint + gate then run off-loop, and the atomic spend is back in sync `finish`.
  const preFp = p.wantsFp ? await safeFingerprintAsync(opts.repoFingerprint) : null;
  const gate = p.needsGate ? await runGateAsync(opts.runLeakGate, p.gateScope) : null;
  const postFp = p.wantsFp ? await safeFingerprintAsync(opts.repoFingerprint) : null;
  return p.finish(gate, preFp, postFp);
}

/**
 * The SYNCHRONOUS head of a git-write decision: everything up to (and NOT including) the
 * leak gate. Returns `{ done: <result> }` for an early decision (allow a read / env hatch;
 * deny no-grant / re-entrant id / failed openCallClaim), or `{ needsGate, gateScope,
 * finish(gate) }` whose `finish` is the synchronous TAIL run after the gate. All grant/
 * call-store mutations happen in these two synchronous halves; the gate sits between them.
 */
function prepareEvaluate({
  command,
  argv,
  projectKey = null,
  env = process.env,
  now = Date.now(),
  sessionLabel = null,
  window = null,
} = {}) {
  let offender;
  if (Array.isArray(argv)) {
    // Invocation-layer (shim) path: argv is already isolated git args. Mirror the
    // command-string path's early allows exactly — env hatch open, or a read.
    if (!gitWriteBlockEnabled(env)) return { done: { allow: true } }; // the launch-time env hatch
    offender = offenderForGit(['git', ...argv]); // the ONE classifier (ARCH-008)
    if (!offender) return { done: { allow: true } }; // a read / info form
  } else {
    const base = decideGitWrite(typeof command === 'string' ? command : '', env);
    if (base.allow) return { done: { allow: true } }; // a read, or the env hatch is open
    offender = base.offender ?? 'git';
  }
  const sub = offender.startsWith('git ') ? offender.slice(4) : offender;

  // Does this command require the mandatory leak gate? Any git write that is NOT a
  // provably-non-publishing local op (GATE_EXEMPT_WRITES) must gate. On the
  // command-string path scan ALL writes, so a publish chained after a non-publish
  // write (`git add f && git commit`) cannot skip the gate (round-4 finding 1); the
  // argv (shim) path is a single already-isolated invocation, so its lone `sub` is
  // authoritative. Fall back to `sub` if the walker finds nothing (defensive: the
  // classifier already said this is a write).
  const subs = Array.isArray(argv)
    ? [sub]
    : collectGitWrites(typeof command === 'string' ? command : '').map((o) => (o.startsWith('git ') ? o.slice(4) : o));
  const gatingSubs = (subs.length ? subs : [sub]).filter((s) => !GATE_EXEMPT_WRITES.has(s));
  const needsGate = gatingSubs.length > 0;
  // FEAT-169 — the leak-gate SCOPE. A narrowed (outgoing-delta) working-tree scan
  // is safe ONLY when every write that needs the gate is a plain COMMIT: a commit
  // adds a bounded delta on top of HEAD. A push (or any unknown/aliased publishing
  // verb) publishes the whole history/tree, so it must keep the full-tree scan —
  // narrow stays false for anything that is not purely commit(s). Passed to the
  // injected runLeakGate (runLeakGateForRepo) so this module stays the one place
  // that knows what each write publishes (ARCH-010).
  const gateScope = { narrow: needsGate && gatingSubs.every((s) => s === 'commit') };

  const win = window && window.binding && window.toolUseId && !Array.isArray(argv) ? window : null;
  // The git write invocations written out in the command, as a multiset of bare-`git`
  // verbs. Computed here (before any deny) so a tombstone for a denied call carries the
  // slots the shim matches against (BUG-231 r7).
  const slots = win ? bareGitWrites(command) : [];
  // BUG-231 r5 — one call id is decided ONCE: a PreToolUse carrying an id the store
  // already knows (open, withdrawn or ended) is refused before anything is claimed.
  if (win && callClaimState(win.binding, win.toolUseId, now) !== 'unknown') return { done: { allow: false, offender, reason: gitWriteRefusal(offender) } };
  const claim = projectKey ? claimGrant(projectKey, now) : null;
  if (!claim) {
    // BUG-231 r7 — a call id denied because no grant existed is a TERMINAL outcome and
    // must leave a tombstone, exactly like a gate-fail or a store withdrawal. Without it
    // the id stayed 'unknown', so a once-grant issued after the deny let the SAME id retry
    // and steal it from the next genuine call (verify run 01a10e18). The tombstone keeps
    // the id denied for its life; a post-deny grant reaches only the NEXT Bash call.
    if (win) denyCallClaim({ binding: win.binding, toolUseId: win.toolUseId, agentKey: win.agentKey ?? 'main', projectKey, data: { mode: 'denied', decision: null, slots, view: null, gatedFp: null, hookRecord: null } }, now);
    return { done: { allow: false, offender, reason: gitWriteRefusal(offender) } };
  }
  const decision = newDecisionId();

  // BUG-231 — the hook's decision for ONE Bash tool call becomes that call's WINDOW,
  // which the shim REDEEMS per git invocation instead of deciding again.
  //  - The hook ALWAYS runs the leak gate before a publish, exactly as before (review r1
  //    F1: no history of "this verb reached the shim" can rule out a user shell function
  //    that routes a publish around the shim). It records a fingerprint of the content it
  //    scanned, so the shim re-gates at the write only when the content has changed since
  //    (a leak the command itself creates is still caught; an unchanged one is not
  //    scanned twice).
  //  - When every write provably reaches the shim (bare `git` head, a direct session,
  //    each verb already observed by the shim), the grant is only RESERVED here; the first
  //    redeem spends it, and a call that never reached git releases it at its end.
  //    Otherwise the hook spends here, as before.
  //  - Only writes with a literal bare `git` head get a redeemable slot (review r1 F2:
  //    a write that runs outside the shim must not leave a slot another process can use).
  //    `slots` is computed above, before the no-grant deny, so a tombstone carries them.
  const deferrable = !!win && win.shimReachesCli === true && slots.length > 0 && gitWritesReachShim(command)
    && slots.every((o) => reachProvenFor(win.binding, o));
  const startedAt = Date.now();
  const clock = () => now + Math.max(0, Date.now() - startedAt); // the caller's clock, advanced by real elapsed time (BUG-249: incl. the awaited gate)
  const grant = claim.view;
  // BUG-231 r5 — the call's claim state is the STORE's, keyed by this call id, from the
  // moment the handle exists (a re-entrant decision for the same id is refused above).
  // BUG-249 — mode starts 'pending': redeemGitWrite refuses to redeem a call whose hook
  // gate has not yet completed (finish sets 'decided'/'deferred'). In the synchronous
  // composition this is unobservable (finish runs in the same tick); it only bites a
  // concurrent redeem that the async gate now makes possible.
  const data = win ? { mode: 'pending', decision, slots, view: grant, gatedFp: null, hookRecord: null } : null;
  if (win && !openCallClaim({ binding: win.binding, toolUseId: win.toolUseId, agentKey: win.agentKey ?? 'main', projectKey, claim, data }, now)) {
    return { done: { allow: false, offender, reason: gitWriteRefusal(offender) } };
  }
  // BUG-249 — the repo content is fingerprinted BEFORE the gate and AGAIN after it; the
  // composition (evaluateGitWrite / evaluateGitWriteAsync) captures both and hands them to
  // `finish`, which caches `gatedFp` only when the two agree, so the shim's skip can never
  // be certified against content the scan did not actually see (an async scan can overlap
  // another operation that mutates the tree). BUG-249 r2: the capture moved OUT of here so
  // the async composition can AWAIT it off-loop; `wantsFp` says whether a window even needs
  // one. Synchronous composition: identical to the old inline capture.
  const wantsFp = needsGate && !!win;
  const release = () => { if (win) endCallClaims(win.binding, (c) => c.toolUseId === win.toolUseId, clock()); else endClaim(claim); };

  const finish = (gate, preFp = null, postFp = null) => {
    let keepHandle = false;
    try {
      if (needsGate) {
        if (!gate.ok) {
          release(); // refused: a reserved use goes back
          // Refused at decide — this write never runs. Record it as blocked, not as a
          // permit a later reader could mistake for a landed commit (BUG-184).
          const rec = recordGitWrite({ projectKey, offender, command, sessionLabel, grantScope: grant.scope, gatePassed: false, outcome: 'blocked-gate', decision, now });
          return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec };
        }
        if (win) { data.gatedFp = fingerprintsAgree(preFp, postFp) ? postFp : null; }
      }
      if (deferrable) {
        // The Bash call may start; the store holds its handle. Each shimmed write in it is
        // authorised by the store at that write (redeemGitWrite → useCallClaim).
        data.mode = 'deferred';
        keepHandle = true;
        return { allow: true, granted: true, offender, grant, deferred: true, decision };
      }
      // FEAT-164 r4 — the store authorises this write NOW (after the gate): a revoke,
      // expiry or lapse that landed since the claim denies it.
      if (!(win ? useCallClaim(win.binding, win.toolUseId, clock()) : useClaim(claim, clock()))) return { allow: false, offender, reason: gitWriteRefusal(offender) };
      keepHandle = !!win; // the call keeps the HANDLE in the store so each later write re-asks it
    } finally {
      if (!keepHandle) release(); // an exception or a denial never strands a reservation
    }
    // BUG-184 — record the DECISION as 'permitted', NOT as executed. The host cannot
    // observe whether the caller then runs git (over the shim path the exec lives in
    // another process that may abort or fail). The executor confirms the real outcome
    // via `confirmGitWrite`; until then the record honestly reads "authorised, not
    // yet observed to have run", so the audit can never claim a commit HEAD lacks.
    const rec = recordGitWrite({
      projectKey, offender, command, sessionLabel, grantScope: grant.scope,
      gatePassed: needsGate ? true : null, outcome: 'permitted', decision, now,
    });
    if (win) {
      // Decided here; the store's call record lets the shim's invocations of THIS command
      // redeem this decision (no second claim, no second spend), each one re-asking the
      // store for this call id, and lets the first matching invocation confirm this record.
      data.mode = 'decided';
      data.hookRecord = { id: rec.id, confirmToken: rec.confirmToken, offender, used: false };
    }
    return { allow: true, granted: true, offender, grant, record: rec, decision };
  };
  return { needsGate, gateScope, wantsFp, finish };
}

/** A repo content fingerprint `{ head, entries[], gateKey }` from the injected reader, or
 * null. `gateKey` (BUG-231 r7) hashes the gate-verdict inputs that are NOT repo content —
 * the gate script, the token list, and the resolved own-project names (see
 * leak-gate-host.ts gateVerdictKey). Never throws. */
function normalizeFingerprint(f) {
  return f && typeof f.head === 'string' && Array.isArray(f.entries)
    ? { head: f.head, entries: new Set(f.entries), gateKey: typeof f.gateKey === 'string' ? f.gateKey : null }
    : null;
}
function safeFingerprint(fn) {
  if (typeof fn !== 'function') return null;
  try { return normalizeFingerprint(fn()); } catch { return null; }
}
/** BUG-249 r2 — async twin of `safeFingerprint`: AWAIT the injected reader so a big-repo
 * fingerprint (git ls-files / hash-object over the whole tree, the r1 break) runs off the
 * event loop, exactly as the leak-gate scan does. A synchronous reader (the verify call
 * sites) is awaited harmlessly; any throw/rejection → null, which forces a re-gate. */
async function safeFingerprintAsync(fn) {
  if (typeof fn !== 'function') return null;
  try { return normalizeFingerprint(await fn()); } catch { return null; }
}

/** True when `now` holds no content the gate has not already scanned in `gated`
 * (same HEAD; every path:blob present now was present then). A token-scan gate
 * cannot newly fail on a subset of what it passed — PROVIDED the gate's verdict is
 * still a function of the same config.
 *
 * BUG-231 r7 — the content fingerprint alone is NOT enough: the gate's verdict for
 * byte-identical content also depends on the gate script, the token list, the per-repo
 * allowlist and the resolved own-project names. The allowlist is already in `entries`
 * (the gate reads it from the git index, which the fingerprint hashes), but the rest are
 * not, so a changed gate/token-list/own-project resolution could flip the verdict for the
 * same content and the skip would run an ungated commit (verify run 01a10e18, probe
 * af310f923a95). The skip is therefore allowed ONLY when a gate-config key is present on
 * BOTH sides AND unchanged; a missing key on either side (the reader could not enumerate
 * the inputs) forces a re-gate — fail toward running the gate. */
function fingerprintCovered(gated, now) {
  if (!gated || !now || gated.head !== now.head) return false;
  if (!gated.gateKey || !now.gateKey || gated.gateKey !== now.gateKey) return false;
  for (const e of now.entries) if (!gated.entries.has(e)) return false;
  return true;
}

/* ══ BUG-231 — one Bash tool call = one decision ═══════════════════════════════════
 * In a direct session the hook decides a Bash git write, and every `git` inside it
 * reaches the shim, which used to decide AGAIN through /api/git-shim/decide: a
 * once-grant spent by the hook was refused by the shim, a granted commit ran the
 * leak gate twice, and the hook left a record no executor ever confirmed.
 *
 * Now the hook's decision is a WINDOW bound to the tool call:
 *   binding   — a per-session random key the runtime mints and BAKES into its shim
 *               (git-shim.mjs), so a shim invocation names its session without any
 *               agent-writable env. Unknown/forged key → no window → the independent
 *               path below (exactly the old behaviour).
 *   toolUseId — the CLI's id for the Bash call; PostToolUse / PostToolUseFailure /
 *               PermissionDenied / a later deny close it by that id.
 *   slots     — the git write invocations written out in that command, as a
 *               multiset of verbs. Each shim redeem consumes one. When the slots run
 *               out, a further invocation decides independently (for a once-grant that
 *               means refused). So whatever process redeems a window — the command
 *               itself, or anything else holding the session's shim — can never get
 *               more writes than the ONE decision approved. 'once' therefore means:
 *               one Bash tool call, covering the git writes written in it.
 * A window ends at the tool call's end, a permission deny, the agent's next tool call
 * (supersession), the turn's end or the session's close. CLAIM_MAX_MS only WITHDRAWS it.
 * Ending a window ends its handle: a use still only RESERVED returns (nothing ran
 * under it). The spend happens at the first write the store authorises (in the hook
 * when it decided fully, else at the first redeem), never at the end, so a lapse can
 * never hand a used once-grant out again.
 *
 * FEAT-164 r4 — a window holds a claim HANDLE, never an allow. Every redeem asks the
 * store (useClaim) at the write. If the store has withdrawn the decision (revoke,
 * expiry, replacement), the window turns 'withdrawn' and refuses the rest of the call:
 * it does NOT fall back to a fresh decision, which would decide one Bash call twice.
 *
 * BUG-231 r5 — the "window" is the STORE's call record (git-grant-store.mjs
 * openCallClaim / findCallFor / useCallClaim / endCallClaims), keyed by binding +
 * tool_use_id. Withdrawn — including the CLAIM_MAX_MS lapse — is TERMINAL for that call
 * id until its call-end signal: time never drops it back to "undecided" (the 5th break,
 * run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9), and a known call id is never decided again.
 * Only a write matching no not-ended call (no binding / Codex, git after the call ended,
 * a verb not written out) decides independently.
 *
 * BUG-249 — the RUNTIME now composes this decision asynchronously (evaluateGitWriteAsync /
 * redeemGitWriteAsync await the off-loop leak-gate scan AND, r2, the off-loop repo
 * fingerprint), so two redeems of one window CAN now interleave. The store mutations stay
 * synchronous in prepare/finish with no await between a slot check and its spend, and the
 * pending-mode guard + the atomic slot re-check at the spend make exactly one of any two
 * concurrent redeems win. (The sync compositions remain fully sequential, as before.)
 */
/** binding → Set(offender) the shim has observed for that session (per-verb reach proof; gates the SPEND deferral only, never an allow). */
const reachProven = new Map();

function newDecisionId() { return `d-${randomBytes(8).toString('hex')}`; }

function reachProvenFor(binding, offender) { return reachProven.get(binding)?.has(offender) ?? false; }

/**
 * The runtime calls this at EVERY PreToolUse of a session (any tool), before deciding.
 * An agent's next tool call means its previous non-read-only Bash call has ended
 * (Claude Code runs a write-classified Bash alone), so that agent's open calls end
 * here even if their Post event never arrived. Only ever fails closed.
 */
export function beginGitWriteToolCall({ binding, toolUseId = null, agentKey = 'main', now = Date.now() } = {}) {
  if (!binding) return;
  const a = agentKey ?? 'main';
  endCallClaims(binding, (c) => c.toolUseId !== toolUseId && c.agentKey === a, now);
}

/** End every call one (sub)agent of a session left open (SubagentStop). Idempotent. */
export function endGitWriteAgent(binding, agentKey, now = Date.now()) {
  if (binding) endCallClaims(binding, (c) => c.agentKey === agentKey, now);
}

/** End one tool call (Post / PostFailure / PermissionDenied / a deny). Idempotent. */
export function endGitWriteToolCall(binding, toolUseId, now = Date.now()) {
  if (binding && toolUseId) endCallClaims(binding, (c) => c.toolUseId === toolUseId, now);
}

/** End every call of a session (turn end, session close). Idempotent. */
export function endGitWriteToolCalls(binding, now = Date.now()) {
  if (binding) endCallClaims(binding, () => true, now);
}

/**
 * The SHIM's decision for one git invocation (/api/git-shim/decide). With a session
 * `binding` whose live window has a slot for this verb, the invocation REDEEMS that
 * window: no new claim. A publish is gated here, at the moment it runs. Otherwise it
 * decides independently through evaluateGitWrite → claimGrant, exactly as before
 * (Codex sessions, a subprocess git in a command with no git text, background jobs,
 * a verb the command did not write out).
 */
export function redeemGitWrite(opts = {}) {
  const p = prepareRedeem(opts);
  if (p.independent) return evaluateGitWrite(independentOpts(opts));
  if (p.done) return p.done;
  // BUG-249 r2 — the skip-check fingerprint is captured HERE so the async composition can
  // AWAIT it off-loop. `fingerprintCovered` decides whether the hook's gate still covers
  // the current content; a null/changed reading forces a re-gate (fail toward the gate).
  const needsGate = p.rawNeedsGate && !fingerprintCovered(p.gatedFp, safeFingerprint(opts.repoFingerprint));
  const gate = needsGate ? runGateSync(opts.runLeakGate, p.gateScope) : null;
  return p.finish(gate, needsGate);
}

/**
 * BUG-249 — the async composition of the shim's decision, used by /api/git-shim/decide so
 * the leak-gate scan does not block the event loop. SAME decision as `redeemGitWrite`:
 * `prepareRedeem` does every read/guard synchronously, `finish` does the spend + record
 * synchronously; only the gate is awaited. The independent fallback awaits the async
 * evaluate so a Codex/subprocess write is decided off-thread too.
 */
export async function redeemGitWriteAsync(opts = {}) {
  const p = prepareRedeem(opts);
  if (p.independent) return evaluateGitWriteAsync(independentOpts(opts));
  if (p.done) return p.done;
  // BUG-249 r2 — AWAIT the skip-check fingerprint off-loop (the r1 break left it sync, so a
  // big-repo redeem still froze ~930ms here even when it then went on to skip the gate).
  const needsGate = p.rawNeedsGate && !fingerprintCovered(p.gatedFp, await safeFingerprintAsync(opts.repoFingerprint));
  const gate = needsGate ? await runGateAsync(opts.runLeakGate, p.gateScope) : null;
  return p.finish(gate, needsGate);
}

/** The exact opts the shim's independent path hands to evaluate (unchanged from BUG-231). */
function independentOpts({ argv, projectKey, env, now, runLeakGate, sessionLabel }) {
  return { argv, projectKey, env, now, runLeakGate, sessionLabel };
}

/**
 * The SYNCHRONOUS head of the shim's redeem decision: findCallFor + all guards, up to (and
 * NOT including) the gate. Returns `{ independent: true }` (decide afresh), `{ done }` (an
 * early allow/deny), or `{ needsGate, gateScope, finish(gate) }` whose `finish` spends the
 * call's handle synchronously AFTER the gate.
 */
function prepareRedeem({
  binding = null,
  argv,
  projectKey = null,
  env = process.env,
  now = Date.now(),
  sessionLabel = null,
} = {}) {
  if (!Array.isArray(argv) || !binding || !projectKey) return { independent: true };
  if (!gitWriteBlockEnabled(env)) return { done: { allow: true } };
  const offender = offenderForGit(['git', ...argv]);
  if (!offender) return { done: { allow: true } };
  // BUG-231 r5 — the STORE says which live call (if any) this written-out write belongs
  // to. No not-ended call with a slot for it → it is no call's write → independent.
  const call = findCallFor(binding, projectKey, offender, now);
  if (!call) return { independent: true };
  const w = call.data;

  // The store withdrew this call (revoke / expiry / replacement / lapse): TERMINAL for
  // the call id. Never a fresh decision — that would decide one Bash call twice.
  if (call.status !== 'open') return { done: { allow: false, offender, reason: gitWriteRefusal(offender), decision: w.decision } };
  // BUG-249 — refuse to redeem a call whose hook gate has NOT completed. The hook sets
  // mode 'decided'/'deferred' in its (post-gate) finish; 'pending' means the hook is still
  // inside its async gate. In a direct session the Bash tool is suspended during the hook,
  // so this never fires there; it fail-closes a concurrent /decide that the async gate
  // newly makes possible. Unobservable on the synchronous composition.
  if (w.mode === 'pending') return { done: { allow: false, offender, reason: gitWriteRefusal(offender), decision: w.decision } };
  const startedAt = Date.now();
  const clock = () => now + Math.max(0, Date.now() - startedAt); // read AFTER the gate
  const sub = offender.startsWith('git ') ? offender.slice(4) : offender;
  const rawNeedsGate = !GATE_EXEMPT_WRITES.has(sub);
  // BUG-249 r2 — the skip-check fingerprint (does the hook's gate still cover this
  // content?) moved to the composition so it can be AWAITED off-loop. prepareRedeem exposes
  // `rawNeedsGate` (is this a gating verb at all) and the hook's stored `gatedFp`; the
  // composition computes the resolved `needsGate` via `fingerprintCovered` and passes it to
  // `finish`. The hook gated this call's content before it ran; the write re-gates unless
  // the content is provably unchanged-or-less since (then a token-scan gate cannot newly fail).
  // FEAT-169 — same scope rule as the hook: a lone redeemed COMMIT narrows to the
  // outgoing delta; a push (or unknown verb) keeps the full-tree scan.
  const gateScope = { narrow: sub === 'commit' };

  const finish = (gate, needsGate) => {
    if (needsGate && !gate.ok) {
      const rec = recordGitWrite({ projectKey, offender, command: null, sessionLabel, grantScope: w.view?.scope ?? null, gatePassed: false, outcome: 'blocked-gate', decision: w.decision, now });
      return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec, decision: w.decision };
    }
    // BUG-249 — re-check the slot ATOMICALLY with the spend (finish has no await). Two
    // concurrent redeems both pass findCallFor above (slot present) before either spends;
    // this makes exactly ONE of them win the slot. Synchronous/sequential: the slot is
    // always present here, so this is a no-op. A redeem that LOST the slot denies here —
    // it must NOT fall to the independent path (it found the call), which is why the
    // check sits at the spend, not as a slot removal before the gate (that would make the
    // call undiscoverable to a legitimate concurrent redeem and misroute it to independent).
    if (!w.slots.includes(offender)) return { allow: false, offender, reason: gitWriteRefusal(offender), decision: w.decision };
    // THE allow for this invocation: the store's answer for this call's handle, now. A
    // deferred once-grant is spent here, once (the store keys the spend by the handle).
    if (!useCallClaim(binding, call.toolUseId, clock())) {
      return { allow: false, offender, reason: gitWriteRefusal(offender), decision: w.decision };
    }
    w.mode = 'used';
    w.slots.splice(w.slots.indexOf(offender), 1);
    let set = reachProven.get(binding);
    if (!set) { set = new Set(); reachProven.set(binding, set); }
    set.add(offender);
    let rec;
    if (w.hookRecord && !w.hookRecord.used && w.hookRecord.offender === offender) {
      // The hook already recorded this decision; this invocation is its executor.
      w.hookRecord.used = true;
      rec = { id: w.hookRecord.id, confirmToken: w.hookRecord.confirmToken };
    } else {
      rec = recordGitWrite({ projectKey, offender, command: null, sessionLabel, grantScope: w.view?.scope ?? null, gatePassed: rawNeedsGate ? true : null, outcome: 'permitted', decision: w.decision, now });
    }
    return { allow: true, granted: true, offender, grant: w.view, record: rec, decision: w.decision, redeemed: true };
  };
  return { rawNeedsGate, gatedFp: w.gatedFp, gateScope, finish };
}

/** TEST-ONLY: drop reach proofs (call state is the store's: _resetGitGrantsForTest clears it). */
export function _resetGitWriteWindowsForTest() { _resetCallClaimsForTest(); reachProven.clear(); }

/** TEST/DIAGNOSTIC: a snapshot of a session's not-ended calls, read from the store (no capabilities). */
export function _gitWriteWindowsOf(binding) {
  return _callClaimsOf(binding).map(({ toolUseId, status, agentKey, data }) => ({
    toolUseId, decision: data.decision, state: status === 'withdrawn' ? 'withdrawn' : data.mode, slots: [...data.slots], agentKey }));
}

/** Normalise a gate verdict object (never throws on a weird shape). */
function normalizeGate(r) {
  if (r && typeof r === 'object') return { ok: !!r.ok, detail: String(r.detail ?? '') };
  return { ok: !!r, detail: '' };
}

/** Run an injected SYNCHRONOUS gate, fail-closed. A missing runner, a thrown error, or a
 * runner that unexpectedly returns a promise on this path all deny. */
function runGateSync(run, scope = {}) {
  if (typeof run !== 'function') return { ok: false, detail: 'no leak-gate runner available — failing closed' };
  try {
    const r = run(scope);
    if (r && typeof r.then === 'function') return { ok: false, detail: 'leak gate returned a promise on the synchronous path — failing closed' };
    return normalizeGate(r);
  } catch (e) {
    return { ok: false, detail: `leak gate errored: ${(e && e.message) || e}` };
  }
}

/** BUG-249 — run an injected gate that may be ASYNC, fail-closed. The runner is AWAITED
 * INSIDE the try, so a synchronous throw, a rejected promise, or a missing runner all
 * resolve to a deny; the resolved value is normalised exactly as the sync path. */
async function runGateAsync(run, scope = {}) {
  if (typeof run !== 'function') return { ok: false, detail: 'no leak-gate runner available — failing closed' };
  try {
    return normalizeGate(await run(scope));
  } catch (e) {
    return { ok: false, detail: `leak gate errored: ${(e && e.message) || e}` };
  }
}

/** BUG-249 — true when two repo fingerprints describe the SAME scanned content+config, so
 * a `gatedFp` cached after the gate certifies only content the scan actually saw. */
function fingerprintsAgree(a, b) {
  if (!a || !b) return false;
  if (a.head !== b.head || a.gateKey !== b.gateKey) return false;
  if (a.entries.size !== b.entries.size) return false;
  for (const e of a.entries) if (!b.entries.has(e)) return false;
  return true;
}
