/**
 * dispatch-profiles.mjs — what a dispatch of a given SHAPE is allowed to cost.
 *
 * WHY THIS EXISTS (ARCH-010). Two launch facts were previously not declared
 * anywhere, so every dispatch silently took the most expensive default:
 *
 *   1. WHICH TOOL SCHEMAS ARE ADVERTISED. `--allowedTools` does NOT restrict —
 *      it is an auto-approve list (SDK sdk.d.ts:1368-1374, and registry.ts:277
 *      says so at length). The knob that actually shrinks the advertised set is
 *      `--tools`, and nothing in this repo has ever set it. So every dispatch
 *      pays for every built-in schema whether or not it can use them.
 *   2. WHICH CACHE TTL THE WRITES BILL AT. The CLI picks the 1-hour TTL (2.0x
 *      base input) for querySource `sdk` by default; the 5-minute TTL is 1.25x.
 *      There is no repo config and no documented flag for this — the only lever
 *      is the CLI's own `FORCE_PROMPT_CACHING_5M` env var.
 *
 * Rather than hard-code a cut (which would silently degrade every other Orchard
 * consumer — this repo serves several projects), each SHAPE of dispatch declares
 * its own answer here, once, and `scripts/dispatch.mjs` reads it. A caller that
 * names no profile gets `full`, which is byte-identical to the pre-change
 * behaviour: no `--tools`, no env override, nothing.
 *
 * ─────────────────────────────────────────────────────────── the measurements
 *
 * Every number below was measured, not estimated. Tool-schema sizes come from
 * live `claude -p` dispatches on claude-opus-5 (prefix = cache_creation +
 * cache_read + input), varying only the `--tools` flag:
 *
 *     all built-in tools, no MCP ......... 21,312 tok
 *     Bash,Read,Edit,Write,Grep,Glob ..... 12,224 tok   (-9,088)
 *     ... + Agent ........................ 13,955 tok   (-7,357; Agent = 1,731)
 *
 * Usage shape comes from the real monitor-tick corpus: 311 sessions over
 * 2026-08-29 → 2026-09-10 in the Claude CLI's own transcript store for the
 * consuming project, of which 236 produced real model turns (10,639 usage
 * blocks). Re-derive with `npm run cost:collect` rather than a path.
 *
 * ───────────────────────────────────────── why `monitor` keeps what it keeps
 *
 * The cut is driven by INVOCATION EVIDENCE over that whole corpus, not by a
 * guess about what a monitor "should" need:
 *
 *     Bash 4,520 calls / Read 122 / Edit 61 / Write 30 ... kept (obviously)
 *     Glob 0 calls ....................... kept anyway — it is allow-listed by
 *         the caller, and Grep/Glob are the documented fallback when a native
 *         build lacks them (sdk.d.ts:1420-1434). Near-zero schema cost.
 *     Agent 4 calls in 311 ticks ......... KEPT. Rare is not never: one of the
 *         four was "Restore engine service via arch002-s1 rollback" — a
 *         recovery path. A tool used once a week still needs its schema, so
 *         the 1,731 tokens are paid deliberately.
 *     ToolSearch 7 calls ................. KEPT. It is the only way to reach
 *         DEFERRED tools, and each of its 7 uses was a `select:<name>` right
 *         before a rare call — including the one Gmail-MCP escalation send.
 *         Costs 0 when nothing is deferred (measured: adding it did not move
 *         the prefix).
 *     Skill 0 calls, Workflow 0 calls .... DROPPED. Never invoked, not once.
 *     TodoWrite / WebSearch / WebFetch /
 *       NotebookEdit / Monitor / ... 0 ... DROPPED.
 *
 * MCP is deliberately NOT stripped (no `--strict-mcp-config`): the corpus
 * contains a real `mcp__claude_ai_Gmail__send_message` call used to escalate a
 * VPS outage. Suppressing MCP would have silently removed an alerting path to
 * save ~971 tokens. Not worth it.
 *
 * ───────────────────────────────────────────────── why `monitor` forces 5m
 *
 * Measured on the same corpus: 100.0000% of cache-creation tokens
 * (62,429,646 of them) billed at the 1h TTL; ZERO at 5m. The 1h premium buys
 * cross-request survival — and the corpus says it is never collected:
 *
 *   • BETWEEN ticks the cadence is hourly (median gap 59.84 min, minimum 8.27
 *     min, never under 5 min), and ticks measurably open COLD anyway — at a
 *     30-60 min gap the first request writes a median 51,780 tokens and reads
 *     only 13,380. The charter also appends a per-tick TICKFACTS block, so the
 *     cached prefix genuinely differs each tick.
 *   • WITHIN a tick — where the money actually is — 87.8% of all cache-creation
 *     is INCREMENTAL writes on subsequent requests, issued at a median 3.6
 *     SECOND cadence. Those are re-read almost immediately; a 5-minute TTL
 *     covers them completely and the 1-hour premium buys nothing at all.
 *
 * The only real risk is an intra-tick gap longer than 5 minutes, which would
 * turn one cheap read into a full cold re-write. Measured across 10,402
 * consecutive-request gaps: THREE exceed 5 minutes (0.029%), none exceeds 10
 * minutes, and p99 is 1.78 min. Tokens exposed by those three = 181,563,
 * against 62.4M cache-creation tokens repriced. In base-input equivalents that
 * is 46,822,235 saved against 208,797 risked — a 224:1 ratio, and the risk side
 * is an upper bound.
 *
 * NOT a general recommendation: `full` keeps the 1h TTL because a
 * human-driven interactive session DOES have multi-minute think-gaps where the
 * 1h entry is exactly what pays off. This is why the choice is per-profile.
 */

