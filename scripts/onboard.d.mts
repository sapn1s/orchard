/**
 * Type surface for the onboard core (FEAT-038) so the TS server route can
 * `import { onboard } from '../../scripts/onboard.mjs'` and still typecheck.
 * The implementation lives in onboard.mjs (kept as an executable .mjs so
 * `node scripts/onboard.mjs <dir>` still works unchanged).
 */
export interface OnboardReport {
  /** Path (relative to cwd) of the artifact this line is about. */
  path: string;
  /** Human label, e.g. `docs/bugs/README.md` or `package.json scripts`. */
  label: string;
  /** `created` | `added [...]` | `exists ...` | `SKIPPED ...` | `re-synced ...` */
  status: string;
}

export interface OnboardOptions {
  /** Skip the docs/bugs board scaffold (for a scratch dir that wants no board). */
  noBoard?: boolean;
  /** Re-sync the copied board.mjs even if it already exists (and diverged). */
  forceBoardTool?: boolean;
  /**
   * BUG-118: re-sync the copied response-format Stop hook even if it already
   * exists. Scoped to that ONE file — it is the only method file no target repo
   * could plausibly own itself — so a project onboarded before a hook fix can
   * receive it without any of its own code being overwritten.
   */
  forceHook?: boolean;
  /**
   * Append a short, delimited WA-pointer section to a PRE-EXISTING CLAUDE.md
   * (never touches a fresh onboard-authored one, which already has the
   * pointer). No-op without this flag; idempotent with it.
   */
  waPointer?: boolean;
  /**
   * Scaffold a docs/DEPLOY-CONTEXT.md stub (FEAT-050) — the per-project
   * "what prod actually looks like" doc the commit gatekeeper injects into
   * its reviewers. Opt-in; idempotent (an existing file is never touched).
   */
  deployContext?: boolean;
}

/** Idempotently onboard `targetDir` to Orchard. Throws only on a bad dir / I/O. */
export function onboard(targetDir: string, opts?: OnboardOptions): OnboardReport[];
