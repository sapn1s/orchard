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
 *   4. Permitted: commit the claim (spends a once-grant's reserved use) and
 *      RECORD the write for the after-the-fact view.
 *
 * FEAT-164 r3 — steps 2-4 are ONE claim from the store's single authority
 * (claimGrant → settleClaim, git-grant-store.mjs): the grant is resolved and a
 * once-grant's use RESERVED before the gate runs, and the write is permitted only
 * if that same claim commits. A re-entrant or concurrent decision cannot claim the
 * reserved use, and nothing is re-read after the gate.
 *
 * The gate is INJECTED (`runLeakGate`) so this stays pure and unit-testable; the
 * runtime passes a real subprocess runner (scripts/leak-gate.mjs over the repo).
 * When no runner is available for a publishing write, we FAIL CLOSED — an
 * unverifiable commit is treated as a failed gate, never waved through.
 */
import { randomBytes } from 'node:crypto';
import { decideGitWrite, gitWriteRefusal, gitWriteGateFailedRefusal, offenderForGit, gitWriteBlockEnabled, collectGitWrites, gitWritesReachShim, bareGitWrites, GATE_EXEMPT_WRITES } from './git-write-policy.mjs';
import { claimGrant, settleClaim, claimSettled, recordGitWrite, CLAIM_MAX_MS } from './git-grant-store.mjs';

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

  const claim = projectKey ? claimGrant(projectKey, now) : null;
  if (!claim) return { allow: false, offender, reason: gitWriteRefusal(offender) };
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
  const win = window && window.binding && window.toolUseId && !Array.isArray(argv) ? window : null;
  const slots = win ? bareGitWrites(command) : [];
  const deferrable = !!win && win.shimReachesCli === true && slots.length > 0 && gitWritesReachShim(command)
    && slots.every((o) => reachProvenFor(win.binding, o));
  const startedAt = Date.now();
  const clock = () => now + Math.max(0, Date.now() - startedAt); // the caller's clock, advanced by real elapsed time
  const grant = claim.view;
  let gatedFp = null;
  let keepReserved = false;
  try {
    if (needsGate) {
      const gate = runLeakGate ? safeGate(runLeakGate) : { ok: false, detail: 'no leak-gate runner available — failing closed' };
      if (!gate.ok) {
        settleClaim(claim, 'release', clock()); // refused: the reserved use goes back
        // Refused at decide — this write never runs. Record it as blocked, not as a
        // permit a later reader could mistake for a landed commit (BUG-184).
        const rec = recordGitWrite({ projectKey, offender, command, sessionLabel, grantScope: grant.scope, gatePassed: false, outcome: 'blocked-gate', decision, now });
        return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec };
      }
      if (win) gatedFp = safeFingerprint(repoFingerprint);
    }
    if (deferrable) {
      openWindow(win, { decision, projectKey, claim, state: 'reserved', slots, view: grant, now, gatedFp });
      keepReserved = true;
      return { allow: true, granted: true, offender, grant, deferred: true, decision };
    }
    // The ONE place a write is permitted: only if THIS claim commits.
    if (!settleClaim(claim, 'commit', clock())) return { allow: false, offender, reason: gitWriteRefusal(offender) };
  } finally {
    if (!keepReserved && !claimSettled(claim)) settleClaim(claim, 'release', clock()); // an exception never strands a reservation
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
    // Already decided and spent here; the window only lets the shim's invocations of
    // THIS command redeem this decision (no second claim, no second spend), and lets
    // the first matching invocation confirm this record (no phantom pending record).
    openWindow(win, { decision, projectKey, claim: null, state: 'committed', slots, view: grant, now, gatedFp,
      hookRecord: { id: rec.id, confirmToken: rec.confirmToken, offender, used: false } });
  }
  return { allow: true, granted: true, offender, grant, record: rec, decision };
}

/** A repo content fingerprint `{ head, entries[] }` from the injected reader, or null. Never throws. */
function safeFingerprint(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const f = fn();
    return f && typeof f.head === 'string' && Array.isArray(f.entries) ? { head: f.head, entries: new Set(f.entries) } : null;
  } catch { return null; }
}

/** True when `now` holds no content the gate has not already scanned in `gated`
 * (same HEAD; every path:blob present now was present then). A token-scan gate
 * cannot newly fail on a subset of what it passed. */
