// Types for the parts of release.mjs the server imports (2026-10-13 defaults lane).
export interface VerdictSource { ok: boolean; code: 'no-board' | 'no-typed-verdicts' | null; typed: number; boardDir: string | null; reason: string | null }
export declare function boardVerdictSource(top: string): Promise<VerdictSource>;
export declare const NEVER_RELEASES_PREFIX: string;
export declare const RELEASE_TRAILER: string;
