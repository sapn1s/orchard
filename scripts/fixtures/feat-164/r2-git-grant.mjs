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
 *   4. Permitted: consume a single-use grant and RECORD the write for the
 *      after-the-fact view.
 *
 * The gate is INJECTED (`runLeakGate`) so this stays pure and unit-testable; the
 * runtime passes a real subprocess runner (scripts/leak-gate.mjs over the repo).
 * When no runner is available for a publishing write, we FAIL CLOSED — an
 * unverifiable commit is treated as a failed gate, never waved through.
 */
import { decideGitWrite, gitWriteRefusal, gitWriteGateFailedRefusal, offenderForGit, gitWriteBlockEnabled, collectGitWrites, GATE_EXEMPT_WRITES } from './git-write-policy.mjs';
import { peekGrant, consumeGrant, recordGitWrite } from './git-grant-store.mjs';

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

  const grant = projectKey ? peekGrant(projectKey, now) : null;
  if (!grant) return { allow: false, offender, reason: gitWriteRefusal(offender) };

  if (needsGate) {
    const gate = runLeakGate ? safeGate(runLeakGate) : { ok: false, detail: 'no leak-gate runner available — failing closed' };
    if (!gate.ok) {
      // Refused at decide — this write never runs. Record it as blocked, not as a
      // permit a later reader could mistake for a landed commit (BUG-184).
      const rec = recordGitWrite({ projectKey, offender, command, sessionLabel, grantScope: grant.scope, gatePassed: false, outcome: 'blocked-gate', now });
      return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec };
    }
  }

  consumeGrant(grant, now); // FEAT-164 r2: spend the grant THIS decision read, nothing re-read
  // BUG-184 — record the DECISION as 'permitted', NOT as executed. The host cannot
  // observe whether the caller then runs git (over the shim path the exec lives in
  // another process that may abort or fail). The executor confirms the real outcome
  // via `confirmGitWrite`; until then the record honestly reads "authorised, not
  // yet observed to have run", so the audit can never claim a commit HEAD lacks.
  const rec = recordGitWrite({
    projectKey, offender, command, sessionLabel, grantScope: grant.scope,
    gatePassed: needsGate ? true : null, outcome: 'permitted', now,
  });
  return { allow: true, granted: true, offender, grant, record: rec };
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
