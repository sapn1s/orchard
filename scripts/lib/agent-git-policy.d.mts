export type AgentGitMode = 'none' | 'scoped' | 'release';
export interface ReleaseCadence { opt_in: boolean; minTickets: number; maxWaitHours: number; minIntervalHours: number; checks: string[] | null; tagPrefix: string }
/** FEAT-190 — a per-repo cross-repo opt-out on a grant, keyed by the target repo's common-dir. */
export interface RepoOverride { disabled?: boolean; commit?: boolean; push?: boolean; remotes?: string[]; label?: string; firstReachedAt?: string }
export interface AgentGitPolicy {
  mode: AgentGitMode;
  commit: boolean;
  push: boolean;
  scope: string | null;
  release: ReleaseCadence;
  repoOverrides: Record<string, RepoOverride>;
  grantedAt: string | null;
  grantedVia: string | null;
  legacy: boolean;
}
export interface GitWriteSettingInput {
  commit: boolean;
  push: boolean;
  scope: string | null;
  release?: Partial<Omit<ReleaseCadence, 'checks'>> & { checks?: string[]; opt_in?: boolean };
  repoOverrides?: Record<string, RepoOverride>;
}
export declare function normalizeRepoOverrides(raw: unknown): Record<string, RepoOverride>;
export declare function repoOverrideKey(target: { commonDir?: string | null } | null): string | null;
export interface WriteTarget { cwd?: string | null; commonDir?: string | null; gitDir?: string | null; toplevel?: string | null; worktree?: string | null; creating?: boolean; verb?: string | null; push?: { urls: string[] } }
export declare const DEFAULT_RELEASE: Readonly<{ minTickets: number; maxWaitHours: number; minIntervalHours: number; tagPrefix: string }>;
export declare const SCOPE_MAX: number;
export declare const MIGRATED_SCOPE_NOTE: string;
export declare const CHECKS_MAX: number;
export declare const NEVER_RELEASES_PREFIX: string;
export declare const PUSH_VERBS: Set<string>;
export declare function normalizeRelease(raw: unknown): ReleaseCadence;
export declare function normalizeGitWrite(raw: unknown): AgentGitPolicy;
export declare function validatePolicyInput(body: unknown): { value?: GitWriteSettingInput; error?: string };
export declare function releaseModeRefusalText(verb: string): string;
/** FEAT-190 r10 — the ONE-resolved-repo invariant for a gated publish write: refuse a bare target
 * (no scannable work tree) or a git-dir≠work-tree redirect (any channel). Returns a refusal string
 * or null. `commonDirOf` is injectable for tests. */
export declare function bareTargetRefusalText(verb: string): string;
export declare function redirectedTargetRefusalText(verb: string): string;
export declare function resolvedRepoRefusal(target: { commonDir?: string | null; toplevel?: string | null; verb?: string }, opts?: { commonDirOf?: (p: string) => string | null }): string | null;
/** FEAT-190 r5 — THE one derivation relating commit→push for a single resolved grant holder.
 * `reason` names why push is narrower than commit (or commit itself refused), or null. */
export type GitPermReason = 'repo-disabled' | 'release-mode' | 'no-grant' | 'repo-commit-off' | 'repo-push-off' | 'push-toggle-off' | 'dest-repo-disabled' | 'dest-repo-push-off' | 'scratch' | null;
export declare function effectiveGitPermission(opts: { policy: AgentGitPolicy | null; live?: boolean; override?: RepoOverride | null; dstOverride?: RepoOverride | null; verb?: string; releasePush?: boolean; scratch?: boolean }): { commit: boolean; push: boolean; reason: GitPermReason };
export declare function gitCommonDirOf(dir: string, opts?: { git?: string; now?: number }): string | null;
export declare function _clearCommonDirCache(): void;
export declare function verbOfArgv(argv: string[]): string;
export declare function agentGitPolicyNote(policy: AgentGitPolicy | null, opts?: { orchardDir?: string; projectId?: string }): string | null;
export declare function policySummary(policy: AgentGitPolicy | null): string;
export interface RegisteredRepoDesc { commonDir: string | null; localRemotes: string[]; networkRemotes: string[]; tree: string | null }
export interface TargetProject extends RegisteredRepoDesc { id: string; name?: string; policy: AgentGitPolicy; timedGrantLive: boolean; /** FEAT-164: the repo identity the project's live grant was given for (absent/null = covers nothing). */ binding?: { toplevel?: string | null; commonDir?: string | null } | null }
export declare function describeRegisteredRepo(hostPath: string, opts?: { git?: string; now?: number }): RegisteredRepoDesc;
export declare function ownersOfDir(dir: string, projects: TargetProject[]): TargetProject[];
/** FEAT-190 r7 — THE per-(session, repo) grant resolution; both decideByTarget and decidePush
 * feed its result into effectiveGitPermission ONCE. The session's own grant authorises; other
 * owners contribute deny-only opt-outs. */
export declare function governingGrant(opts: { session: TargetProject | null; repo: { commonDir?: string | null; toplevel?: string | null } | null; projects?: TargetProject[] }): { policy: AgentGitPolicy; live: boolean; override: RepoOverride | null; ownsRepo: boolean };
export declare function decideByTarget(opts: { argv: string[]; target: unknown; sessionProjectId: string; projects: TargetProject[]; commonDirOf?: ((p: string) => string | null) | null; fixtureRoots?: string[] }): { refusal: string | null; key: string; gateRepo?: string | null };
/** THE push authority (FEAT-164; FEAT-190 r8): source grant + destination opt-out veto. A push goes
 * to whatever remote the repo has (no frozen-remote veto); the leak gate still runs. */
export declare function decidePush(opts: { source: { commonDir?: string | null; cwd?: string | null; toplevel?: string | null }; url: string; projects: TargetProject[]; sessionProjectId: string; verb?: string; fixtureRoots?: string[]; release?: boolean }): { refusal: string | null; key: string; gateRepo: string | null };
export declare function defaultFixtureRoots(): string[];
export declare function hostGitBuiltins(git?: string): Set<string> | null;
