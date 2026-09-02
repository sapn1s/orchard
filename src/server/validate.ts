/**
 * The ONE validation dialect for project settings.
 *
 * `validateProjectPatch` backs the registry's PATCH/PUT route. `validateSessionOverrides`
 * backs the `start` command's per-session overrides and deliberately runs the *same*
 * code path — it narrows the accepted key set, then hands the body to
 * validateProjectPatch and returns the settings it produced. There is no second
 * type-checking implementation to drift out of sync.
 */
import * as cm from './container-manager.ts';
import type * as reg from './registry.ts';

const ISOLATIONS = new Set(['direct', 'container', 'sandbox']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const PROVIDERS = new Set(['anthropic', 'openai']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** DNS-label rule for a service's network hostname (RFC-1123-ish, lowercased). */
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
/**
 * Names that would collide with the network's own plumbing or with the session
 * container's reachability, so a service must not claim them.
 */
const RESERVED_SERVICE_NAMES = new Set(['localhost', 'host', 'gateway', 'session', 'workspace']);

/**
 * FEAT-112 — validate a declared service array. Exported so the agent-propose
 * route (services-request) rejects a bad proposal with the SAME dialect the
 * settings PATCH uses, rather than a second implementation that could drift.
 * Throws on the first problem with a message the UI/agent can read.
 */
export function validateServices(raw: unknown): reg.ServiceSpec[] {
  if (!Array.isArray(raw)) throw new Error('services must be an array');
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const r = item as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`services[${i}] must be an object`);
    for (const k of Object.keys(r)) {
      if (!['name', 'image', 'env', 'dataPath'].includes(k)) throw new Error(`services[${i}]: unknown field "${k}"`);
    }
    if (typeof r.name !== 'string' || !SERVICE_NAME_RE.test(r.name)) {
      throw new Error(`services[${i}].name must be a DNS label [a-z][a-z0-9-]{0,30} (got ${JSON.stringify(r.name)})`);
    }
    if (RESERVED_SERVICE_NAMES.has(r.name)) throw new Error(`services[${i}].name "${r.name}" is reserved`);
    if (seen.has(r.name)) throw new Error(`services[${i}].name "${r.name}" is declared twice`);
    seen.add(r.name);
    if (typeof r.image !== 'string' || !r.image.trim()) throw new Error(`services[${i}].image must be a non-empty string`);
    // Keep the image reference to a sane shape; docker will reject a truly bad one
    // at pull time with a specific message, but a control char here is never valid.
    if (/\s/.test(r.image)) throw new Error(`services[${i}].image must not contain whitespace`);
    let env: reg.ServiceEnvVar[] = [];
    if ('env' in r && r.env != null) {
      if (!Array.isArray(r.env)) throw new Error(`services[${i}].env must be an array`);
      env = r.env.map((e, j) => {
        const ev = e as Record<string, unknown>;
        if (!ev || typeof ev.key !== 'string' || !ev.key.trim() || typeof ev.value !== 'string') {
          throw new Error(`services[${i}].env[${j}] must be { key: non-empty string, value: string }`);
        }
        if (/[=\0]/.test(ev.key)) throw new Error(`services[${i}].env[${j}].key must not contain '=' or NUL`);
        return { key: ev.key, value: ev.value };
      });
    }
    let dataPath: string | null = null;
    if ('dataPath' in r && r.dataPath != null && r.dataPath !== '') {
      if (typeof r.dataPath !== 'string' || !r.dataPath.startsWith('/')) {
        throw new Error(`services[${i}].dataPath must be an absolute container path or empty`);
      }
      dataPath = r.dataPath;
    }
    return { name: r.name, image: r.image.trim(), env, dataPath };
  });
}

/**
 * Whitelist + type-check a PATCH body. An unvalidated pass-through would let a
 * typo'd field land in the registry and only fail much later, inside docker.
 * Unknown keys are rejected rather than dropped so the UI hears about them.
 */
