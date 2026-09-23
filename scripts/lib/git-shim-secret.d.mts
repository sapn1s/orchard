/**
 * Types for git-shim-secret.mjs (BUG-173 round 3). Same sidecar-.d.mts convention
 * as git-shim.d.mts — src/server/** imports the SAME module the runtime uses.
 */

/** The host-process shim secret, minted lazily on first use. Memory-only. */
export declare function getShimSecret(): string;

/** TRUE only for a non-empty string equal to the current host secret. */
export declare function isShimSecretValid(candidate: unknown): boolean;

/** TEST-ONLY: pin or clear the secret. */
export declare function _setShimSecretForTest(v?: string | null): void;
