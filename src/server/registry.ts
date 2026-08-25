/**
 * JSON-backed project registry. Single-user, single-process assumption; writes
 * are atomic so a crash cannot leave a half-written registry.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataDir, registryFile, slugify, writeAtomic, ensureDir, scratchDir } from '../lib/paths.ts';
import type { Isolation } from './events.ts';
// BUG-144 — the single Working-Agreement mutation source (wiring.ts imports only
// TYPES + toolSettingsOf back from here, and both sides use their imports lazily
// inside function bodies, so this cycle resolves cleanly at call time).
import { coherentWaStack } from './wiring.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * FEAT-037 P3 — which model-execution engine a session runs on.
 * 'anthropic' = ClaudeRuntime (the default; absent in registries written
 * before this field existed, so read it through `providerOf()`).
 * 'openai' = CodexRuntime (the Codex CLI's app-server, subscription-billed).
 */
export type Provider = 'anthropic' | 'openai';

/** Resolved provider for a project — absent stored value = 'anthropic'. */
export function providerOf(project: Project): Provider {
  return project.settings.provider ?? 'anthropic';
}

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/** One entry in a project's ordered instruction stack. */
export interface InstructionRef {
  templateId: string;
  /** Overrides the template's default mode when set. */
  mode?: 'append' | 'replace';
  enabled: boolean;
}

/** Per-project container knobs. Only meaningful when isolation === 'container'. */
export interface ContainerSettings {
  /**
   * Override the image. Empty/null = Claude Station builds and manages its own
   * image (src/server/container/Dockerfile) pinned to the host uid/gid.
   */
  image: string | null;
  /**
   * Mount /var/run/docker.sock into the container. OFF by default and it must
   * stay an explicit opt-in: on a rootful daemon this is equivalent to handing
   * the container root on the host, which voids every other hardening flag.
   */
  dockerSocket: boolean;
  memoryMb: number;
  pidsLimit: number;
}

export function defaultContainerSettings(): ContainerSettings {
  return { image: null, dockerSocket: false, memoryMb: 8192, pidsLimit: 4096 };
}

/** Container settings with defaults filled in for registries written earlier. */
export function containerSettingsOf(project: Project): ContainerSettings {
  return { ...defaultContainerSettings(), ...(project.settings.container ?? {}) };
}

/**
 * Per-project stealth browser. Only meaningful when `enabled`; the browser
 * itself always runs on the HOST regardless of isolation (see browser.ts).
 */
export interface BrowserSettings {
  enabled: boolean;
  /** Idle shutdown for the daemon. Adapter default is 15 min when omitted. */
  idleMs?: number | null;
}

export function defaultBrowserSettings(): BrowserSettings {
  return { enabled: false, idleMs: null };
}

/** Browser settings with defaults filled in for registries written earlier. */
export function browserSettingsOf(project: Project): BrowserSettings {
  return { ...defaultBrowserSettings(), ...(project.settings.browser ?? {}) };
}

/**
 * Per-project attachable dev tools (FEAT-025). These are MCP servers Claude
 * Station hands a launched session, governed by the same attach seam the stealth
 * browser uses (see src/server/tools.ts `plannedMcpServers`). Each is a plain
 * per-project opt in/out that actually changes the `mcpServers` config the
 * session receives — not just a stored flag.
 *
 * `serena` defaults ON: it is the repo's dogfooded default (LSP-backed symbol
 * tools, see FEAT-025) and making it default-off would silently regress every
 * current session. `playwright` defaults OFF: it is a UI-testing tool most
 * projects do not need, opt-in per FEAT-034's tool-gating convention.
 */
export interface ToolSettings {
  /** Serena LSP MCP — symbol-level code tools. Repo default is ON. */
  serena: boolean;
  /** Playwright MCP — browser automation for UI-testing projects. Default OFF. */
  playwright: boolean;
  /** Host-brokered OpenAI dispatch. Credentials remain on the host. Default OFF. */
  openaiDispatch: boolean;
}

export function defaultToolSettings(): ToolSettings {
  return { serena: true, playwright: false, openaiDispatch: false };
}