function fingerprintCovered(gated, now) {
  if (!gated || !now || gated.head !== now.head) return false;
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
 * (supersession), the turn's end, the session's close, or CLAIM_MAX_MS (lapse).
 * Ending a window whose claim is still only RESERVED releases it (nothing ran under
 * it); a window whose claim was spent is just dropped. The spend happens at the first
 * redeem (or in the hook when it decided fully), never at the end, so a lapse can
 * never hand a used once-grant out again.
 *
 * Everything here is synchronous (the gate runs execFileSync), so two redeems of one
 * window can never interleave between check and settle.
 */
/** binding → Map(toolUseId → window). Module-private. */
const windows = new Map();
/** binding → Set(offender) the shim has observed for that session (per-verb reach proof; gates the SPEND deferral only). */
const reachProven = new Map();

function newDecisionId() { return `d-${randomBytes(8).toString('hex')}`; }

function reachProvenFor(binding, offender) { return reachProven.get(binding)?.has(offender) ?? false; }

function openWindow(win, st) {
  let m = windows.get(win.binding);
  if (!m) { m = new Map(); windows.set(win.binding, m); }
  const prior = m.get(win.toolUseId);
  if (prior) endWindow(win.binding, win.toolUseId, prior, st.now);
  m.set(win.toolUseId, { ...st, agentKey: win.agentKey ?? 'main', at: st.now, slots: [...st.slots] });
}

function endWindow(binding, toolUseId, w, now) {
  const m = windows.get(binding);
  if (m && m.get(toolUseId) === w) m.delete(toolUseId);
  if (m && m.size === 0) windows.delete(binding);
  if (w.claim && !claimSettled(w.claim)) settleClaim(w.claim, 'release', now); // nothing ran under it
  w.claim = null;
}

function reapWindows(binding, now) {
  const m = windows.get(binding);
  if (!m) return;
  for (const [id, w] of [...m]) if (now - w.at >= CLAIM_MAX_MS) endWindow(binding, id, w, now);
}

/**
 * The runtime calls this at EVERY PreToolUse of a session (any tool), before deciding.
 * An agent's next tool call means its previous non-read-only Bash call has ended
 * (Claude Code runs a write-classified Bash alone), so that agent's open windows end
 * here even if their Post event never arrived. Only ever fails closed.
 */
export function beginGitWriteToolCall({ binding, toolUseId = null, agentKey = 'main', now = Date.now() } = {}) {
  const m = binding ? windows.get(binding) : null;
  if (!m) return;
  for (const [id, w] of [...m]) if (id !== toolUseId && w.agentKey === (agentKey ?? 'main')) endWindow(binding, id, w, now);
}

/** End every window one (sub)agent of a session left open (SubagentStop). Idempotent. */
export function endGitWriteAgent(binding, agentKey, now = Date.now()) {
  const m = binding ? windows.get(binding) : null;
  if (!m) return;
  for (const [id, w] of [...m]) if (w.agentKey === agentKey) endWindow(binding, id, w, now);
}

/** End one tool call's window (Post / PostFailure / PermissionDenied / a deny). Idempotent. */
export function endGitWriteToolCall(binding, toolUseId, now = Date.now()) {
  const w = binding && toolUseId ? windows.get(binding)?.get(toolUseId) : null;
  if (w) endWindow(binding, toolUseId, w, now);
}

/** End every window of a session (turn end, session close). Idempotent. */
export function endGitWriteToolCalls(binding, now = Date.now()) {
  const m = binding ? windows.get(binding) : null;
  if (!m) return;
  for (const [id, w] of [...m]) endWindow(binding, id, w, now);
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
  reapWindows(binding, now);
  const m = windows.get(binding);
  let id = null, w = null;
  if (m) for (const [k, cand] of m) { if (cand.projectKey === projectKey && cand.slots.includes(offender)) { id = k; w = cand; break; } }
  if (!w) return independent();

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
  if (w.state === 'reserved') {
    const ok = settleClaim(w.claim, 'commit', now); // the ONE spend of this decision
    w.claim = null;
    if (!ok) { endWindow(binding, id, w, now); return independent(); } // lapsed: decide afresh
    w.state = 'committed';
  }
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

/** TEST-ONLY: drop every window and reach proof. */
export function _resetGitWriteWindowsForTest() {
  for (const [b] of [...windows]) endGitWriteToolCalls(b);
  windows.clear(); reachProven.clear();
}

/** TEST/DIAGNOSTIC: a snapshot of a session's open windows (no capabilities). */
export function _gitWriteWindowsOf(binding) {
  const m = binding ? windows.get(binding) : null;
  return m ? [...m].map(([toolUseId, w]) => ({ toolUseId, decision: w.decision, state: w.state, slots: [...w.slots], agentKey: w.agentKey })) : [];
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