export function validateProjectPatch(body: unknown): Partial<reg.Project> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const out: Partial<reg.Project> = {};
  const settings: Partial<reg.ProjectSettings> = {};
  const TOP = new Set(['name', 'hostPath', 'isolation', 'settings']);
  const SETTINGS = new Set([
    'provider', 'model', 'effort', 'maxBudgetUsd', 'permissionMode',
    'allowedTools', 'disallowedTools', 'mounts', 'instructions', 'container', 'browser', 'tools', 'snapshots',
    'responseDigest', 'orchestratorProfile', 'methodVersion', 'services',
  ]);

  for (const k of Object.keys(b)) {
    if (!TOP.has(k) && !SETTINGS.has(k)) throw new Error(`unknown field "${k}"`);
  }
  // Accept settings fields either nested under `settings` or flat at the top
  // level — the UI sends flat partial updates.
  const src: Record<string, unknown> = { ...(b.settings as Record<string, unknown> | undefined ?? {}) };
  for (const k of SETTINGS) if (k in b) src[k] = b[k];
  if (b.settings !== undefined && (typeof b.settings !== 'object' || b.settings === null || Array.isArray(b.settings))) {
    throw new Error('settings must be an object');
  }
  for (const k of Object.keys(src)) {
    if (!SETTINGS.has(k)) throw new Error(`unknown settings field "${k}"`);
  }

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) throw new Error('name must be a non-empty string');
    out.name = b.name.trim();
  }
  /*
   * BUG-138 — REPOINTING A PROJECT AT A NEW DIRECTORY.
   *
   * Until this existed `hostPath` was rejected as an unknown field, so a user
   * whose directory was renamed had no way to follow the rename except editing
   * registry.json by hand. Shape only here — existence, "is it a directory" and
   * "is another project already there" are checked at the route, which is where
   * the registry can be consulted and a 400 can explain itself.
   */
  if (b.hostPath !== undefined) {
    if (typeof b.hostPath !== 'string' || !b.hostPath.trim()) throw new Error('hostPath must be a non-empty string');
    out.hostPath = b.hostPath.trim();
  }
  if (b.isolation !== undefined) {
    if (typeof b.isolation !== 'string' || !ISOLATIONS.has(b.isolation)) {
      throw new Error(`isolation must be one of ${[...ISOLATIONS].join(', ')}`);
    }
    out.isolation = b.isolation as reg.Project['isolation'];
  }

  if ('provider' in src) {
    // FEAT-037 P3: which engine runs the session. A picker may select 'openai'
    // while Codex is not connected — that is allowed (the launch then fails
    // honestly with the detection hint) — but an unknown provider is not.
    if (typeof src.provider !== 'string' || !PROVIDERS.has(src.provider)) {
      throw new Error(`provider must be one of ${[...PROVIDERS].join(', ')}`);
    }
    settings.provider = src.provider as reg.Provider;
  }
  if ('model' in src) {
    if (src.model !== null && typeof src.model !== 'string') throw new Error('model must be a string or null');
    settings.model = (src.model as string | null) || null;
  }
  if ('effort' in src) {
    if (src.effort !== null && (typeof src.effort !== 'string' || !EFFORTS.has(src.effort))) {
      throw new Error(`effort must be null or one of ${[...EFFORTS].join(', ')}`);
    }
    settings.effort = src.effort as reg.ProjectSettings['effort'];
  }
  if ('maxBudgetUsd' in src) {
    if (src.maxBudgetUsd !== null && (typeof src.maxBudgetUsd !== 'number' || !Number.isFinite(src.maxBudgetUsd) || src.maxBudgetUsd <= 0)) {
      throw new Error('maxBudgetUsd must be a positive number or null');
    }
    settings.maxBudgetUsd = src.maxBudgetUsd as number | null;
  }
  if ('permissionMode' in src) {
    if (typeof src.permissionMode !== 'string' || !PERMISSION_MODES.has(src.permissionMode)) {
      throw new Error(`permissionMode must be one of ${[...PERMISSION_MODES].join(', ')}`);
    }
    settings.permissionMode = src.permissionMode as reg.PermissionMode;
  }
  for (const k of ['allowedTools', 'disallowedTools'] as const) {
    if (k in src) {
      if (!isStringArray(src[k])) throw new Error(`${k} must be an array of strings`);
      settings[k] = src[k] as string[];
    }
  }
  if ('instructions' in src) {
    if (!Array.isArray(src.instructions)) throw new Error('instructions must be an array');
    settings.instructions = src.instructions.map((raw, i) => {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r.templateId !== 'string' || !r.templateId) throw new Error(`instructions[${i}]: templateId is required`);
      if (r.mode !== undefined && r.mode !== 'append' && r.mode !== 'replace') {
        throw new Error(`instructions[${i}]: mode must be "append" or "replace"`);
      }
      return { templateId: r.templateId, mode: r.mode as 'append' | 'replace' | undefined, enabled: r.enabled !== false };
    });
  }
  if ('mounts' in src) {
    if (!Array.isArray(src.mounts)) throw new Error('mounts must be an array');
    const mounts: reg.Mount[] = src.mounts.map((raw, i) => {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r.hostPath !== 'string' || typeof r.containerPath !== 'string') {
        throw new Error(`mounts[${i}]: hostPath and containerPath are required strings`);
      }
      return { hostPath: r.hostPath, containerPath: r.containerPath, readOnly: r.readOnly !== false };
    });
    // Same check the container manager runs, applied at write time so a bad
    // mount is rejected in the settings dialog instead of at session start.
    const errs = cm.validateMounts(mounts);
    if (errs.length) throw new Error(errs.join('; '));
    settings.mounts = mounts;
  }
  if ('container' in src) {
    const c = src.container as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('container must be an object');
    for (const k of Object.keys(c)) {
      if (!['image', 'dockerSocket', 'memoryMb', 'pidsLimit'].includes(k)) throw new Error(`unknown container field "${k}"`);
    }
    const patch: Partial<reg.ContainerSettings> = {};
    if ('image' in c) {
      if (c.image !== null && typeof c.image !== 'string') throw new Error('container.image must be a string or null');
      patch.image = (c.image as string | null) || null;
    }
    if ('dockerSocket' in c) {
      if (typeof c.dockerSocket !== 'boolean') throw new Error('container.dockerSocket must be a boolean');
      patch.dockerSocket = c.dockerSocket;
    }
    if ('memoryMb' in c) {
      if (typeof c.memoryMb !== 'number' || !Number.isInteger(c.memoryMb) || c.memoryMb < 512) {
        throw new Error('container.memoryMb must be an integer >= 512');
      }
      patch.memoryMb = c.memoryMb;
    }
    if ('pidsLimit' in c) {
      if (typeof c.pidsLimit !== 'number' || !Number.isInteger(c.pidsLimit) || c.pidsLimit < 64) {
        throw new Error('container.pidsLimit must be an integer >= 64');
      }
      patch.pidsLimit = c.pidsLimit;
    }
    settings.container = patch as reg.ContainerSettings;
  }
  if ('services' in src) {
    settings.services = validateServices(src.services);
  }
  if ('browser' in src) {
    const b2 = src.browser as Record<string, unknown> | null;
    if (!b2 || typeof b2 !== 'object' || Array.isArray(b2)) throw new Error('browser must be an object');
    for (const k of Object.keys(b2)) {
      if (!['enabled', 'idleMs'].includes(k)) throw new Error(`unknown browser field "${k}"`);
    }
    const patch: Partial<reg.BrowserSettings> = {};
    if ('enabled' in b2) {
      if (typeof b2.enabled !== 'boolean') throw new Error('browser.enabled must be a boolean');
      patch.enabled = b2.enabled;
    }
    if ('idleMs' in b2) {
      /*
       * 60s floor.
       *
       * HONEST PROVENANCE: this floor was first added on a misdiagnosis — a live
       * run hung and idle-out looked like the cause; it was not (the real cause
       * was a verification harness that never answered the tool-approval
       * prompt). The floor is kept on its own merits, not on that evidence:
       * idleMs governs the shared HOST daemon, and a value shorter than the gap
       * between a session starting and its first browser call would close Chrome
       * inside that gap. Measured on this machine that gap is ~6s (ToolSearch +
       * deferred MCP tool loading), so anything under a minute is a foot-gun with
       * no legitimate use. It is a floor, not a recommendation — the adapter's
       * 15-minute default is what a real session wants.
       */
      if (b2.idleMs !== null && (typeof b2.idleMs !== 'number' || !Number.isFinite(b2.idleMs) || b2.idleMs < 60_000)) {
        throw new Error('browser.idleMs must be null or a number >= 60000 (ms) — shorter values let the browser close before a session first uses it');
      }
      patch.idleMs = b2.idleMs as number | null;
    }
    settings.browser = patch as reg.BrowserSettings;
  }
  if ('tools' in src) {
    // FEAT-025: per-project attachable dev tools (Serena / Playwright). Each is
    // a plain boolean; the UI sends the full object so a partial patch can't
    // silently drop the other toggle.
    const t = src.tools as Record<string, unknown> | null;
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('tools must be an object');
    for (const k of Object.keys(t)) {
      if (!['serena', 'playwright', 'openaiDispatch'].includes(k)) throw new Error(`unknown tools field "${k}"`);
    }
    const patch: Partial<reg.ToolSettings> = {};
    if ('serena' in t) {
      if (typeof t.serena !== 'boolean') throw new Error('tools.serena must be a boolean');
      patch.serena = t.serena;
    }
    if ('playwright' in t) {
      if (typeof t.playwright !== 'boolean') throw new Error('tools.playwright must be a boolean');
      patch.playwright = t.playwright;
    }
    if ('openaiDispatch' in t) {
      if (typeof t.openaiDispatch !== 'boolean') throw new Error('tools.openaiDispatch must be a boolean');
      patch.openaiDispatch = t.openaiDispatch;
    }
    settings.tools = patch as reg.ToolSettings;
  }
  if ('snapshots' in src) {
    const s = src.snapshots as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('snapshots must be an object');
    for (const k of Object.keys(s)) {
      if (!['enabled', 'keep', 'exclude'].includes(k)) throw new Error(`unknown snapshots field "${k}"`);
    }
    const patch: Partial<reg.SnapshotSettings> = {};
    if ('enabled' in s) {
      if (s.enabled !== null && typeof s.enabled !== 'boolean') {
        throw new Error('snapshots.enabled must be true, false, or null (null = auto: on for container isolation, off for direct)');
      }
      patch.enabled = s.enabled as boolean | null;
    }
    if ('keep' in s) {
      if (typeof s.keep !== 'number' || !Number.isInteger(s.keep) || s.keep < 1 || s.keep > 500) {
        throw new Error('snapshots.keep must be an integer between 1 and 500');
      }
      patch.keep = s.keep;
    }
    if ('exclude' in s) {
      if (!isStringArray(s.exclude)) throw new Error('snapshots.exclude must be an array of strings');
      for (const name of s.exclude) {
        if (!name.trim()) throw new Error('snapshots.exclude entries must be non-empty directory names');
        /*
         * NAMES, not paths. The walk matches `dirent.name` at every depth, so a
         * value containing a separator would match nothing and silently exclude
         * NOTHING — the user would believe a huge directory was being skipped
         * while every snapshot quietly paid for it. Rejected instead.
         */
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          throw new Error(`snapshots.exclude takes directory NAMES matched at any depth, not paths: ${JSON.stringify(name)}`);
        }
        if (name === '.git') {
          throw new Error('snapshots.exclude must not contain ".git" — the git history is the single most valuable thing a restore brings back');
        }
      }
      patch.exclude = s.exclude as string[];
    }
    settings.snapshots = patch as reg.SnapshotSettings;
  }
  if ('orchestratorProfile' in src) {
    // FEAT-096 phase 2: the whole server surface for enforcing the orchestrator
    // tool profile is this one opt-IN flag. Default is DISABLED; a project sets
    // `enabled: true` to have its sessions launched with the PreToolUse policy
    // hook. Kept to a single boolean deliberately — the policy itself is code
    // (scripts/lib/orchestrator-profile.mjs), not per-project configuration, so
    // there is no way for a registry edit to widen or invent a tool surface.
    const o = src.orchestratorProfile as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('orchestratorProfile must be an object');
    for (const k of Object.keys(o)) {
      if (k !== 'enabled') throw new Error(`unknown orchestratorProfile field "${k}"`);
    }
    const patch: Partial<reg.OrchestratorProfileSettings> = {};
    if ('enabled' in o) {
      if (typeof o.enabled !== 'boolean') throw new Error('orchestratorProfile.enabled must be a boolean');
      patch.enabled = o.enabled;
    }
    settings.orchestratorProfile = patch as reg.OrchestratorProfileSettings;
  }

  if ('responseDigest' in src) {
    // FEAT-083: the only server surface for the structured response digest is
    // this opt-OUT flag. Default is enabled; a project sets `enabled: false` to
    // suppress client-side parsing so the renderer falls back to plain prose.
    const d = src.responseDigest as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('responseDigest must be an object');
    for (const k of Object.keys(d)) {
      if (k !== 'enabled' && k !== 'guidance') throw new Error(`unknown responseDigest field "${k}"`);
    }
    const patch: Partial<reg.ResponseDigestSettings> = {};
    if ('enabled' in d) {
      if (typeof d.enabled !== 'boolean') throw new Error('responseDigest.enabled must be a boolean');
      patch.enabled = d.enabled;
    }
    if ('guidance' in d) {
      // FEAT-084: an optional short per-project nudge appended to the injected
      // response-format section. It steers only tone/verbosity — never the fixed
      // schema — but it lands verbatim inside a session's system prompt, so it is
      // trimmed, length-capped, and control-char-rejected. `null`/empty clears it.
      // Newline and tab are allowed (a multi-line nudge is legitimate); every
      // other C0/C1 control char is rejected so it can't corrupt the prompt.
      if (d.guidance !== null && typeof d.guidance !== 'string') {
        throw new Error('responseDigest.guidance must be a string or null');
      }
      if (typeof d.guidance === 'string') {
        const g = d.guidance.trim();
        if (g.length > 600) {
          throw new Error(`responseDigest.guidance must be at most 600 characters (got ${g.length})`);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(g)) {
          throw new Error('responseDigest.guidance must not contain control characters (tab and newline are allowed)');
        }
        patch.guidance = g || null;
      } else {
        patch.guidance = null;
      }
    }
    settings.responseDigest = patch as reg.ResponseDigestSettings;
  }
  if ('methodVersion' in src) {
    // BUG-144 — the stamp recording that this project's Working-Agreement method
    // decision has been made (applied or declined). A non-negative integer; the
    // server sets it (CURRENT_METHOD_VERSION) — it is validated here because the
    // add-project and backfill paths route through this one dialect.
    if (typeof src.methodVersion !== 'number' || !Number.isInteger(src.methodVersion) || src.methodVersion < 0) {
      throw new Error('methodVersion must be a non-negative integer');
    }
    settings.methodVersion = src.methodVersion;
  }

  if (Object.keys(settings).length) out.settings = settings as reg.ProjectSettings;
  if (!Object.keys(out).length) throw new Error('patch contained no updatable fields');
  return out;
}