/** Tool settings with defaults filled in for registries written earlier. */
export function toolSettingsOf(project: Project): ToolSettings {
  return { ...defaultToolSettings(), ...(project.settings.tools ?? {}) };
}

/**
 * Per-project reflink snapshots. See src/server/snapshots.ts for the mechanism.
 *
 * `enabled: null` means AUTO, and auto is not the same as off: it resolves to ON
 * for `isolation: 'container'` and OFF for everything else. Container sessions
 * bind-mount the real project directory, which is the gap this closes; `direct`
 * sessions are opt-in because the user is watching them. Read the resolved value
 * through `snapshotSettingsOf()` and never re-derive it in a caller.
 */
export interface SnapshotSettings {
  enabled: boolean | null;
  /** How many snapshots to retain per project, newest first. */
  keep: number;
  /**
   * Directory NAMES (not paths) skipped at any depth. These are the file-count
   * cost driver and are all recreatable from a lockfile or a build.
   * `.git` is rejected by the validator — it is the single thing most worth restoring.
   */
  exclude: string[];
}

export const DEFAULT_SNAPSHOT_EXCLUDE = [
  'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', '.cache',
];

export function defaultSnapshotSettings(): SnapshotSettings {
  return { enabled: null, keep: 10, exclude: [...DEFAULT_SNAPSHOT_EXCLUDE] };
}

/** Snapshot settings with defaults filled in AND `enabled: null` resolved. */
export function snapshotSettingsOf(project: Project): SnapshotSettings & { enabled: boolean; source: 'project' | 'auto-container' | 'auto-off' } {
  const merged = { ...defaultSnapshotSettings(), ...(project.settings.snapshots ?? {}) };
  if (typeof merged.enabled === 'boolean') return { ...merged, enabled: merged.enabled, source: 'project' };
  const auto = project.isolation === 'container';
  return { ...merged, enabled: auto, source: auto ? 'auto-container' : 'auto-off' };
}

/**
 * FEAT-083: the structured response digest (a leading ```orchard-digest fence
 * the transcript renderer lifts into a compact, importance-weighted list). This
 * is a CLIENT-side render feature; the only server surface is this opt-OUT flag.
 * Default ENABLED. A project sets `enabled: false` to suppress parsing entirely,
 * so the renderer falls back to plain prose. Read through `responseDigestOf()`.
 *
 * FEAT-084: `enabled` now ALSO gates INJECTION — a project with the digest on
 * gets the condensed `orchard-digest` instruction folded into every session's
 * system prompt (templates.ts#responseFormatSection, at the agent-bridge launch
 * site), so the format works by construction and not by the agent's memory.
 * `guidance` is an optional short per-project nudge (verbosity/detail/style/when
 * to emit) appended under a `## Project override` subhead inside that injected
 * section. It can only steer tone — it cannot change the fixed JSON schema, the
 * fence name, or the fail-closed fallback — and is validated (length-capped,
 * control-char-rejected) in validate.ts. Absent/undefined for old registries.
 */
export interface ResponseDigestSettings {
  enabled: boolean;
  guidance?: string | null;
}

export function defaultResponseDigestSettings(): ResponseDigestSettings {
  return { enabled: true };
}

/** Response-digest settings with defaults filled in for registries written earlier. */
export function responseDigestOf(project: Project): ResponseDigestSettings {
  return { ...defaultResponseDigestSettings(), ...(project.settings.responseDigest ?? {}) };
}

/**
 * BUG-144 — the current Working-Agreement method version. Bumping this is how a
 * future method change re-qualifies every project for a re-backfill (a row
 * stamped at an older version becomes a candidate again). Kept deliberately
 * simple: the coherent v1+v2 stack is version 1.
 */
export const CURRENT_METHOD_VERSION = 1;

/**
 * The recorded method version for a project. 0 = no decision recorded yet (the
 * row predates FEAT-089's auto-attach) — i.e. a backfill candidate. Any positive
 * value = the method decision was made at that version and must not be
 * re-touched by a backfill for that version (this is what keeps a deliberate
 * opt-out expressible; see ProjectSettings.methodVersion).
 */
