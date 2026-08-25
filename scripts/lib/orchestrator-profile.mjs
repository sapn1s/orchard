/**
 * orchestrator-profile.mjs — FEAT-096. The orchestrator's tool surface, declared
 * ONCE, and the classification of a tool call against it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM ITS TWO CALLERS: the hook that records
 * calls and the report that counts them must not each carry their own idea of
 * what "allowed" means. ARCH-008 is on this board because a record grammar was
 * implemented twice and the two readers disagreed. One definition, two importers.
 *
 * STATUS: LOG-ONLY. Nothing in this file is wired to a deny. `ALLOWED` is not
 * enforced anywhere — it is the yardstick the log is measured against, so that
 * the question "what would this profile have broken?" is answered from a
 * recording of real work instead of from imagination. Turning it into an actual
 * restriction means writing these names into a project's
 * `settings.allowedTools` (src/server/registry.ts:191-193) and is DELIBERATELY
 * not done here.
 *
 * ── The tool names are the harness's, not the design document's ──────────────
 * docs/analysis/orchestrator-design-attack-2026-08-20.md §9 specifies the v0
 * surface as `Dispatch`, `SendMessage`, `TaskStop`. **There is no tool called
 * `Dispatch` in this harness.** Captured from a real PreToolUse payload
 * (2026-08-20): a session asked for "the Task tool" and the harness emitted
 * `tool_name: "Agent"`. A profile written against the design document's names
 * would allow a tool that does not exist and deny the one that does, and the
 * log would record 100% blocked with no bug to point at. The names below are
 * transcribed from live payloads.
 */

/**
 * The v0 surface both designs converge on: dispatch work, steer a live lane,
 * stop a live lane. Nothing that reads, writes, searches or executes.
 */
export const ALLOWED = ['Agent', 'SendMessage', 'TaskStop'];

/**
 * Deny is BY DEFAULT — anything not in ALLOWED. This list is therefore not the
 * mechanism, only documentation of the names seen in practice, so a reader can
 * tell "denied because the profile excludes it" from "denied because nobody
 * has ever seen this name". A new tool appearing here is itself a finding: it
 * means the surface grew under a profile written before it existed.
 */
export const KNOWN_DENIED = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'Monitor',
  'EnterWorktree', 'ExitWorktree', 'TodoWrite', 'ExitPlanMode', 'Artifact',
];

/** MCP tools arrive as `mcp__<server>__<tool>`; all of them are outside the surface. */
export const MCP_PREFIX = 'mcp__';

/** Would this profile have permitted this call? Log-only: nobody acts on the answer. */
export function isAllowed(toolName) {
  return ALLOWED.includes(toolName);
}

/**
 * Where a call sits, for counting. Deliberately COARSE and deliberately not a
 * verdict: the attack (§7, A-E1) requires that the buckets be assigned by
 * someone other than the design's author, so this returns a mechanical
 * category and the report prints the raw material next to it for hand-labelling.
 */
export function classify(toolName) {
  if (isAllowed(toolName)) return 'allowed';
  if (typeof toolName === 'string' && toolName.startsWith(MCP_PREFIX)) return 'denied-mcp';
  if (KNOWN_DENIED.includes(toolName)) return 'denied-known';
  return 'denied-unknown';
}

/* ── The escape channel ──────────────────────────────────────────────────────
 * The attack's §3 is the reason this half exists at all: "Denying tools by name
 * does not hold. The role can still do the work by writing the reasoning into a
 * dispatch brief and handing a lane a shell." A log that counted only blocked
 * tool NAMES would score a profile as a total success in exactly the world where
 * it changed nothing — the orchestrator stops calling Read and starts writing
 * its diagnosis into `Agent.prompt`. So the brief is measured too.
 *
 * These signals are HEURISTIC and are reported as heuristics. They cannot
 * decide whether a brief carries analysis; they rank briefs so a person can
 * read the top of the list. A brief that trips none of them is not proven
 * clean. Naming that limit is the point — an automated judgement about
 * "is this a task or a conclusion?" is exactly the unoracled claim this board
 * refuses to let wear a verified label.
 */

