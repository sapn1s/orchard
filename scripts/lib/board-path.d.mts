// FEAT-106 — hand-written types for the plain-ESM board-path resolver, matching
// the sidecar-.d.mts convention used for the other .mjs modules imported from TS.
export function resolveOrchardDir(hostPath: string): string;
export function resolveConfigFile(hostPath: string): string;
export function readOrchardConfig(hostPath: string): Record<string, unknown> | null;
export function resolveBoardDir(hostPath: string): string;
export function boardLayout(hostPath: string): 'declared' | 'orchard' | 'legacy' | 'none';
export function resolveLibDir(hostPath: string): string;
export function resolveConventionsFile(hostPath: string): string;
export function resolveDeployContextFile(hostPath: string): string;
export function resolveStopHookFile(hostPath: string): string;