/**
 * Validate a POST /api/projects body.
 *
 * This route used to hand the raw body straight to createProject(). Reproduced
 * consequence: a project created with `isolation: "Container"` (capital C) passed
 * `isolation ?? 'direct'` untouched, and the session then ran ON THE HOST while
 * the UI was told "Container". Unvalidated `container.dockerSocket: true` — the
 * host-root opt-in PATCH is specifically hardened against — got in the same way.
 *
 * Everything except `hostPath` is checked by validateProjectPatch, so create and
 * update share one dialect.
 */
export function validateCreateProject(body: unknown): { name?: string; hostPath: string; isolation?: reg.Project['isolation']; settings?: Partial<reg.ProjectSettings> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.hostPath !== 'string' || !b.hostPath.trim()) throw new Error('hostPath must be a non-empty string');
  const rest: Record<string, unknown> = { ...b };
  delete rest.hostPath;
  // FEAT-089: `applyMethod` is a request-level directive (auto-apply the method
  // on add, default true), NOT a stored project field — strip it here so it
  // never reaches validateProjectPatch, whose unknown-field check would reject
  // it. The route reads it straight off the raw body.
  delete rest.applyMethod;
  const out: { name?: string; hostPath: string; isolation?: reg.Project['isolation']; settings?: Partial<reg.ProjectSettings> } = {
    hostPath: b.hostPath.trim(),
  };
  if (Object.keys(rest).length) {
    const patch = validateProjectPatch(rest);
    if (patch.name !== undefined) out.name = patch.name;
    if (patch.isolation !== undefined) out.isolation = patch.isolation;
    if (patch.settings !== undefined) out.settings = patch.settings;
  }
  return out;
}

