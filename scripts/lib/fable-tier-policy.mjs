/**
 * fable-tier-policy.mjs — FEAT-124. Refuse an UNJUSTIFIED Fable dispatch, and
 * fail SAFE-UP (to Opus), on the same in-process PreToolUse callback that already
 * enforces the git-write block (FEAT-108) and the orchestrator profile (FEAT-096).
 *
 * WHY THIS EXISTS (the finding, verbatim from the ticket): `docs/prompts/ROUTING.md`
 * says Opus is the default and Fable is only for frontier-hard work, yet routine
 * fix/build lanes ran on Fable — measured $71 stale-cards, $31 UI batch, $27
 * picker, $21 transcripts, all `fix`/build work. The rule existed only as prose and
 * was ignored. Same failure mode as FEAT-096 (forced dispatch) and FEAT-108
 * (git-write block): a rule that lives only in a doc gets ignored, and the fix has
 * to be structural.
 *
 * ── Why a MODEL-keyed gate, not a class-keyed one ────────────────────────────
 * FEAT-124's own measurement: 101 of 103 Fable lanes declared NO dispatch class at
 * all. A rule keyed on the declared class would be inert on ~98% of the lanes that
 * need it (treat "no class" as allow → it does nothing; as deny → it blocks nearly
 * every dispatch). So this gate keys on the one thing that IS present on the costly
 * lanes: an explicit `model: fable` on the `Agent` tool call. `toolInput.model` is
 * exactly what the PreToolUse payload carries for an Agent dispatch.
 *
 * ── Why REROUTE-to-Opus, not DENY ────────────────────────────────────────────
 * A bare PreToolUse deny would ABORT the dispatch — the lane never runs, the work
 * does not get done. That is not the intent; the intent is "this work does not need
 * the premium tier, so run it on the sanctioned ceiling instead." The SDK's
 * PreToolUse hook can return `updatedInput` alongside `permissionDecision: 'allow'`
 * (sdk.d.ts PreToolUseHookSpecificOutput.updatedInput), so the gate REWRITES the
 * Agent call's `model` to `opus` and lets it proceed. The lane runs — on Opus.
 *
 * ── Why the fallback is Opus, HARD-CODED, and never a strip-and-inherit ───────
 * The costly mistake this system can make is hard work on TOO WEAK a model; that
 * costs far more than the tokens a premium tier burns. So the fallback direction is
 * non-negotiable: UP to Opus, NEVER down to Sonnet/Haiku. Rewriting `model` to the
 * literal `'opus'` GUARANTEES that floor deterministically, whatever the session's
 * ambient default happens to be. The tempting alternative — delete `model` and let
 * the lane inherit the session/global default — was rejected: if that default were
 * ever misconfigured below Opus, an unjustified Fable request would silently land
 * on a weaker model, which is precisely the non-negotiable-direction violation. We
 * replace an explicit premium request with an explicit ceiling request; we do not
 * gamble on inheritance.
 *
 * ── The override token, and why THIS form ────────────────────────────────────
 * A genuinely frontier-hard dispatch keeps Fable by writing a `fable-justified: <reason>`
 * line into the Agent prompt. Chosen because:
 *  1. It rides the free-text prompt the hook already receives — no new plumbing,
 *     no schema change to the Agent tool.
 *  2. It REQUIRES a non-empty reason. The point is an intentional, stated choice;
 *     a bare marker with no reason does NOT qualify. The reason is logged, so every
 *     override is auditable after the fact.
 *  3. It is greppable across the transcript store (`grep 'fable-justified:'`) for
 *     the standing audit, and mirrors the existing `Dispatch:` marker-line convention
 *     the orchestrator already writes.
 *
 * ── The KNOWN blind spot (documented, per the ticket) ─────────────────────────
 * This gate keys on an EXPLICIT `model:` in the Agent payload. A lane that inherits
 * Fable as a session/global DEFAULT (no `model:` on the Agent call) has nothing for
 * the gate to catch — the payload carries no resolved-model field. That default-tier
 * decision is a separate, larger user choice (FEAT-118 / global-settings.ts) and is
 * deliberately NOT touched here. The visibility flag (FEAT-124 option B, in
 * cost-collect.mjs) is what surfaces any Fable that still gets through, including
 * this path, after the fact.
 *
 * ── The escape hatch ─────────────────────────────────────────────────────────
 * `ORCHARD_ALLOW_FABLE=1` disables the gate for one run (Fable dispatches pass
 * ungated). Like the git-write hatch, opening it is made VISIBLE, not silent:
 * claude-runtime.ts announces it once per session on stderr.
 *
 * ── One definition, imported (ARCH-008) ──────────────────────────────────────
 * The decision lives here and is imported by the runtime hook and by the tests, so
 * there is exactly one answer to "is this Fable dispatch justified?" in the repo.
 */

