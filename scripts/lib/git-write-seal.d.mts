/** The registry row a seal is bound to (id + hostPath); a bare id binds an empty hostPath. */
export type SealBinding = string | { id: string; hostPath?: string | null };
export function sealKeyPath(dataDir: string): string;
export function readSealKey(dataDir: string): Buffer | null;
export function ensureSealKey(dataDir: string): { key: Buffer; created: boolean };
export function sealGitWrite<T extends Record<string, unknown>>(key: Buffer, project: SealBinding, value: T): T & { seal: string };
export function verifiedGitWrite<T>(dataDir: string, project: SealBinding, raw: T): T | null;
export function sealLegacyOnKeyCreation(dataDir: string, projects: Array<{ id: string; hostPath?: string; settings?: { gitWrite?: unknown } }>): string[];
