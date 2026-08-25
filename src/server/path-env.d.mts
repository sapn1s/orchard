/**
 * Type surface for the PATH-augmentation helper (BUG-091) so TS callers — the
 * server boot (src/server/index.ts) applies it to `process.env` once at startup
 * — can `import { augmentedPathEnv } from './path-env.mjs'` and still typecheck.
 * The implementation lives in path-env.mjs (kept as a .mjs so session-host.mjs,
 * itself a .mjs, can import it without a build step).
 */

/** The user's local tool dirs to prepend to PATH (`~/.local/bin`, and
 *  `~/.cargo/bin` only when it exists), derived from `homeDir`. */
export function userToolDirs(homeDir?: string): string[];

/**
 * Return a COPY of `baseEnv` whose PATH has the user's local tool dirs prepended
 * (de-duplicated against the inherited PATH and each other), keeping EVERY
 * existing PATH entry verbatim — including POSIX empty fields. Non-PATH vars pass
 * through unchanged; `baseEnv` is not mutated.
 */
export function augmentedPathEnv<T extends NodeJS.ProcessEnv | Record<string, string | undefined>>(
  baseEnv: T,
  homeDir?: string,
): T & { PATH: string };