/**
 * The declared shapes. Adding a profile is the supported way to tune a new
 * consumer; editing `full` is not (it is every other caller's status quo).
 *
 *   tools    — exact advertised built-in set, or null to leave the CLI default
 *              untouched (no `--tools` flag emitted at all).
 *   cacheTtl — '5m' forces the cheap write multiplier, '1h' forces the
 *              expensive one, null leaves the CLI to choose.
 *   note     — prose spliced into the prompt when tools were suppressed, so a
 *              model that reaches for a missing tool is TOLD why and how to get
 *              it back, instead of hitting a bare "unknown tool".
 */
export const DISPATCH_PROFILES = {
  full: {
    description: 'Unchanged CLI defaults — every built-in tool advertised, CLI-chosen cache TTL. The default for every caller that names no profile.',
    tools: null,
    cacheTtl: null,
  },
  monitor: {
    description: 'Recurring headless monitor//factory tick: a Bash-dominated loop on a fixed cadence. Trimmed to the tools the real corpus proves it calls, and billed at the 5-minute cache TTL.',
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'ToolSearch'],
    cacheTtl: '5m',
  },
};

export const DEFAULT_PROFILE = 'full';

/** The CLI's own env knob for the cheap TTL. Undocumented in `--help`; read out of the shipped binary (v2.1.263) and confirmed live. */
export const TTL_5M_ENV = 'FORCE_PROMPT_CACHING_5M';
/** The CLI's counterpart for forcing the expensive TTL. */
export const TTL_1H_ENV = 'ENABLE_PROMPT_CACHING_1H';

/**
 * Resolve a profile name to its declaration. Unknown names are REFUSED, never
 * defaulted: silently falling back to `full` would turn a typo into a doubled
 * bill that nothing reports, which is the failure mode this module exists to
 * prevent.
 */
export function resolveProfile(name) {
  const key = name ?? DEFAULT_PROFILE;
  const profile = DISPATCH_PROFILES[key];
  if (!profile) {
    const known = Object.keys(DISPATCH_PROFILES).join(' | ');
    throw new Error(`unknown dispatch tool-profile ${JSON.stringify(key)} — known profiles: ${known}`);
  }
  return { name: key, ...profile };
}

/**
 * The env overlay a profile implies. Returned as a plain object so the caller
 * can merge it into the child env explicitly rather than mutating process.env —
 * this must never leak into a sibling dispatch in the same process.
 */
export function profileEnv(profile) {
  if (profile.cacheTtl === '5m') return { [TTL_5M_ENV]: '1' };
  if (profile.cacheTtl === '1h') return { [TTL_1H_ENV]: '1' };
  return {};
}

/**
 * THE LOUD-FAILURE HALF, and the reason this is not just a flag.
 *
 * A suppressed tool cannot fail at CALL time — it is absent from the schema, so
 * there is no call to intercept and nothing to raise. The failure has to be made
 * legible BEFORE the model reaches for it. So when a profile trims the tool set
 * we state, in the prompt, exactly which capability classes were withheld and
 * the exact flag that restores them. A future session that needs `Skill` then
 * reads a sentence naming its own constraint instead of spending an hour on a
 * mystery, and can say so in its final message.
 *
 * Returns null when nothing was suppressed (profile `full`), so the default
 * path adds not one token.
 */
export function profileNotice(profile) {
  if (!profile.tools) return null;
  return [
    `Tooling note (Orchard dispatch profile \`${profile.name}\`): this run advertises a REDUCED tool set —`,
    `${profile.tools.join(', ')} — plus any configured MCP tools. Other built-in tools (including Skill,`,
    'Workflow, TodoWrite, WebSearch, WebFetch and NotebookEdit) were deliberately withheld to cut prompt cost,',
    'because this dispatch shape has never invoked them. This is a declared constraint, NOT a malfunction, and',
    'NOT a permission refusal — do not retry, and do not work around it silently.',
    '',
    'If you genuinely need a withheld tool: do the task without it if you can, then say so plainly in your final',
    'message, naming the tool and what it was for. The fix is one flag on the dispatch command —',
    '`--tool-profile full` restores the complete tool set — and the profile table lives in',
    '`scripts/lib/dispatch-profiles.mjs` in the Orchard checkout.',
  ].join('\n');
}