export function methodVersionOf(p: Project): number {
  const v = p.settings?.methodVersion;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface ProjectSettings {
  /**
   * Optional in stored JSON (older registries have no key); read it through
   * `providerOf()`. Default 'anthropic' — zero behaviour change for existing
   * projects.
   */
  provider?: Provider;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  maxBudgetUsd: number | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  mounts: Mount[];
  instructions: InstructionRef[];
  /** Optional in stored JSON; read it through `containerSettingsOf()`. */
  container?: ContainerSettings;
  /** Optional in stored JSON; read it through `browserSettingsOf()`. */
  browser?: BrowserSettings;
  /** Optional in stored JSON; read it through `toolSettingsOf()`. */
  tools?: ToolSettings;
  /** Optional in stored JSON; read it through `snapshotSettingsOf()`. */
  snapshots?: SnapshotSettings;
  /** FEAT-083: optional in stored JSON; read it through `responseDigestOf()`. */
  responseDigest?: ResponseDigestSettings;
  /**
   * BUG-144 — the Working-Agreement method version whose DECISION has been
   * recorded for this project. Absent/0 (`methodVersionOf`) = the row predates
   * the FEAT-089 auto-attach and is a backfill candidate. A non-zero stamp means
   * the method decision has been made once — applied (WA in `instructions`) OR
   * deliberately declined (`applyMethod:false` → `instructions: []` AND stamped)
   * — so a backfill re-run skips it and can never silently override an opt-out.
   * Read it through `methodVersionOf()`.
   */
  methodVersion?: number;
}

/**
 * BUG-138 — WHAT IDENTIFIES THIS PROJECT, recorded per project while the
 * directory still exists.
 *
 * Sessions are indexed by the WORKING DIRECTORY (`~/.claude/projects/<encoded
 * cwd>/`), and the registry row's only link to them is `hostPath`. Rename the
 * directory and that link is a fact re-derived from an artifact that no longer
 * carries it: nothing left on disk says "this row and that history are the same
 * project".
 *
 * There is deliberately NO single identity rule here, because there isn't one:
 *  - a directory that is not a repo has nothing but its path;
 *  - a worktree, a fork or a second checkout SHARES a remote with another
 *    project, so a remote match there would repoint the wrong row;
 *  - a plain one-checkout repo has a remote that really is unique to it.
 * So identity is a per-project fact, declared once at the moment the row is
 * written, and corrected later if it was wrong — never re-derived at the moment
 * of need, when the evidence is exactly what has gone missing.
 *
 * `kind: 'path-only'` is a real, honest answer: such a project cannot be
 * followed automatically and must ask. Absent field = a row written before this
 * existed, treated as 'path-only' (see `identityOf`) — and unknowable in
 * retrospect once the directory is gone, which is precisely the gap this closes
 * going forward. Identity NEVER decides on its own; it only lets a candidate be
 * offered as a verified match instead of a guess.
 */
export interface ProjectIdentity {
  /** 'git-remote' = matchable. 'path-only' = the path is all there is. */
  kind: 'git-remote' | 'path-only';
  /** `git remote get-url origin` when kind is 'git-remote', else null. */
  remoteUrl: string | null;
  capturedAt: string;
  /** The path it was captured from — so a stale capture is legible. */
  capturedFrom: string;
}

/** Recorded identity, or the honest default for a row written before it existed. */
export function identityOf(p: Project): ProjectIdentity {
  const i = p.identity;
  if (i && (i.kind === 'git-remote' || i.kind === 'path-only')) return i;
  return { kind: 'path-only', remoteUrl: null, capturedAt: p.createdAt, capturedFrom: p.hostPath };
}

/**
 * Read a directory's identity NOW. Only ever called with a path that exists —
 * an absent directory cannot be interrogated, which is the whole problem.
 */
export function captureIdentity(hostPath: string): ProjectIdentity {
  const capturedAt = new Date().toISOString();
  let remoteUrl: string | null = null;
  try {
    if (fs.existsSync(path.join(hostPath, '.git'))) {
      const out = execFileSync('git', ['-C', hostPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      remoteUrl = out || null;
    }
  } catch {
    remoteUrl = null; // no repo, no origin, or git missing — 'path-only' is the truth then
  }
  return remoteUrl
    ? { kind: 'git-remote', remoteUrl, capturedAt, capturedFrom: hostPath }
    : { kind: 'path-only', remoteUrl: null, capturedAt, capturedFrom: hostPath };
}

export interface Project {
  id: string;
  name: string;
  hostPath: string;
  /**
   * BUG-138 — every hostPath this project has had before the current one,
   * newest first. NOT history for its own sake: `sessionsForProject` merges the
   * store dir of each, so repointing a renamed project carries its sessions
   * instead of stranding them under the old encoded cwd. Maintained by
   * `updateProject`; repointing BACK removes that path from the list again, so
   * the whole thing is reversible in both directions.
   */
  pastPaths?: string[];
  /** BUG-138 — see ProjectIdentity. Captured on add and on repoint only. */
  identity?: ProjectIdentity;
  isolation: Isolation;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

/** Previous hostPaths, newest first. Absent field = none. */
export function pastPathsOf(p: Project): string[] {
  return Array.isArray(p.pastPaths) ? p.pastPaths.filter((s) => typeof s === 'string' && s) : [];
}

/** True when the directory this project points at is not there any more. */
export function hostPathMissing(p: Project): boolean {
  try {
    return !fs.statSync(p.hostPath).isDirectory();
  } catch {
    return true;
  }
}

/** How many previous paths we keep. Enough for a few renames, not a log. */
const MAX_PAST_PATHS = 10;

interface RegistryFile {
  version: 1;
  projects: Project[];
}

const EMPTY: RegistryFile = { version: 1, projects: [] };

export function defaultSettings(): ProjectSettings {
  return {
    provider: 'anthropic',
    model: null,
    effort: null,
    maxBudgetUsd: null,
    // Least privilege by default: 'default' routes risky tools through canUseTool
    // so the UI can approve them. Widen per project deliberately.
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    mounts: [],
    instructions: [],
    container: defaultContainerSettings(),
    browser: defaultBrowserSettings(),
    tools: defaultToolSettings(),
    snapshots: defaultSnapshotSettings(),
    responseDigest: defaultResponseDigestSettings(),
  };
}

function load(): RegistryFile {
  const file = registryFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, projects: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fail loudly: silently starting from empty would look like data loss.
    throw new Error(`registry: ${file} is not valid JSON (${(err as Error).message}). Fix or move it aside.`);
  }
  const obj = parsed as Partial<RegistryFile>;
  if (!obj || !Array.isArray(obj.projects)) {
    throw new Error(`registry: ${file} has no "projects" array.`);
  }
  return { version: 1, projects: obj.projects as Project[] };
}

function save(reg: RegistryFile): void {
  ensureDir(dataDir());
  writeAtomic(registryFile(), `${JSON.stringify(reg, null, 2)}\n`);
}

export function listProjects(): Project[] {
  return load().projects.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(id: string): Project | null {
  return load().projects.find((p) => p.id === id) ?? null;
}

export interface CreateProjectInput {
  name?: string;
  hostPath: string;
  isolation?: Isolation;
  settings?: Partial<ProjectSettings>;
}

export function createProject(input: CreateProjectInput): Project {
  const hostPath = path.resolve(expandHome(input.hostPath));
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    throw new Error(`createProject: hostPath is not an existing directory: ${hostPath}`);
  }
  const name = (input.name ?? path.basename(hostPath)).trim() || path.basename(hostPath);
  const reg = load();
  const baseId = slugify(name);
  let id = baseId;
  let n = 2;
  while (reg.projects.some((p) => p.id === id)) id = `${baseId}-${n++}`;
  if (reg.projects.some((p) => p.hostPath === hostPath)) {
    throw new Error(`createProject: a project already points at ${hostPath}`);
  }
  const now = new Date().toISOString();
  const project: Project = {
    id,
    name,
    hostPath,
    // BUG-138 — declare what identifies this project while the directory is
    // right here to be asked. After it is renamed away, nobody can.
    identity: captureIdentity(hostPath),
    isolation: input.isolation ?? 'direct',
    settings: { ...defaultSettings(), ...(input.settings ?? {}) },
    createdAt: now,
    updatedAt: now,
  };
  reg.projects.push(project);
  save(reg);
  return project;
}

/**
 * FEAT-059 — the reserved id of the Orchard-owned scratch project. The
 * global "New session" button always lands here rather than binding a
 * throwaway question to whatever project happens to be selected.
 */
export const SCRATCH_PROJECT_ID = 'scratch';

export const SCRATCH_PROJECT_NAME = 'Scratch — throwaway';

/**
 * Get-or-create the scratch project, creating its directory on demand.
 *
 * Idempotent and cheap to call on every "start a scratch session" click:
 * a fresh install has NEITHER the directory NOR the registry row until this
 * runs for the first time (verified by verify-scratch.mjs). Once created,
 * scratch is a completely normal `Project` row — same settings shape, same
 * PATCH route, same everything — so provider/model/permissions/tools all
 * default the ordinary way and the user can change them the ordinary way.
 *
 * If `CLAUDE_STATION_SCRATCH_DIR` changes between runs, the existing row's
 * `hostPath` is kept in sync so the project never silently points at a
 * directory nobody is reading the env var for any more.
 */
export function ensureScratchProject(): Project {
  const hostPath = scratchDir();
  ensureDir(hostPath);
  const reg = load();
  const existing = reg.projects.find((p) => p.id === SCRATCH_PROJECT_ID);
  if (existing) {
    if (existing.hostPath === hostPath) return existing;
    return updateProject(SCRATCH_PROJECT_ID, { hostPath });
  }
  const now = new Date().toISOString();
  const project: Project = {
    id: SCRATCH_PROJECT_ID,
    name: SCRATCH_PROJECT_NAME,
    hostPath,
    isolation: 'direct',
    settings: defaultSettings(),
    createdAt: now,
    updatedAt: now,
  };
  // BUG-144 — scratch is a real launchable project, so it must launch with the
  // method like any other. defaultSettings() alone gives it `instructions: []`
  // (no Working Agreement); FEAT-089 only covers POST /api/projects, and scratch
  // is created here instead. Attach the SAME coherent stack through the SAME
  // single mutation source (coherentWaStack) and stamp the decision so a later
  // backfill sees it as already handled.
  project.settings.instructions = coherentWaStack(project);
  project.settings.methodVersion = CURRENT_METHOD_VERSION;
  reg.projects.push(project);
  save(reg);
  return project;
}

export function updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Project {
  const reg = load();
  const idx = reg.projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`updateProject: no project ${id}`);
  const cur = reg.projects[idx]!;
  // `container` merges one level deeper than the rest: a PATCH that sets only
  // `container.dockerSocket` must not silently drop the memory/pids limits.
  const settings = patch.settings
    ? {
        ...cur.settings,
        ...patch.settings,
        container: patch.settings.container
          ? { ...defaultContainerSettings(), ...(cur.settings.container ?? {}), ...patch.settings.container }
          : (cur.settings.container ?? defaultContainerSettings()),
        // Same one-level-deeper merge: toggling `browser.enabled` must not drop
        // a previously configured idleMs.
        browser: patch.settings.browser
          ? { ...defaultBrowserSettings(), ...(cur.settings.browser ?? {}), ...patch.settings.browser }
          : (cur.settings.browser ?? defaultBrowserSettings()),
        // Same one-level-deeper merge: flipping `tools.serena` must not drop a
        // previously-set `tools.playwright` (FEAT-025).
        tools: patch.settings.tools
          ? { ...defaultToolSettings(), ...(cur.settings.tools ?? {}), ...patch.settings.tools }
          : (cur.settings.tools ?? defaultToolSettings()),
        // Same one-level-deeper merge again: a PATCH that only flips
        // `snapshots.enabled` must not drop a customised `exclude` list.
        snapshots: patch.settings.snapshots
          ? { ...defaultSnapshotSettings(), ...(cur.settings.snapshots ?? {}), ...patch.settings.snapshots }
          : (cur.settings.snapshots ?? defaultSnapshotSettings()),
        // FEAT-083: a PATCH that flips the digest on/off merges over defaults.
        responseDigest: patch.settings.responseDigest
          ? { ...defaultResponseDigestSettings(), ...(cur.settings.responseDigest ?? {}), ...patch.settings.responseDigest }
          : (cur.settings.responseDigest ?? defaultResponseDigestSettings()),
      }
    : cur.settings;
  const next: Project = {
    ...cur,
    ...patch,
    settings,
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: new Date().toISOString(),
  };
  /*
   * BUG-138 — REPOINTING CARRIES THE SESSIONS.
   *
   * A project's sessions live under `~/.claude/projects/<encodeCwd(hostPath)>/`
   * and are grouped by the normalised BASENAME of that path. So moving a
   * directory keeps its history (same basename), and RENAMING it strands the
   * history under a key nothing points at any more. Writing the new path
   * without recording the old one is the silent-loss move: the files are still
   * on disk, and nothing can find them.
   *
   * So the old path is remembered here, and `sessionsForProject` merges its
   * store dir back in. Nothing on disk is moved or copied — which is what makes
   * it reversible: repoint BACK (or rename the directory back and repoint) and
   * the now-current path drops off the list, leaving exactly the state before.
   */
  if (patch.hostPath !== undefined && patch.hostPath !== cur.hostPath) {
    const seen = new Set<string>([next.hostPath]);
    const past: string[] = [];
    for (const q of [cur.hostPath, ...pastPathsOf(cur)]) {
      if (!q || seen.has(q)) continue;
      seen.add(q);
      past.push(q);
    }
    next.pastPaths = past.slice(0, MAX_PAST_PATHS);
    if (!next.pastPaths.length) delete next.pastPaths;
    // Re-declare identity from the directory we were just pointed at. A repoint
    // is a user-initiated write of this row, so this is not a silent capture.
    next.identity = captureIdentity(next.hostPath);
  }
  reg.projects[idx] = next;
  save(reg);
  return next;
}

export function deleteProject(id: string): boolean {
  const reg = load();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.id !== id);
  if (reg.projects.length === before) return false;
  save(reg);
  return true;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface Suggestion {
  name: string;
  hostPath: string;
  suggestedId: string;
  alreadyRegistered: boolean;
  hasGit: boolean;
  lastModified: string | null;
}

/** Scan the user's usual project roots and suggest registrations. */
export function scanForProjects(roots?: string[]): Suggestion[] {
  const home = os.homedir();
  const searchRoots = roots ?? [path.join(home, 'projects'), path.join(home, 'random_projects')];
  const existing = new Set(listProjects().map((p) => p.hostPath));
  const out: Suggestion[] = [];
  for (const root of searchRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root absent — not an error
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const hostPath = path.join(root, e.name);
      let mtime: string | null = null;
      try {
        mtime = fs.statSync(hostPath).mtime.toISOString();
      } catch {
        continue;
      }
      out.push({
        name: e.name,
        hostPath,
        suggestedId: slugify(e.name),
        alreadyRegistered: existing.has(hostPath),
        hasGit: fs.existsSync(path.join(hostPath, '.git')),
        lastModified: mtime,
      });
    }
  }
  out.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
  return out;
}

/* ------------------------------------------------- BUG-138: follow a rename */

/**
 * Compare two git remotes for "same repository" without pretending to be a URL
 * parser: drop the scheme, the credentials, the scp-style colon, a trailing
 * slash and `.git`, and lowercase. `git@github.com:me/x.git` and
 * `https://github.com/Me/x` are the same repo; anything genuinely different
 * stays different.
 */
export function sameRemote(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string) =>
    u.trim()
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(':', '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

export interface RepointCandidate {
  name: string;
  hostPath: string;
  /** The candidate's own origin remote, so a HUMAN can recognise it at a glance. */
  remoteUrl: string | null;
  lastModified: string | null;
  /**
   * 'match'      — the project's RECORDED identity matches this directory.
   * 'unverified' — a directory that is merely nearby. Never auto-applied.
   */
  confidence: 'match' | 'unverified';
}

export interface RepointOffer {
  hostPath: string;
  missing: boolean;
  identity: ProjectIdentity;
  /** Why we cannot decide, when we cannot. Null when `unambiguous` is true. */
  cannotDecide: string | null;
  /** Exactly one recorded-identity match, and nothing else claims that identity. */
  unambiguous: boolean;
  candidates: RepointCandidate[];
}

/**
 * Offer directories this project might have been renamed to — and be explicit
 * about how much that offer is worth.
 *
 * The conservative rule, which this function exists to enforce in one place:
 * a candidate is a `match` ONLY against the project's own recorded identity
 * (`identity.kind === 'git-remote'`). Name resemblance is never a match — a
 * wrong repoint points a project at somebody else's work, and "the directory
 * next door looks a lot like the one that vanished" is the reasoning that does
 * it. A
 * project whose identity is 'path-only', or whose remote is shared with another
 * registered row (a worktree, a fork, a second checkout), reports why it cannot
 * decide and offers the list for a human to pick from. Nothing here writes.
 */
export function repointCandidates(p: Project, roots?: string[]): RepointOffer {
  const identity = identityOf(p);
  const home = os.homedir();
  const all = listProjects();
  const takenByOthers = new Set(all.filter((q) => q.id !== p.id).map((q) => q.hostPath));

  const searchRoots = Array.from(new Set(
    roots ?? [
      path.dirname(p.hostPath),
      ...pastPathsOf(p).map((q) => path.dirname(q)),
      path.join(home, 'projects'),
      path.join(home, 'random_projects'),
    ],
  ));

  const candidates: RepointCandidate[] = [];
  let gitCalls = 0;
  for (const root of searchRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root absent — not an error, the project's own parent may be gone too
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const hostPath = path.join(root, e.name);
      if (hostPath === p.hostPath || takenByOthers.has(hostPath)) continue;
      if (candidates.some((c) => c.hostPath === hostPath)) continue;
      let mtime: string | null = null;
      try {
        mtime = fs.statSync(hostPath).mtime.toISOString();
      } catch {
        continue;
      }
      let remoteUrl: string | null = null;
      if (gitCalls < 200 && fs.existsSync(path.join(hostPath, '.git'))) {
        gitCalls++;
        remoteUrl = captureIdentity(hostPath).remoteUrl;
      }
      candidates.push({
        name: e.name,
        hostPath,
        remoteUrl,
        lastModified: mtime,
        confidence:
          identity.kind === 'git-remote' && sameRemote(remoteUrl, identity.remoteUrl) ? 'match' : 'unverified',
      });
    }
  }

  const matches = candidates.filter((c) => c.confidence === 'match');
  /*
   * A remote shared with ANOTHER registered project is the ambiguous case the
   * per-project framing exists for: worktrees, forks and second checkouts all
   * look identical from the remote alone, so a match there is not evidence
   * about which row moved.
   */
  const sharedWith = all.filter((q) => q.id !== p.id && sameRemote(identityOf(q).remoteUrl, identity.remoteUrl));
  let cannotDecide: string | null = null;
  if (identity.kind !== 'git-remote') {
    cannotDecide =
      'this project has no recorded identity beyond its path' +
      (p.identity ? '' : ' (it was added before Orchard recorded one)') +
      ' — its directory is gone, so there is nothing left to match against. Pick the new directory yourself.';
  } else if (!matches.length) {
    cannotDecide = `no directory found whose git origin is ${identity.remoteUrl}. Pick the new directory yourself, or the repo may not be checked out here any more.`;
  } else if (matches.length > 1) {
    cannotDecide = `${matches.length} directories share this project's git origin (${identity.remoteUrl}) — a remote alone cannot say which one this row is. Pick one.`;
  } else if (sharedWith.length) {
    cannotDecide = `another registered project (${sharedWith.map((q) => q.name).join(', ')}) has the same git origin, so a remote match is not proof this row is the one that moved. Confirm the directory yourself.`;
  }

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'match' ? -1 : 1;
    return (b.lastModified ?? '').localeCompare(a.lastModified ?? '');
  });

  return {
    hostPath: p.hostPath,
    missing: hostPathMissing(p),
    identity,
    cannotDecide,
    unambiguous: cannotDecide === null,
    candidates: candidates.slice(0, 40),
  };
}
