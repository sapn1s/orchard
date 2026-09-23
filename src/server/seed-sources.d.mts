// BUG-182 — hand-written types for the plain-ESM seed-source declaration,
// matching the sidecar-.d.mts convention used for scripts/lib/board-path.mjs.
export const SEED_SOURCE_PATHS: Readonly<Record<string, string>>;
export const READ_THROUGH_SEED_IDS: readonly string[];
export function seedSourceRelPath(id: string): string;
export function seedSourceRelPaths(): string[];
