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
import { globalSettingsFile, writeAtomic } from '../lib/paths.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;

export interface GlobalDefaults {
  /**
   * The model every new session inherits unless its project (or the session)
   * overrides it. `null` = no global default; the engine picks, exactly as
   * before this feature existed.
   */
  model: string | null;
  /** Global default reasoning effort, applied where a project leaves effort unset. */
  effort: Effort;
}

export const GLOBAL_DEFAULTS: GlobalDefaults = { model: null, effort: null };

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
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
export function applyGlobalDefaults(project: { model: string | null; effort: Effort }): { model: string | null; effort: Effort } {
  const g = readGlobalDefaults();
  return {
    model: project.model ?? g.model,
    effort: project.effort ?? g.effort,
  };
}

function normalise(obj: unknown): GlobalDefaults {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  const model = typeof o.model === 'string' && MODEL_RE.test(o.model) ? o.model : null;
  const effort = typeof o.effort === 'string' && EFFORTS.has(o.effort) ? (o.effort as Effort) : null;
  return { model, effort };
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

  const unknown = Object.keys(p).filter((k) => k !== 'model' && k !== 'effort');
  if (unknown.length) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };

  writeAtomic(globalSettingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, value: next };
}
