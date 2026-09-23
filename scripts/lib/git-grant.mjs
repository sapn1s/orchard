/**
 * git-grant.mjs — FEAT-108 round 2. The runtime decision that folds a per-project
 * grant AND the mandatory leak gate onto the round-1 git-write classifier.
 *
 * ORDER OF DECISIONS (one answer per Bash call):
 *   1. decideGitWrite(command) — the round-1 classifier. If it ALLOWS (a read, or
 *      the launch-time env hatch is open), we are done: allow.
 *   2. It is a git WRITE and the block is on. Is there an active grant for this
 *      project? No grant → deny, exactly as round 1 did.
 *   3. A grant is active. If the write PUBLISHES (commit/push — the events that
 *      put content into history or onto a remote, i.e. the BUG-155 exposure),
 *      run the leak gate. Gate FAILS → deny (the grant never lifts the gate).
 *   4. Permitted: consume a single-use grant and RECORD the write for the
 *      after-the-fact view.
 *
 * The gate is INJECTED (`runLeakGate`) so this stays pure and unit-testable; the
 * runtime passes a real subprocess runner (scripts/leak-gate.mjs over the repo).
 * When no runner is available for a publishing write, we FAIL CLOSED — an
 * unverifiable commit is treated as a failed gate, never waved through.
 */
import { decideGitWrite, gitWriteRefusal, gitWriteGateFailedRefusal, offenderForGit, gitWriteBlockEnabled } from './git-write-policy.mjs';
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

  const grant = projectKey ? peekGrant(projectKey, now) : null;
  if (!grant) return { allow: false, offender, reason: gitWriteRefusal(offender) };

  if (PUBLISHING_SUBCOMMANDS.has(sub)) {
    const gate = runLeakGate ? safeGate(runLeakGate) : { ok: false, detail: 'no leak-gate runner available — failing closed' };
    if (!gate.ok) {
      const rec = recordGitWrite({ projectKey, offender, command, sessionLabel, grantScope: grant.scope, gatePassed: false, now });
      return { allow: false, offender, gateFailed: true, reason: gitWriteGateFailedRefusal(offender, gate.detail), record: rec };
    }
  }

  consumeGrant(projectKey, now);
  const rec = recordGitWrite({
    projectKey, offender, command, sessionLabel, grantScope: grant.scope,
    gatePassed: PUBLISHING_SUBCOMMANDS.has(sub) ? true : null, now,
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
