/**
 * FEAT-118 — app-wide (global) defaults.
 *
 * Why this file exists: the orchestrator's spend is dominated by context
 * maintenance, so the lever that matters is dropping the *default* model tier
 * for new sessions — machine-wide, not project by project. Before this, a
 * session's model resolved `project.settings.model → session override` and the
 * project default itself was `null` ("let the engine pick"), so there was no
 * single place to say "everything new starts on Haiku/Opus-4.8 unless told
 * otherwise". This is that single place.
 *
 * Resolution order (ARCH-010 — one owner writes the fact, readers read it):
 *
 *     global default  ⟵ this file
 *       └─ project override      ⟵ registry.json → projects[].settings
 *            └─ session override ⟵ per-launch / live set-model
 *
 * The MERGE (global under project) happens in exactly one place —
 * `pickOverridable()` in agent-bridge.ts, which seeds every session's effective
 * config. This module only owns *reading and writing the global layer*; it does
 * not itself decide what any session runs with.
 *
 * Only fields that genuinely inherit are offered here. `model` and `effort`
 * both default to `null` on a project ("unset"), so a global default for them
 * reaches every project that has not overridden it. `provider` is deliberately
 * NOT global: every project persists an explicit `provider` (defaultSettings
 * writes 'anthropic'), so a global provider default would be silently inert and
 * mislead — see the note in defaultSettings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalSettingsFile, writeAtomic, dataDir } from '../lib/paths.ts';
import type { Isolation } from './events.ts';
// FEAT-145 step 4 — the account registry is the OWNER of "which account ids
// exist" (ARCH-010); this module reconciles the stored `claudeAccount` against
// it rather than keeping a second list. Import direction is safe: claude-accounts
// imports only `../lib/paths.ts`, so there is no cycle back to here.
import { readAccounts, DEFAULT_ACCOUNT_ID } from './claude-accounts.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;

/**
 * FEAT-139 — the app appearance. A real machine-scope setting persisted here (a
 * localStorage cache on the client is a fast first read, NOT the only record).
 * `'system'` follows the OS light/dark; it is the built-in default, so unlike the
 * inherit/seed fields below theme is never `null` — its "no preference" state is
 * a concrete value the client and the server-side HTML injection both act on.
 */
export type Theme = 'system' | 'light' | 'dark';

/**
 * FEAT-139 — the machine-wide default layer. Two KINDS of field live here and
 * the distinction is load-bearing, so it is stated once at the owner (ARCH-010):
 *
 *  - LIVE-INHERITED (`model`, `effort`): a project stores `null` for these and
 *    the merge under a project happens at session-start (`pickOverridable`).
 *    Changing the global default here reaches EXISTING projects that never
 *    overrode it, on their next session.
 *
 *  - NEW-PROJECT SEED (`isolation`, `openaiDispatch`, `serena`, `playwright`):
 *    a project stores a CONCRETE value for these at creation, so there is no
 *    live merge to ride. The global default is consulted only by the creation
 *    path (registry.ts `resolveNewProjectIsolation` / `resolveNewProjectToolSettings`)
 *    as the "wanted" value, still behind each field's own preflight. Changing
 *    it here affects only projects created AFTER the change — existing rows are
 *    never rewritten (no migration; the user's records are untouched).
 *
 * `null` for any field = "no machine-wide default; use the built-in default"
 * (exactly the behaviour before that field was offered here).
 */
export interface GlobalDefaults {
  /**
   * The model every new session inherits unless its project (or the session)
   * overrides it. `null` = no global default; the engine picks, exactly as
   * before this feature existed.
   */
  model: string | null;
  /** Global default reasoning effort, applied where a project leaves effort unset. */
  effort: Effort;
  /**
   * FEAT-145 step 4 — the machine-wide default Claude account every new session
   * uses unless its project (or, once step 5 lands, the session) overrides it.
   * `null` = the IMPLICIT default account (`~/.claude`) — today's behaviour,
   * byte-identical. A non-null value is an account id minted by
   * `claude-accounts.ts`; it LIVE-inherits (a project storing `null` picks up a
   * later change on its next session, via `pickOverridable`), which is why its
   * SEED_CHANNEL is `'projectSettings'`. Reconciled on read: an id naming a
   * DELETED account normalises back to `null` rather than dangling (see
   * `normalise`), so a removed account can never silently spend the wrong quota.
   */
  claudeAccount: string | null;
  /**
   * FEAT-139 — the isolation tier a NEW project is created with when the create
   * request does not name one. `null` = use the built-in default
   * (`NEW_PROJECT_DEFAULT_ISOLATION`). Container is still preflighted and falls
   * safe to direct; this only changes what the creation path TRIES.
   */
  isolation: Isolation | null;
  /** FEAT-139 — new-project default for host-brokered OpenAI dispatch. `null` = built-in. */
  openaiDispatch: boolean | null;
  /** FEAT-139 — new-project default for the Serena LSP MCP. `null` = built-in (on). */
  serena: boolean | null;
  /** FEAT-139 — new-project default for the Playwright MCP (still behind its host-binary preflight). `null` = built-in. */
  playwright: boolean | null;
  /**
   * FEAT-139 — the app appearance (machine-wide). Unlike every other field here
   * it is NOT null-able: `'system'` IS its built-in default. It does not seed a
   * project (see `SEED_CHANNEL` → `'machineOnly'`); it is applied to the whole UI.
   */
  theme: Theme;
}

