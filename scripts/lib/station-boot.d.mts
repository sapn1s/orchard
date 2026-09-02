/** Type declarations for station-boot.mjs (consumed by the .ts verify suites). */

export function isolatedStoreEnv(
  dir: string,
  opts?: { alsoReader?: boolean },
): { CLAUDE_CONFIG_DIR: string; CLAUDE_PROJECTS_DIR?: string };

export function sharedDataDir(env?: NodeJS.ProcessEnv): string;

export function assertIsolatedEnv(
  env: NodeJS.ProcessEnv,
  opts?: { requireStore?: boolean },
): NodeJS.ProcessEnv;

export function isolatedServerEnv(
  overrides: NodeJS.ProcessEnv,
  opts?: { requireStore?: boolean },
): NodeJS.ProcessEnv;