/**
 * Parse a query-string integer. `Number('abc')` is NaN, and `Math.min(MAX,
 * Math.max(1, NaN))` is NaN — which then makes `length >= NaN` always false and
 * silently defeats every limit. Observed: `?limit=abc` on a 286 MB session
 * returned 23,859 messages / 19 MB instead of the 300-message page.
 */
export function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${JSON.stringify(raw)}`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/* ------------------------------------------------ session title / pin patch */

/** Longest custom title accepted. Sidebar rows are one line; this is generous. */
export const MAX_SESSION_TITLE_CHARS = 200;

/**
 * The ONE session-title rule, used by PATCH /api/sessions/:id.
 *
 * Trimmed, non-empty, length-capped, and free of control characters — a title
 * is appended verbatim to a JSONL line, so an embedded newline would split one
 * entry into two and corrupt the transcript the SDK just wrote.
 */
export function validateSessionTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('title must be a string');
  const t = raw.trim();
  if (!t) throw new Error('title must be a non-empty string (after trimming)');
  if (t.length > MAX_SESSION_TITLE_CHARS) {
    throw new Error(`title must be at most ${MAX_SESSION_TITLE_CHARS} characters (got ${t.length})`);
  }
  if (/[\u0000-\u001f\u007f]/.test(t)) {
    throw new Error('title must not contain control characters or line breaks');
  }
  return t;
}

export interface SessionPatch {
  title?: string;
  pinned?: boolean;
  /** Encoded store dir, disambiguating a session id present under several. */
  dir?: string;
}

/**
 * Validate a PATCH /api/sessions/:sessionId body.
 *
 * `title: null` is REJECTED rather than treated as "clear the custom title":
 * the SDK exposes no un-rename (`renameSession` only appends a new
 * `custom-title` entry, and there is no entry type that removes one), so
 * accepting it would be a silent no-op — the exact failure this codebase
 * refuses to ship.
 */
export function validateSessionPatch(body: unknown): SessionPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const ALLOWED = new Set(['title', 'pinned', 'dir']);
  for (const k of Object.keys(b)) {
    if (!ALLOWED.has(k)) throw new Error(`unknown field "${k}" (allowed: ${[...ALLOWED].join(', ')})`);
  }
  const out: SessionPatch = {};
  if ('title' in b) {
    if (b.title === null) {
      throw new Error(
        'title cannot be cleared: the session store has no "remove custom title" entry, so this would be a silent no-op. Rename to the auto summary instead.',
      );
    }
    out.title = validateSessionTitle(b.title);
  }
  if ('pinned' in b) {
    if (typeof b.pinned !== 'boolean') throw new Error('pinned must be a boolean');
    out.pinned = b.pinned;
  }
  if ('dir' in b) {
    if (typeof b.dir !== 'string' || !b.dir.trim()) throw new Error('dir must be a non-empty string (the encoded store dir)');
    out.dir = b.dir.trim();
  }
  if (out.title === undefined && out.pinned === undefined) throw new Error('patch contained no updatable fields (title, pinned)');
  return out;
}

/* --------------------------------------------------- per-session overrides */

/**
 * Fields a `start{overrides}` may carry. Each is a plain SDK option (or, for
 * maxBudgetUsd, host-side accounting in the bridge) and therefore applies for
 * one session without touching anything the project owns on disk.
 */
export const SESSION_OVERRIDE_FIELDS = [
  // FEAT-037 P3: the engine is launch-scoped state — it applies to exactly one
  // session's runtime construction and touches nothing on disk, so it may be
  // overridden per launch like model/effort.
  'provider',
  'model',
  'effort',
  'permissionMode',
  'maxBudgetUsd',
  'allowedTools',
  'disallowedTools',
] as const;

export type SessionOverrideField = (typeof SESSION_OVERRIDE_FIELDS)[number];
export type SessionOverrides = Pick<reg.ProjectSettings, SessionOverrideField>;

const OVERRIDABLE = new Set<string>(SESSION_OVERRIDE_FIELDS);

/**
 * Why the project-scope-only fields are rejected instead of quietly ignored:
 *
 *  - `mounts` and `container.*` are baked into the container's identity. The
 *    container manager treats any bind/limit difference as drift and RECREATES
 *    the container, which would (a) affect every other session on that project
 *    and (b) survive past this session's lifetime — the exact opposite of a
 *    per-session override.
 *  - `isolation` selects the execution model. Changing it per session would mean
 *    a "session override" that decides whether the agent runs on the host.
 *  - `instructions` already has its own per-session channel (`start.templateIds`).
 *
 * A silent drop here is the failure mode this project exists to avoid: the drawer
 * would show `overridden` and the agent would ignore it. So: hard error, reported
 * to the UI, session does not start.
 */
export function validateSessionOverrides(body: unknown): SessionOverrides {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('overrides must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (OVERRIDABLE.has(k)) continue;
    if (k === 'instructions') {
      throw new Error('overrides.instructions is not carried here — send instruction overrides as start.templateIds');
    }
    if (k === 'snapshots') {
      throw new Error(
        'overrides.snapshots is project-scope only: the session-start snapshot is taken before the session exists, ' +
          'so a per-session value could not have applied to it. Change it on the project instead.',
      );
    }
    if (k === 'mounts' || k === 'container' || k === 'isolation') {
      throw new Error(
        `overrides.${k} is project-scope only: it changes the container/execution identity, which cannot be scoped to one session. Change it on the project instead.`,
      );
    }
    throw new Error(`unknown override field "${k}" (allowed: ${SESSION_OVERRIDE_FIELDS.join(', ')})`);
  }
  if (!Object.keys(b).length) throw new Error('overrides was an empty object');
  // Same dialect, literally: the registry PATCH validator does the type checking.
  const patch = validateProjectPatch({ settings: b });
  return (patch.settings ?? {}) as SessionOverrides;
}