export const GLOBAL_DEFAULTS: GlobalDefaults = {
  model: null,
  effort: null,
  claudeAccount: null,
  isolation: null,
  openaiDispatch: null,
  serena: null,
  playwright: null,
  theme: 'system',
};

/**
 * ARCH-010 / FEAT-139 — the SEED CHANNEL of every machine default, declared once
 * by the OWNER of GlobalDefaults. A new project's creation path (registry.ts
 * `createProject`) READS this instead of re-deciding per field, which is what
 * makes it structurally impossible to add a machine default that silently fails
 * to seed a new project — the round-1 "dead toggle" bug (`model`/`effort` wired
 * nowhere while the others seeded). Because the map is
 * `satisfies Record<keyof GlobalDefaults, SeedChannel>`, adding a field to
 * `GlobalDefaults` without giving it a channel here is a COMPILE ERROR: the class
 * is closed at the type level, not by remembering to wire each new field.
 *
 * Three channels, because the machine defaults seed by three genuinely different
 * mechanisms — but every field belongs to exactly one, and every channel is
 * consumed by the creation path:
 *
 *  - `'projectSettings'` — copied straight onto `project.settings[<same key>]`
 *    at creation when the create request did not set it. For `model`/`effort` a
 *    NULL machine default leaves the field null, so the project still
 *    LIVE-inherits a later machine change via `applyGlobalDefaults` /
 *    `pickOverridable` (the FEAT-118 semantics); a non-null machine default is
 *    frozen onto the row so its STORED config reflects the machine default
 *    (FEAT-139 requirement 3). An explicit request value always wins (req 4).
 *  - `'isolation'` — consumed by `resolveNewProjectIsolation`, behind the
 *    container preflight (falls safe to `direct`).
 *  - `'toolSettings'` — consumed by `resolveNewProjectToolSettings` (Playwright
 *    behind the host-binary preflight; serena/dispatch honoured directly).
 *  - `'machineOnly'` — a machine-wide setting that DELIBERATELY does not seed a
 *    project because it is not project config: `theme` is whole-app appearance,
 *    applied to the UI and injected into first paint, never copied onto a
 *    project row. This is not "unwired" — it is an explicit, owner-declared
 *    "no project seed", which the `satisfies` check forces every field to make.
 */
export type SeedChannel = 'projectSettings' | 'isolation' | 'toolSettings' | 'machineOnly';

export const SEED_CHANNEL = {
  model: 'projectSettings',
  effort: 'projectSettings',
  // FEAT-145 step 4 — MUST be 'projectSettings', never 'machineOnly': the
  // per-session override in step 5 is `Pick<ProjectSettings, ...>`
  // (validate.ts SessionOverrides), so an override can only exist for a field
  // that also lives on ProjectSettings. This channel is what puts it there.
  claudeAccount: 'projectSettings',
  isolation: 'isolation',
  openaiDispatch: 'toolSettings',
  serena: 'toolSettings',
  playwright: 'toolSettings',
  theme: 'machineOnly',
} satisfies Record<keyof GlobalDefaults, SeedChannel>;

/**
 * The GlobalDefaults keys whose machine default is copied straight onto a new
 * project's settings — DERIVED from `SEED_CHANNEL` so the list can never drift
 * from the declaration above. Consumed by registry.ts `createProject`. If a
 * future `'projectSettings'`-channel field is not also a `ProjectSettings` field
 * the build breaks at that call site (the seed cannot silently no-op).
 */
