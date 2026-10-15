export interface RepoIdentity { toplevel: string; commonDir: string | null }
export function repoIdentityOf(dir: string | null | undefined, opts?: { git?: string }): RepoIdentity | null;
export function sameRepoIdentity(a: unknown, b: unknown): boolean;
export function bindingHolds(bound: unknown, hostPath: string | null | undefined, opts?: { git?: string }): boolean;
export function sameRepository(a: unknown, b: unknown): boolean;
export function grantCoversTarget(bound: unknown, target: string | { toplevel?: string | null; commonDir?: string | null } | null | undefined, opts?: { git?: string }): boolean;
export interface GrantBinding extends RepoIdentity { remotes: RepoIdentity[]; networkKeys: string[] }
export function resolvedRemotesOf(dir: string, opts?: { git?: string }): { network: string[]; local: Array<RepoIdentity & { path: string }> };
export function grantCoversNetworkPush(bound: unknown, key: string | null | undefined): boolean;
export function grantBindingOf(dir: string | null | undefined, opts?: { git?: string }): GrantBinding | null;
export function grantCoversPush(bound: unknown, target: string | { toplevel?: string | null; commonDir?: string | null } | null | undefined, opts?: { git?: string }): boolean;