/** Conclusion-shaped phrasing: a brief that states findings rather than asking for them. */
const ANALYSIS_PHRASES = [
  /\bthe (?:root )?cause is\b/i,
  /\bthe bug is\b/i,
  /\bthe (?:real )?problem is\b/i,
  /\bthe fix is\b/i,
  /\bi (?:found|traced|confirmed|verified|diagnosed)\b/i,
  /\bwhat(?:'s| is) happening is\b/i,
  /\bthis (?:is|was) caused by\b/i,
  /\bbecause\b/i,
  /\bwhich means\b/i,
  /\bso the\b/i,
  /\bturns out\b/i,
  /\balready (?:checked|verified|confirmed|read)\b/i,
];

/**
 * `path/to/file.ts:123` — a citation is the residue of a read the orchestrator
 * already did, so counting them is how a brief full of findings shows up as
 * different from a brief asking for them.
 *
 * WRITTEN AS A TOKEN TEST, NOT AS ONE REGEX OVER THE WHOLE BRIEF, and that is
 * not a style choice. The obvious form — `/[\w./-]+\.(?:ts|js|…):\d+/g` — is
 * catastrophically backtracking: the leading class matches dots, so on a long
 * run of characters with no citation in it the engine retries from every
 * position. Measured before this was rewritten: 200,000 characters of `x` did
 * not finish in 20 seconds. This function runs inside a PreToolUse hook, ahead
 * of every tool call a session makes, so a brief carrying one long unbroken
 * token — a pasted path list, a stack dump, a base64 blob, a minified line —
 * would have burned a core and lost the record to the harness's hook timeout.
 * Splitting on whitespace first bounds every regex application to one short
 * token, and the pattern below has no quantifier before the literal dot.
 */
const CITATION_TAIL = /\.(?:m?[jt]sx?|py|md|json|html|css|sh):\d+/;
/** A "word" longer than this is not a file citation; skip it rather than scan it. */
const MAX_TOKEN = 200;

function countCitations(s) {
  let n = 0;
  for (const token of s.split(/\s+/)) {
    if (token.length === 0 || token.length > MAX_TOKEN) continue;
    if (CITATION_TAIL.test(token)) n++;
  }
  return n;
}

/**
 * Upper bound on how much of a brief is scanned for signals. The full length is
 * always recorded exactly; only the pattern-matching is bounded, and when it
 * bites the record says so rather than quietly under-reporting.
 */
const SCAN_LIMIT = 100_000;

/** Imperative openers: the shape of a task handed over rather than a conclusion delivered. */
const TASK_PHRASES = [
  /\b(?:investigate|find out|determine|figure out|check whether|work out|diagnose)\b/i,
  /\byour (?:job|task|charter) is\b/i,
];

/**
 * Rank one dispatch brief for how much it reads as analysis rather than a task.
 * Returns raw counts, not a verdict — the report prints them and a human reads
 * the top of the sorted list.
 */
export function briefSignals(text) {
  const full = typeof text === 'string' ? text : '';
  const s = full.length > SCAN_LIMIT ? full.slice(0, SCAN_LIMIT) : full;
  const phraseHits = ANALYSIS_PHRASES.filter((re) => re.test(s)).map((re) => re.source);
  return {
    // The true size, always — this is the number the report ranks briefs by.
    chars: full.length,
    // ~4 chars/token is the usual rough rule; used only for an order of magnitude.
    approxTokens: Math.round(full.length / 4),
    analysisPhrases: phraseHits.length,
    analysisPhraseList: phraseHits,
    citations: countCitations(s),
    taskPhrases: TASK_PHRASES.filter((re) => re.test(s)).length,
    // True when signals were counted over a prefix, so a low count can be read
    // as "not found in the first 100k" rather than as "not present".
    scanTruncated: full.length > SCAN_LIMIT,
  };
}

/**
 * A shell call that dispatches. `scripts/dispatch.mjs` is this project's
 * cross-provider boundary (FEAT-043) and it is reached THROUGH Bash — so a
 * profile that denies Bash denies cross-provider dispatch as a side effect.
 * Counting these separately is what makes that consequence visible in the data
 * rather than discovered after the deny lands.
 */
export function isDispatchViaShell(command) {
  return typeof command === 'string' && /\bdispatch\.mjs\b/.test(command);
}