export type ProjectSettingsSeedKey = {
  [K in keyof typeof SEED_CHANNEL]: (typeof SEED_CHANNEL)[K] extends 'projectSettings' ? K : never;
}[keyof typeof SEED_CHANNEL];

export const PROJECT_SETTINGS_SEED_KEYS: readonly ProjectSettingsSeedKey[] =
  (Object.keys(SEED_CHANNEL) as (keyof typeof SEED_CHANNEL)[])
    .filter((k): k is ProjectSettingsSeedKey => SEED_CHANNEL[k] === 'projectSettings');

const ISOLATIONS: ReadonlySet<string> = new Set(['direct', 'container', 'sandbox']);
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);
// Same shape the dispatch broker accepts for a model id — a conservative,
// provider-agnostic charset so a garbage value can never reach a launch.
// Square brackets are permitted because the CLI's OWN advertised ids carry them
// (`opus[1m]`, `claude-fable-5[1m]` — the 1M-context variants), so a picker over
// the CLI's catalog must be able to persist them; before this they 400'd on the
// global/dispatch path while the project path (which does no charset check at
// all) accepted them. Still anchored, still length-capped, still starts
// alphanumeric, and the charset carries no shell metacharacters or whitespace —
// the value is an argv element (never shell-interpreted) and a JSON string, so
// `[` and `]` are inert. We are deliberately no looser than the ids the tool we
// drive actually emits and accepts.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

/**
 * Read the global defaults from disk. Tolerant by construction: a missing file,
 * unparseable JSON, or an unknown field all resolve to the documented default
 * rather than throwing, so a session start never fails on a corrupt settings
 * file. Read fresh each call — session starts are infrequent, and this keeps a
 * change to the global default applying to the next session without a restart.
 */
export function readGlobalDefaults(): GlobalDefaults {
  let raw: string;
  try {
    raw = fs.readFileSync(globalSettingsFile(), 'utf8');
  } catch {
    return { ...GLOBAL_DEFAULTS };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ...GLOBAL_DEFAULTS };
  }
  return normalise(obj);
}

/**
 * Apply the global-default layer UNDER a project's own values — the one merge
 * that decides what a project with an unset field inherits. `pickOverridable`
 * (agent-bridge) is the sole runtime caller, so a session's effective model/
 * effort has a single authority; this is exported only so it can be exercised
 * directly against a real settings.json. A project value (including one that
 * differs from the global) always wins; the global only fills an unset (null)
 * field.
 */
export function applyGlobalDefaults(
  project: { model: string | null; effort: Effort; claudeAccount?: string | null },
): { model: string | null; effort: Effort; claudeAccount: string | null } {
  const g = readGlobalDefaults();
  return {
    model: project.model ?? g.model,
    effort: project.effort ?? g.effort,
    // FEAT-145 step 4 — machine → project inheritance for the account. A project
    // storing `null` LIVE-inherits the machine default here; a non-null project
    // value wins. `g.claudeAccount` is already reconciled to an existing id (or
    // null) by `normalise`, so this never returns a dangling machine default.
    claudeAccount: project.claudeAccount ?? g.claudeAccount,
  };
}

/**
 * Resolve a session's model against its PROVIDER — the one place that couples the
 * two, so no reader downstream re-decides it (ARCH-010). An explicit project (or
 * session-override) model always wins. When the project leaves model UNSET, the
 * machine-wide global default fills it ONLY for an anthropic session: that default
 * is a CLAUDE model id (provider is deliberately not a global default — see the
 * header note above), so inheriting it into a Codex session would send `claude-*`
 * to the OpenAI runtime, which 400s ("model is not supported when using Codex with
 * a ChatGPT account"). A non-anthropic session with no explicit model resolves to
 * `null`, letting the engine pick its own default.
 *
 * This is a launch-time resolve, not a migration: a stored `provider:openai,
 * model:null` row (the common case — a project inheriting the machine default)
 * simply resolves safely here on every start, and the registry is never rewritten.
 */
/** Drop an engine/tier suffix (`claude-opus-5-5[1m]` → `claude-opus-5-5`) so a
 *  stored wire id compares equal to a catalog `resolvedModel` that carries one. */
function baseModelId(m: string): string {
  return m.replace(/\[[^\]]*\]$/, '');
}

/** Structural fallbacks for classifying a model id when no catalog is present
 *  (a fresh machine that has never listed a provider's models). Anchored to the
 *  stable vendor wire-id prefixes, NOT to any single model name. */
