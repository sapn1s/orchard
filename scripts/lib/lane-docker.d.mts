/**
 * Types for lane-docker.mjs (BUG-223), so `src/server/**` imports the SAME module
 * suites and the sandbox CLI use. Keep in step with lane-docker.mjs's exports;
 * `npm run typecheck` catches a consumer that drifts, and
 * scripts/verify-bug-223-lane-docker.mjs asserts the behaviour behind these names.
 */
export declare const OPTOUT_ENV: 'ORCHARD_DOCKER_HOST_OPTOUT';
export declare const LANE_MARK_ENV: 'ORCHARD_LANE_DOCKER';
export declare const SANDBOX_MARKER: string;

export type LaneDockerDecision = 'sandbox' | 'host-optout' | 'not-applicable';
export interface LaneDockerEnv {
  decision: LaneDockerDecision;
  /** true when the decision was read from an inherited ORCHARD_LANE_DOCKER, not derived here. */
  inherited: boolean;
  env: Record<string, string>;
  reason: string;
}

export type LaneDockerSetting = 'sandbox' | 'host';
export declare const LANE_DOCKER_VALUES: readonly LaneDockerSetting[];
/** Registration-time classification ONLY (never at spawn): the initial declared value. */
export declare function classifyLaneDocker(projectPath: string | null | undefined, opts?: { checkouts?: string[] }): { value: LaneDockerSetting; reason: string };
export declare function isSandboxedProject(projectPath: string | null | undefined, opts?: { checkouts?: string[] }): boolean;
/** The project's declared settings.laneDocker in the registry, by hostPath. value null = undeclared. */
export declare function declaredLaneDocker(projectPath: string | null | undefined, opts?: { file?: string }): { value: LaneDockerSetting | null; projectId: string | null; why: string };
/** Round 6: the declaration of one registry row the caller re-read BY ID (null = not registered). */
export declare function declarationOfRow(row: unknown): { value: LaneDockerSetting | null; projectId: string | null; why: string };
export declare function laneDockerEnv(opts: {
  projectPath: string | null | undefined;
  baseEnv?: Record<string, string | undefined>;
  /** Accepted for call-site compatibility; ignored (the declared setting decides). */
  checkouts?: string[];
  /** Registry file to read (default: this process's registryFile()). */
  registry?: string;
  /** Round 6: the project's registry row, re-read BY ID; when present (even null) it decides, not projectPath. */
  project?: unknown;
}): LaneDockerEnv;
export declare const FAIL_CLOSED_DOCKER_HOST: string;
export type LaneDockerDeclaration =
  | { kind: 'sandbox'; raw: string; dockerHost: string }
  | { kind: 'invalid'; raw: string; why: string; dockerHost: string }
  | { kind: 'host'; raw: string }
  | { kind: 'host-optout'; raw: string; reason: string };
/** The inherited declaration (ORCHARD_LANE_DOCKER), or null when nothing is declared (top level). */
export declare function inheritedLaneDocker(env?: Record<string, string | undefined>): LaneDockerDeclaration | null;
/** Apply the inherited declaration to `env` (default: this process; also run at module load). */
export declare function applyInheritedLaneDocker(env?: Record<string, string | undefined>): LaneDockerDeclaration | null;
export declare function adoptedDockerMismatch(pid: number | null | undefined, want: Record<string, string> | null | undefined): string | null;
export declare function useHostDocker(
  reason: string,
  opts?: { who?: string; env?: Record<string, string | undefined> },
): Record<string, string | undefined>;
export declare function hostEnvShell(reason: string, who?: string): string;
export declare function sandboxAnswers(env?: Record<string, string | undefined>): Promise<boolean>;
export declare function sandboxAnswersSync(env?: Record<string, string | undefined>): boolean;
export declare const SANDBOX_DOWN_MESSAGE: string;
export declare function requireSandboxUp(env?: Record<string, string | undefined>): Promise<void>;
