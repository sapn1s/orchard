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
export function evaluateGitWrite({
  command,
  argv,
  projectKey = null,
  env = process.env,
  now = Date.now(),
  runLeakGate = null,
  sessionLabel = null,
  window = null,
  repoFingerprint = null,
} = {}) {
  let offender;
  if (Array.isArray(argv)) {
    // Invocation-layer (shim) path: argv is already isolated git args. Mirror the
    // command-string path's early allows exactly — env hatch open, or a read.
    if (!gitWriteBlockEnabled(env)) return { allow: true }; // the launch-time env hatch
    offender = offenderForGit(['git', ...argv]); // the ONE classifier (ARCH-008)
    if (!offender) return { allow: true }; // a read / info form
  } else {
    const base = decideGitWrite(typeof command === 'string' ? command : '', env);
    if (base.allow) return { allow: true }; // a read, or the env hatch is open
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
  const needsGate = (subs.length ? subs : [sub]).some((s) => !GATE_EXEMPT_WRITES.has(s));

  const win = window && window.binding && window.toolUseId && !Array.isArray(argv) ? window : null;
  // The git write invocations written out in the command, as a multiset of bare-`git`
  // verbs. Computed here (before any deny) so a tombstone for a denied call carries the
  // slots the shim matches against (BUG-231 r7).
  const slots = win ? bareGitWrites(command) : [];
  // BUG-231 r5 — one call id is decided ONCE: a PreToolUse carrying an id the store
  // already knows (open, withdrawn or ended) is refused before anything is claimed.
  if (win && callClaimState(win.binding, win.toolUseId, now) !== 'unknown') return { allow: false, offender, reason: gitWriteRefusal(offender) };
  const claim = projectKey ? claimGrant(projectKey, now) : null;
  if (!claim) {
    // BUG-231 r7 — a call id denied because no grant existed is a TERMINAL outcome and
    // must leave a tombstone, exactly like a gate-fail or a store withdrawal. Without it
    // the id stayed 'unknown', so a once-grant issued after the deny let the SAME id retry
    // and steal it from the next genuine call (verify run 01a10e18). The tombstone keeps
    // the id denied for its life; a post-deny grant reaches only the NEXT Bash call.
    if (win) denyCallClaim({ binding: win.binding, toolUseId: win.toolUseId, agentKey: win.agentKey ?? 'main', projectKey, data: { mode: 'denied', decision: null, slots, view: null, gatedFp: null, hookRecord: null } }, now);
    return { allow: false, offender, reason: gitWriteRefusal(offender) };
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
  const clock = () => now + Math.max(0, Date.now() - startedAt); // the caller's clock, advanced by real elapsed time
  const grant = claim.view;
  // BUG-231 r5 — the call's claim state is the STORE's, keyed by this call id, from the
  // moment the handle exists (a re-entrant decision for the same id is refused above).
  const data = win ? { mode: 'pending', decision, slots, view: grant, gatedFp: null, hookRecord: null } : null;
  if (win && !openCallClaim({ binding: win.binding, toolUseId: win.toolUseId, agentKey: win.agentKey ?? 'main', projectKey, claim, data }, now)) {
    return { allow: false, offender, reason: gitWriteRefusal(offender) };
  }
  const endCall = () => endCallClaims(win.binding, (c) => c.toolUseId === win.toolUseId, clock());
  let keepHandle = false;
  try {
    if (needsGate) {
      const gate = runLeakGate ? safeGate(runLeakGate) : { ok: false, detail: 'no leak-gate runner available — failing closed' };
      if (!gate.ok) {
        if (win) endCall(); else endClaim(claim); // refused: a reserved use goes back
        // Refused at decide — this write never runs. Record it as blocked, not as a
        // permit a later reader could mistake for a landed commit (BUG-184).
        const rec = recordGitWrite({ projectKey, offender, command, sessionLabel, grantScope: grant.scope, gatePassed: false, outcome: 'blocked-gate', decision, now });
        return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec };
      }
      if (win) data.gatedFp = safeFingerprint(repoFingerprint);
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
    if (!keepHandle) { if (win) endCall(); else endClaim(claim); } // an exception or a denial never strands a reservation
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
}

/** A repo content fingerprint `{ head, entries[], gateKey }` from the injected reader, or
 * null. `gateKey` (BUG-231 r7) hashes the gate-verdict inputs that are NOT repo content —
 * the gate script, the token list, and the resolved own-project names (see
 * leak-gate-host.ts gateVerdictKey). Never throws. */
function safeFingerprint(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const f = fn();
    return f && typeof f.head === 'string' && Array.isArray(f.entries)
      ? { head: f.head, entries: new Set(f.entries), gateKey: typeof f.gateKey === 'string' ? f.gateKey : null }
      : null;
  } catch { return null; }
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
 * Everything here is synchronous (the gate runs execFileSync), so two redeems of one
 * window can never interleave between check and spend.
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
export function redeemGitWrite({
  binding = null,
  argv,
  projectKey = null,
  env = process.env,
  now = Date.now(),
  runLeakGate = null,
  sessionLabel = null,
  repoFingerprint = null,
} = {}) {
  const independent = () => evaluateGitWrite({ argv, projectKey, env, now, runLeakGate, sessionLabel });
  if (!Array.isArray(argv) || !binding || !projectKey) return independent();
  if (!gitWriteBlockEnabled(env)) return { allow: true };
  const offender = offenderForGit(['git', ...argv]);
  if (!offender) return { allow: true };
  // BUG-231 r5 — the STORE says which live call (if any) this written-out write belongs
  // to. No not-ended call with a slot for it → it is no call's write → independent.
  const call = findCallFor(binding, projectKey, offender, now);
  if (!call) return independent();
  const w = call.data;

  // The store withdrew this call (revoke / expiry / replacement / lapse): TERMINAL for
  // the call id. Never a fresh decision — that would decide one Bash call twice.
  if (call.status !== 'open') return { allow: false, offender, reason: gitWriteRefusal(offender), decision: w.decision };
  const startedAt = Date.now();
  const clock = () => now + Math.max(0, Date.now() - startedAt); // read AFTER the gate
  const sub = offender.startsWith('git ') ? offender.slice(4) : offender;
  const needsGate = !GATE_EXEMPT_WRITES.has(sub);
  // The hook gated this call's content before it ran; re-gate at the write unless the
  // content is provably unchanged-or-less since (then the gate cannot newly fail).
  if (needsGate && !fingerprintCovered(w.gatedFp, safeFingerprint(repoFingerprint))) {
    const gate = runLeakGate ? safeGate(runLeakGate) : { ok: false, detail: 'no leak-gate runner available — failing closed' };
    if (!gate.ok) {
      const rec = recordGitWrite({ projectKey, offender, command: null, sessionLabel, grantScope: w.view?.scope ?? null, gatePassed: false, outcome: 'blocked-gate', decision: w.decision, now });
      return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec, decision: w.decision };
    }
  }
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
    rec = recordGitWrite({ projectKey, offender, command: null, sessionLabel, grantScope: w.view?.scope ?? null, gatePassed: needsGate ? true : null, outcome: 'permitted', decision: w.decision, now });
  }
  return { allow: true, granted: true, offender, grant: w.view, record: rec, decision: w.decision, redeemed: true };
}

/** TEST-ONLY: drop reach proofs (call state is the store's: _resetGitGrantsForTest clears it). */
export function _resetGitWriteWindowsForTest() { _resetCallClaimsForTest(); reachProven.clear(); }

/** TEST/DIAGNOSTIC: a snapshot of a session's not-ended calls, read from the store (no capabilities). */
export function _gitWriteWindowsOf(binding) {
  return _callClaimsOf(binding).map(({ toolUseId, status, agentKey, data }) => ({
    toolUseId, decision: data.decision, state: status === 'withdrawn' ? 'withdrawn' : data.mode, slots: [...data.slots], agentKey }));
}

function safeGate(run) {
  try {
    const r = run();
    if (r && typeof r === 'object') return { ok: !!r.ok, detail: String(r.detail ?? '') };
    return { ok: !!r, detail: '' };
  } catch (e) {
    return { ok: false, detail: `leak gate errored: ${(e && e.message) || e}` };
  }
}