/**
 * Gate ON by default. `ORCHARD_ALLOW_FABLE` truthy opens the hatch (gate OFF).
 * Mirrors gitWriteBlockEnabled's grammar so the two hatches read the same.
 */
export function fableTierGateEnabled(env = process.env) {
  const v = env.ORCHARD_ALLOW_FABLE;
  if (v == null) return true; // gate ON by default
  const s = String(v).trim().toLowerCase();
  return !(s === '1' || s === 'true' || s === 'yes' || s === 'on');
}

/**
 * Is this model the Fable premium tier? Matches the short alias the Agent tool
 * accepts (`fable`) and every full id form (`claude-fable-5`, `claude-fable-5[1m]`,
 * any future `claude-fable-*`). Opus/Sonnet/Haiku contain no "fable" substring, so
 * they are untouched — the gate is Fable-only by construction.
 */
const FABLE_RE = /fable/i;
export function isFableModel(model) {
  return typeof model === 'string' && FABLE_RE.test(model);
}

/** The sanctioned ceiling the gate reroutes to. A valid Agent-tool model alias. */
export const FALLBACK_MODEL = 'opus';

/**
 * The override marker: `fable-justified: <reason>` anywhere in the Agent prompt,
 * with a NON-EMPTY reason. Returns the trimmed reason, or null when absent/empty.
 * `[^\S\r\n]` is "horizontal whitespace" — a bare `fable-justified:` (nothing but
 * spaces after the colon, then end of line) yields no reason and does NOT qualify.
 */
const FABLE_JUSTIFIED_RE = /^[^\S\r\n]*fable-justified[^\S\r\n]*:[^\S\r\n]*(\S.*)$/im;
export function fableJustification(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = FABLE_JUSTIFIED_RE.exec(prompt);
  const reason = m && m[1] ? m[1].trim() : '';
  return reason.length ? reason : null;
}

/**
 * THE decision. Called by the enforcing hook and by the tests (one answer per repo).
 *
 * @param {object} call
 * @param {string} call.toolName
 * @param {unknown} [call.toolInput]  the Agent tool_input: { model, subagent_type, description, prompt, … }
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   action: 'ignore' | 'allow' | 'reroute',
 *   requested?: string|null,      // the requested model (null when none/non-string)
 *   label?: string|null,          // the lane label (Agent description) for the log
 *   justification?: string|null,  // the override reason, when action==='allow'
 *   hatch?: boolean,              // true when action==='allow' only because the hatch is open
 *   fallbackModel?: string,       // 'opus', when action==='reroute'
 *   updatedInput?: object,        // the rewritten tool_input, when action==='reroute'
 * }}
 *
 * - `ignore`  : not an Agent call, or not a Fable request → the gate does nothing.
 * - `allow`   : a Fable request that IS justified (override present) or that the
 *               open hatch permits → let it run on Fable; the caller logs it.
 * - `reroute` : a Fable request with NO justification → rewrite model to Opus.
 */
export function decideFableTier({ toolName, toolInput } = {}, env = process.env) {
  if (toolName !== 'Agent') return { action: 'ignore' };
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const requested = typeof input.model === 'string' ? input.model : null;
  const label = typeof input.description === 'string' ? input.description : null;

  // Blind spot, by design: no explicit Fable model → nothing to catch. A Fable
  // DEFAULT inherited with no `model:` on the call is invisible here (see header).
  if (!isFableModel(requested)) return { action: 'ignore', requested, label };

  // Hatch open → Fable passes ungated, but the caller still logs it as visible.
  if (!fableTierGateEnabled(env)) {
    return { action: 'allow', requested, label, justification: null, hatch: true };
  }

  const justification = fableJustification(input.prompt);
  if (justification) return { action: 'allow', requested, label, justification, hatch: false };

  // Unjustified Fable → reroute UP to the sanctioned ceiling (Opus). The lane runs.
  return {
    action: 'reroute',
    requested,
    label,
    fallbackModel: FALLBACK_MODEL,
    updatedInput: { ...input, model: FALLBACK_MODEL },
  };
}