const ANTHROPIC_MODEL_RE = /^claude/i;
const OPENAI_MODEL_RE = /^(gpt|o\d|codex)/i;
/** BUG-196 round 6 — the Claude CLI's own model ALIASES (`claude --help`: "an alias
 *  for the latest model (e.g. 'fable', 'opus', or 'sonnet')", plus the `default` /
 *  `haiku` / `opusplan` rows its catalog reports). The UI offers these as picks
 *  (the static opus/sonnet/haiku rows, the drawer's alias cycle) on a machine with
 *  no catalog yet, so they must classify as Claude WITHOUT a catalog — round 5 left
 *  them unclassified, and an unclassified pick is passed through, so `opus` reached
 *  a Codex session. Matched on the base id, so `opus[1m]` is covered too. */
const ANTHROPIC_ALIAS_RE = /^(default|fable|opus|sonnet|haiku|opusplan)$/i;

/** The per-provider model catalog file the runtime remembers (mirrors
 *  agent-bridge's `modelsFile`): `models.json` for anthropic, `models-<p>.json`
 *  otherwise. Read-only, tolerant — a missing/corrupt file is "no catalog". */
function readModelCatalog(provider: string): Array<{ value?: unknown; resolvedModel?: unknown }> {
  try {
    const file = path.join(dataDir(), provider === 'anthropic' ? 'models.json' : `models-${provider}.json`);
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function catalogClaims(provider: string, model: string): boolean {
  const want = baseModelId(model);
  return readModelCatalog(provider).some((e) => {
    const v = typeof e.value === 'string' ? baseModelId(e.value) : null;
    const r = typeof e.resolvedModel === 'string' ? baseModelId(e.resolvedModel) : null;
    return v === want || r === want;
  });
}

/**
 * Which engine a model id belongs to, or `null` when it cannot be classified —
 * the ONE owner of that fact (ARCH-010), so no downstream call site re-decides
 * it with an ad-hoc string test. The provider's OWN model catalog is the
 * authority (it lists exactly what that engine offers); a structural wire-id
 * prefix is the fallback when the catalog has not been populated yet. Unknown →
 * `null`, so a model we cannot place is never wrongly dropped.
 */
export function modelProviderOf(model: string | null): 'anthropic' | 'openai' | null {
  if (!model) return null;
  if (catalogClaims('anthropic', model)) return 'anthropic';
  if (catalogClaims('openai', model)) return 'openai';
  if (ANTHROPIC_MODEL_RE.test(model)) return 'anthropic';
  if (ANTHROPIC_ALIAS_RE.test(baseModelId(model))) return 'anthropic'; // BUG-196 round 6
  if (OPENAI_MODEL_RE.test(model)) return 'openai';
  return null;
}

export function resolveModelForProvider(
  projectModel: string | null,
  provider: string | null,
): string | null {
  const prov = provider ?? 'anthropic';
  if (projectModel != null) {
    // An explicit model (project OR session-override) normally wins — but only if
    // it is compatible with the session's engine. A model that provably belongs to
    // a DIFFERENT provider (the classic case: a `claude-*` id cached by the UI as a
    // session override — see BUG-188 round 2 — reaching a Codex session) would 400
    // at every turn, so it is dropped to null (the engine picks its own default)
    // rather than passed through. Neutralised on every start: no data migration,
    // and a stale UI override the server cannot rewrite is simply ignored here.
    const belongs = modelProviderOf(projectModel);
    if (belongs != null && belongs !== prov) return null;
    return projectModel;
  }
  if (prov !== 'anthropic') return null;
  return readGlobalDefaults().model;
}

/**
 * FEAT-145 step 4 / ARCH-010 — the set of account ids that actually EXIST right
 * now, read from the registry that owns them. `null` (the implicit default) and
 * the literal `'default'` id are always valid; any other id is valid only while
 * its account row is present, so a deleted account normalises away rather than
 * dangling. Tolerant by construction (readAccounts returns [] on a
 * missing/corrupt registry), so a session start never fails resolving this.
 */
function knownAccountIds(): ReadonlySet<string> {
  return new Set<string>([DEFAULT_ACCOUNT_ID, ...readAccounts().map((r) => r.id)]);
}

/** A stored boolean field is honoured only when literally boolean; anything else = "unset". */
function readBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function normalise(obj: unknown): GlobalDefaults {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  const model = typeof o.model === 'string' && MODEL_RE.test(o.model) ? o.model : null;
  const effort = typeof o.effort === 'string' && EFFORTS.has(o.effort) ? (o.effort as Effort) : null;
  const isolation = typeof o.isolation === 'string' && ISOLATIONS.has(o.isolation) ? (o.isolation as Isolation) : null;
  // theme never null: a missing/garbage stored value resolves to the built-in
  // 'system', so a corrupt settings.json can never leave the UI themeless.
  const theme = typeof o.theme === 'string' && THEMES.has(o.theme) ? (o.theme as Theme) : 'system';
  // FEAT-145 step 4 — reconcile the stored account id against the accounts that
  // actually exist. The canonical form of "the default account" is `null`, so
  // the literal 'default' sentinel AND any id whose account has been deleted both
  // normalise to `null` — never a dangling id that would resolve to a config dir
  // and spend the wrong plan's quota.
  const claudeAccount =
    typeof o.claudeAccount === 'string' &&
    o.claudeAccount !== DEFAULT_ACCOUNT_ID &&
    knownAccountIds().has(o.claudeAccount)
      ? o.claudeAccount
      : null;
  return {
    model,
    effort,
    claudeAccount,
    isolation,
    openaiDispatch: readBool(o.openaiDispatch),
    serena: readBool(o.serena),
    playwright: readBool(o.playwright),
    theme,
  };
}

/** The result of validating an incoming PATCH before it is written. */
export type PatchResult = { ok: true; value: GlobalDefaults } | { ok: false; error: string };

/**
 * Validate a partial patch and write the merged result atomically. A field
 * absent from the patch is left unchanged; an explicit `null` clears it (back to
 * "no global default"). Returns the full resolved defaults on success.
 */
export function patchGlobalDefaults(patch: unknown): PatchResult {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const p = patch as Record<string, unknown>;
  const current = readGlobalDefaults();
  const next: GlobalDefaults = { ...current };

  if ('model' in p) {
    const v = p.model;
    if (v === null) next.model = null;
    else if (typeof v === 'string' && MODEL_RE.test(v)) next.model = v;
    else return { ok: false, error: 'model must be null or a model id (letters, digits, . _ : - [ ])' };
  }
  if ('effort' in p) {
    const v = p.effort;
    if (v === null) next.effort = null;
    else if (typeof v === 'string' && EFFORTS.has(v)) next.effort = v as Effort;
    else return { ok: false, error: `effort must be null or one of ${[...EFFORTS].join(', ')}` };
  }
  if ('claudeAccount' in p) {
    // FEAT-145 step 4 — null (or the 'default' sentinel) clears back to the
    // implicit default account; any other value must name an account that
    // EXISTS right now, so the picker can never persist an id that would fail
    // (or silently fall back to the wrong plan) at session start.
    const v = p.claudeAccount;
    if (v === null || v === DEFAULT_ACCOUNT_ID) next.claudeAccount = null;
    else if (typeof v === 'string' && knownAccountIds().has(v)) next.claudeAccount = v;
    else return { ok: false, error: `claudeAccount must be null or the id of an existing account` };
  }
  if ('isolation' in p) {
    const v = p.isolation;
    if (v === null) next.isolation = null;
    else if (typeof v === 'string' && ISOLATIONS.has(v)) next.isolation = v as Isolation;
    else return { ok: false, error: `isolation must be null or one of ${[...ISOLATIONS].join(', ')}` };
  }
  for (const key of ['openaiDispatch', 'serena', 'playwright'] as const) {
    if (key in p) {
      const v = p[key];
      if (v === null) next[key] = null;
      else if (typeof v === 'boolean') next[key] = v;
      else return { ok: false, error: `${key} must be null or a boolean` };
    }
  }
  if ('theme' in p) {
    const v = p.theme;
    // theme has no null state: 'system' IS "no preference". Accept an explicit
    // null as a clear-to-system for symmetry with the other fields, but reject
    // any unknown value strictly (400) — same bar as an unknown field.
    if (v === null) next.theme = 'system';
    else if (typeof v === 'string' && THEMES.has(v)) next.theme = v as Theme;
    else return { ok: false, error: `theme must be null or one of ${[...THEMES].join(', ')}` };
  }

  const known = new Set(['model', 'effort', 'claudeAccount', 'isolation', 'openaiDispatch', 'serena', 'playwright', 'theme']);
  const unknown = Object.keys(p).filter((k) => !known.has(k));
  if (unknown.length) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };

  writeAtomic(globalSettingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, value: next };
}
