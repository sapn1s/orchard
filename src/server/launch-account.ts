/**
 * BUG-255 r4 — THE ONE AUTHORITY for "which Claude account does a launch use".
 *
 * Before this module the answer was decided in several places: a client per-launch
 * override (`overrides.claudeAccount`) fed into the AgentSession constructor's
 * override loop; the FEAT-160 binding block in that constructor (which won only
 * for BOUND sessions); `containerAccountId` for a container's credential bind;
 * and `nextResumeAccountOf` for the indicator. The indicator read only one of
 * them, so an UNBOUND resume carrying a client override, or a session bound under
 * `direct` whose project became `container`, launched on an account the indicator
 * did not show (independent verify r3, run e43dd24e).
 *
 * THE RULE (one function, every caller):
 *   - a CONTAINER project            -> the project account. The credential is a
 *     container bind shared by every session on the project, so a per-session
 *     binding cannot apply (FEAT-145); a dormant binding from a `direct` past is
 *     ignored, and applies again only if the project returns to `direct`.
 *   - a session id with a binding    -> the binding (FEAT-160, server-owned).
 *   - a NEW session (no id yet) with an initial binding (the user's pick at
 *     creation)                       -> that pick. It is persisted as the
 *     session's binding at `system:init`, when its id first exists.
 *   - otherwise                      -> the project account (machine default
 *     under the project setting, `applyGlobalDefaults`).
 *
 * Every spawn (the AgentSession constructor), the container credential bind
 * (`containerAccountId`) and the declared indicator fact (index.ts
 * `accountFactOf`) call this. Nothing else may decide an account: `startSession`
 * refuses a caller that hands a spawn its own `overrides.claudeAccount`.
 *
 * `null` = the implicit default account (`~/.claude`); a string = a minted id.
 */
import { applyGlobalDefaults } from './global-settings.ts';
import { getSessionAccount, type BoundAccount } from './session-accounts.ts';
import type { Project } from './registry.ts';

/** What a launch is FOR: an existing session id (a resume, a fork's parent, an adopted CLI), or a new
 *  session with no id yet and, optionally, the user's pick as its initial binding. */
export interface LaunchAccountSubject {
  sessionId: string | null;
  /** Only read when `sessionId` is null (a brand-new session). */
  initialBinding?: { account: BoundAccount };
}

/** The project's own account: the machine default under the project setting. */
export function projectLaunchAccount(project: Pick<Project, 'settings'>): BoundAccount {
  const s = (project.settings ?? {}) as Partial<Project['settings']>;
  return applyGlobalDefaults({ model: null, effort: null, claudeAccount: s.claudeAccount ?? null }).claudeAccount ?? null;
}

/** THE decision. See the module comment. */
export function effectiveLaunchAccount(subject: LaunchAccountSubject, project: Pick<Project, 'settings' | 'isolation'>): BoundAccount {
  if (project.isolation === 'container') return projectLaunchAccount(project);
  if (subject.sessionId) {
    const bound = getSessionAccount(subject.sessionId);
    if (bound !== undefined) return bound.account;
  } else if (subject.initialBinding) {
    return subject.initialBinding.account;
  }
  return projectLaunchAccount(project);
}

/**
 * Take the client's account pick OFF a raw start/enqueue overrides object. A pick is
 * never a per-launch override any more: for an EXISTING session (a resume, a fork, an
 * outbox row) it is discarded unread — the session's account is its binding or its
 * project's, and a pick on it goes through the server's switch/rebind — and for a NEW
 * session it is returned separately, to become that session's initial binding. Run
 * BEFORE validation, so a stale or deleted id on an existing session can never strand
 * its resume; the caller validates a new session's pick itself (existence + the
 * container refusal, `validateSessionOverrides`).
 */
export function takeAccountPick(
  raw: unknown,
  opts: { newSession: boolean },
): { rest: unknown; pick: { value: unknown } | undefined } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rest: raw ?? undefined, pick: undefined };
  const o = raw as Record<string, unknown>;
  if (!('claudeAccount' in o)) return { rest: Object.keys(o).length ? o : undefined, pick: undefined };
  const { claudeAccount, ...rest } = o;
  return {
    rest: Object.keys(rest).length ? rest : undefined,
    pick: opts.newSession ? { value: claudeAccount } : undefined,
  };
}
