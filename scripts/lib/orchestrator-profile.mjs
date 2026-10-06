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

/* ═══════════════════════════════════════════════════════════════════════════
 * ENFORCEMENT (FEAT-096 phase 2) — the policy, declared once, decided once.
 *
 * Everything above this line is the LOG-ONLY yardstick and is unchanged. What
 * follows is the part that can say "no", and it exists because two attempts to
 * get this behaviour out of instructions did not get it: the Working Agreement
 * §I inline-work threshold is delivered in full to every registered project
 * (verified 2026-08-25 by composing the real system prompt for kenimai-website
 * — 36,687 chars, threshold text present), and a fresh session in that project
 * still opened with a tree-wide `grep` and made 17 Bash calls without one
 * dispatch. The text arrives. The text is not enough.
 *
 * ── Why this is NOT `allowedTools` / `disallowedTools`, which is what the
 *    FEAT-096 ticket and this file's own header said to use ────────────────
 *
 * Both are wrong, for two independently fatal reasons, each PROVEN live on
 * 2026-08-25 rather than argued:
 *
 * 1. `allowedTools` DOES NOT RESTRICT. The SDK is explicit
 *    (sdk.d.ts:1368-1374): it is an auto-approve list — "to restrict which
 *    tools are available, use the `tools` option instead". Under
 *    `permissionMode: 'bypassPermissions'`, which is what dispatched lanes run
 *    under, an allow list changes nothing whatsoever. Writing the profile into
 *    `settings.allowedTools` would have shipped a no-op that looked enforced.
 *
 * 2. `disallowedTools` LEAKS ONTO SUBAGENTS. A probe ran a session with
 *    `disallowedTools: ['Bash']` and asked it to dispatch a general-purpose
 *    subagent whose only job was to run `echo`. The subagent reported, in its
 *    own words, that "the Bash tool was not available in my toolset" and that
 *    `ToolSearch` with `select:Bash` returned no match. The option is
 *    process-wide; a dispatched worker would lose its toolset, which is the
 *    one thing this must not break.
 *
 *    And in the same run the subagent ROUTED AROUND THE DENY UNPROMPTED: it
 *    searched for a shell, found `Monitor`, and executed the command through
 *    it. So a name-based deny on `Bash` is not merely harmful, it is unsound —
 *    `Monitor` is a shell under another name. That is attack §3's escape
 *    channel demonstrated in a single turn by a model nobody told to evade
 *    anything.
 *
 * The only enforcement point in this harness that can tell an orchestrator's
 * call from its lane's is a `PreToolUse` hook: `agent_id` is "present only when
 * the hook fires from within a subagent … Absent for the main thread"
 * (sdk.d.ts:174-176). `canUseTool` carries no agent identity at all (its
 * options are signal/suggestions/blockedPath/decisionReason/title/…), so the
 * runtime's existing approval callback cannot be used for this. A PreToolUse
 * deny also short-circuits ahead of `canUseTool` and holds under
 * `bypassPermissions` (sdk.d.ts:4166).
 *
 * ── Why the deny list is shaped the way it is ────────────────────────────────
 *
 * Derived from measured behaviour, not from the design documents:
 * docs/analysis/orchestrator-surface-retroactive-2026-08-20.md (2,412 real
 * calls) plus the live recorder log and the project transcript store. Sixteen
 * distinct tool names have ever been emitted here. Three consequences:
 *
 * - `Bash` is NOT denied wholesale. 63% of the orchestrator's refused Bash was
 *   board bookkeeping and 23% was `npm run gate` — and the Working Agreement
 *   REQUIRES the gate before a commit. A blanket Bash deny does not restrict
 *   the orchestrator, it makes the orchestrator non-compliant, and it removes
 *   this project's only route to a non-Claude provider (FEAT-043,
 *   `scripts/dispatch.mjs`, reached through Bash). Bash is instead decided per
 *   command head, default-deny with an allow list, so `npm run gate` and
 *   `git commit` survive and `grep -rn` does not.
 * - `Edit` and `Write` are ALLOWED. Not one refused Write or Edit in the
 *   measured orchestrator window touched product code; all 22 were tickets,
 *   INDEX rows, analysis docs and memory. Denying them would break board work
 *   to prevent something that is not happening. Revisit when a board tool
 *   exists (retroactive §3).
 * - `AskUserQuestion`, `TaskCreate`, `TaskUpdate` and `Workflow` are ALLOWED
 *   and were the four names missing from `KNOWN_DENIED` entirely. Denying
 *   `AskUserQuestion` would stop a session asking its user anything, which is
 *   the opposite of the point.
 *
 * The residue this actually denies is what the analysis named as the honest
 * target: ad-hoc search across the tree, reading files, reading lane output.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Tools the orchestrator role keeps: dispatch, steer, ask, track, and write its
 * own board artifacts. Transcribed from names this harness has actually
 * emitted, plus the Task* verbs the SDK advertises that are orchestration by
 * definition. Anything absent is denied WITH A REASON — see `decide()`; there
 * is no silent removal, because a tool that vanishes teaches nothing.
 */
export const ENFORCE_ALLOWED_TOOLS = [
  // Dispatch and lane control — the whole point of the role.
  'Agent', 'SendMessage', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  // Lane LIVENESS, which is lane control's missing read half (BUG-226). ListAgents
  // (the SDK's `ListPeers`) lists the dispatched lanes with their busy/idle status —
  // names and state, no tree reading — and WA §C REQUIRES confirming a lane is alive
  // from ground truth before treating it as dead or re-dispatching. It was never
  // NAMED in this allowlist, so it fell to default-deny: an allowlist gap, not a
  // decision. Dispatch + steer + stop a lane were all here; checking whether the
  // lane is still running was the one orchestration verb left out.
  'ListAgents',
  // Talking to the user. Denying this was the retroactive analysis's flagged bug.
  'AskUserQuestion',
  // Orchestration surface that carries no read: plans, todos, skills, workflows.
  'Workflow', 'Skill', 'TodoWrite', 'ExitPlanMode', 'ToolSearch',
  // Board bookkeeping — see the header. Product code is not what these touch.
  'Edit', 'Write',
  // Decided per command, not per name.
  'Bash',
];

/**
 * Bash command HEADS the orchestrator keeps. Default-deny is deliberate and is
 * the safe direction here: an unknown command is refused with a message that
 * names the alternative, which costs one dispatch, whereas an unbounded
 * deny-list silently admits every verb nobody thought of. Derived from the
 * purpose table in the retroactive analysis §2 — gate, board, git, status.
 */
export const ENFORCE_ALLOWED_BASH = [
  // `npx` is DELIBERATELY not here (BUG-226 round 3). It was listed, but
  // ENFORCE_HEAD_ARG_RULES.npx refuses `npx <anything>` UNCONDITIONALLY — so the
  // allowlist (said "allowed") and the arg rule (said "always refused") were two
  // owners of the Bash verdict disagreeing, and the "Still available here" line
  // read the allowlist and advertised a head that is never usable. A head with
  // ZERO allowed shapes does not belong in an allowlist. Removing it is inert at
  // runtime (the arg rule still refuses `… | npx foo` in a filter stage, where
  // the stage-0 allowlist check is skipped); it only stops the false advertisement.
  'npm', 'node',                   // gate, board:gen/check/tool, dispatch.mjs, verifiers
  'git',                           // its own commits (minus the content-dumping subcommands below)
  'systemctl', 'ss', 'curl', 'docker', // service and port status
  'date', 'pwd', 'which', 'echo', 'mkdir', 'true', 'false', 'test', '[', '[[',
  // Navigation and control, which read nothing. `cd <repo>;` prefixes almost
  // every real orchestrator command — see decideBashCommand's note.
  'cd', 'set', 'export', 'printf', 'wait', 'sleep', 'uptime',
  // File MOVEMENT, which puts nothing in the model's context — the orchestrator
  // backs up INDEX.md before a board:gen. `rm` is deliberately NOT here: it is
  // not needed for board work and is not a read, so it can be dispatched.
  'cp', 'mv', 'touch', 'chmod', 'mkdir',
];

/**
 * `git` is ALLOW-KNOWN-GOOD, default-deny (BUG-226 round 4). A deny-list of
 * "bad" subcommands was leaky three times over: round-3's clean room proved
 * `git -c core.pager=cat show HEAD:<file>` read any blob (the `-c k=v` pair was
 * consumed as the subcommand so `show` was never seen), and `git stash show -p`,
 * `git whatchanged`, `git ls-files`, `git ls-tree` all slipped the same way. A
 * deny-list admits every reader nobody enumerated; an allow-list fails SAFE —
 * an unlisted subcommand is refused (and the refusal names dispatch), so a
 * content/tree reader we never thought of cannot read.
 *
 * The set is the orchestrator's REAL git surface (corpus of 574 Bash calls):
 * status/log/commit/diff/add/branch/rev-parse/remote/push/checkout/worktree/
 * rev-list/bundle, plus the sibling status reads and the write/management verbs
 * that emit NO tracked-file content (git-write-policy is their real gate, and it
 * runs BEFORE decide()). The readers/dumpers — show, grep, blame, cat-file,
 * ls-files, ls-tree, whatchanged, archive, format-patch, stash, notes, reflog,
 * config — are DELIBERATELY ABSENT, so default-deny refuses them. `log` and
 * `diff` are allowed only in content-free forms (see the flag gate below).
 */
export const GIT_ALLOWED_SUBCOMMANDS = [
  // status / ref reads — no tracked-file content
  'status', 'rev-parse', 'rev-list', 'branch', 'remote', 'symbolic-ref', 'show-ref',
  'for-each-ref', 'merge-base', 'describe', 'name-rev', 'var', 'ls-remote',
  'check-ignore', 'shortlog', 'count-objects',
  // read-shaped, allowed ONLY in content-free forms — see GIT_CONTENT_FLAG / diff gate
  'log', 'diff',
  // writes / management: mutate the tree, do not DUMP tracked content into context;
  // git-write-policy is their actual gate and runs ahead of this one.
  'commit', 'add', 'push', 'fetch', 'pull', 'checkout', 'switch', 'restore', 'reset',
  'merge', 'rebase', 'cherry-pick', 'revert', 'worktree', 'bundle', 'tag', 'clean', 'mv', 'rm',
];

/**
 * git GLOBAL options that take a VALUE in the NEXT token (not `=`-joined), so the
 * subcommand resolver must skip two tokens, not one. `-c name=value` is the one
 * round-3 defeated — the resolver read `name=value` as the subcommand. The rest
 * are the other value-taking globals that could shield a real subcommand the
 * same way (`git -C <dir> show HEAD:x`, `git --git-dir <dir> show …`).
 */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env',
]);

/**
 * Flags that make `git log`/`git diff` EMIT A DIFF/PATCH or run a content search —
 * i.e. print tracked-file content or hunt it. Scoped to log/diff so it cannot
 * collide with same-spelled flags on other verbs (`git commit -S` = GPG-sign).
 */
const GIT_CONTENT_FLAG = (w) =>
  w === '-p' || w === '-u' || w === '--patch' || /^--patch-with-/.test(w) ||
  w === '-U' || /^-U\d/.test(w) || /^--unified(?:=|$)/.test(w) ||
  w === '-W' || w === '--function-context' ||
  /^--word-diff(?:=|$)/.test(w) || /^--color-words(?:=|$)/.test(w) ||
  w === '-G' || /^-G./.test(w) || w === '-S' || /^-S./.test(w) || /^-L/.test(w);

/**
 * `git diff` prints full file content UNLESS it carries a summary-only flag. The
 * orchestrator's real diff usage is all `--stat`/`--numstat`/`--name-only`/
 * `--shortstat`/`--cached --name-only`; bare `git diff <path>` is a content dump
 * that belongs in a dispatched lane.
 */
const GIT_DIFF_SUMMARY_FLAG = (w) =>
  /^--stat(?:=|$)/.test(w) || w === '--numstat' || w === '--shortstat' || w === '--summary' ||
  w === '--name-only' || w === '--name-status' || w === '--compact-summary' ||
  /^--dirstat(?:=|$)/.test(w) || w === '--raw' || w === '--check' || w === '--quiet' ||
  w === '--exit-code' || w === '--cumulative';

/**
 * Resolve the REAL git subcommand past any leading global options, so a `-c k=v`
 * (or `-C <dir>`, `--git-dir <dir>`, …) pair cannot shield it (BUG-226 round 4).
 * `words[0]` is `git`. Returns '' when there is no subcommand (`git`,
 * `git --version`) — harmless, allowed.
 */
export function resolveGitSubcommand(words) {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith('-')) return w;        // first bare token is the subcommand
    if (w === '--') { i += 1; continue; }    // end-of-options marker; keep scanning
    // A value-taking global in its space-separated form consumes the NEXT token.
    if (!w.includes('=') && GIT_GLOBAL_VALUE_OPTS.has(w)) { i += 2; continue; }
    i += 1;                                   // a flag (or `--opt=value`): skip one
  }
  return '';
}

/** The offender string for a refused git command, or null to allow. Applied at EVERY stage. */
function gitArgRule(words) {
  const sub = resolveGitSubcommand(words);
  if (!sub) return null;                                   // bare `git` / `git --version`
  if (!GIT_ALLOWED_SUBCOMMANDS.includes(sub)) return `git ${sub}`;
  if (sub === 'log' || sub === 'diff') {
    if (words.some(GIT_CONTENT_FLAG)) return `git ${sub} -p`;
    if (sub === 'diff' && !words.some(GIT_DIFF_SUMMARY_FLAG)) return 'git diff (no --stat)';
  }
  return null;
}

/**
 * Shell separators that start a NEW command (as opposed to `|`, which chains one
 * command's stdout into the next — handled separately below, because the two
 * mean different things for a read policy).
 *
 * A single Bash call in this project carries more than one purpose 90% of the
 * time (median 2 lines, max 187), so deciding on the FIRST word of the whole
 * string would let `echo hi; grep -rn secret /` through on the strength of the
 * `echo`. Every pipeline is decided independently and the call is refused if
 * ANY of them is.
 */
const COMMAND_SPLIT = /(?:\|\||&&|[;\n&])+/;

/** Leading `VAR=value` assignments to skip past when finding a command head. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Shell keywords and no-op prefixes that are not themselves commands. `if npm
 * run gate` must be decided as `npm`, not refused as `if`. Stripped, not
 * skipped — the real command follows on the same segment.
 */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'time', 'command', 'nohup', 'builtin', '!', '{', '}',
]);

/**
 * Re-entrant execution. These take arbitrary code or an arbitrary command as
 * DATA, so allowing one anywhere in a pipeline would hand back everything the
 * policy just refused (`git status | xargs cat`, `sh -c 'grep -rn …'`). Refused
 * at EVERY pipeline stage, including stages that would otherwise be filters.
 */
const EXEC_VERBS = new Set([
  'xargs', 'sh', 'bash', 'zsh', 'ksh', 'dash', 'eval', 'source', '.', 'exec',
  'sudo', 'ssh', 'python', 'python3', 'perl', 'ruby', 'php', 'env',
]);

/**
 * ARGUMENT rules for heads that are allowed but can be TALKED INTO A READ.
 *
 * FOUND LIVE, NOT IMAGINED (FEAT-096 phase 3). With the profile enabled on this
 * repo's own project, a session was refused `ls -1 <repo>` and — with nobody
 * suggesting it — came back with:
 *
 *   node -e "const f=require('fs').readdirSync('<repo>');console.log(f.join(' '))"
 *
 * and read the tree anyway. That is attack §3's escape channel again: deciding
 * on the command HEAD alone is not enough when the head takes code as data.
 * `node -e`, `npx <anything>`, `npm exec`, `docker run … cat`, `systemctl cat`,
 * `curl file://` and `cp <file> /dev/stdout` are all `cat` wearing an allowed
 * name.
 *
 * MEASURED BEFORE TIGHTENING, against the real transcript corpus (239 Bash
 * calls since 2026-08-18), so this is a cost that was checked rather than
 * assumed: `npx` 0, `npm exec` 0, `curl file://` 0, `docker run|exec|cp` 0,
 * `systemctl cat` 0, `cp|mv` to a std stream 0 — and the only two real `node -e`
 * calls in the whole corpus were THE ESCAPE ABOVE. Everything the orchestrator
 * actually does with these heads keeps working: `systemctl --user show|status|
 * list-units`, `docker ps`, `curl http://127.0.0.1:…`, `npm run gate`,
 * `node scripts/leak-gate.mjs`.
 *
 * Each rule returns an offender string to refuse with, or null to allow. They
 * are applied at EVERY pipeline stage, like EXEC_VERBS, because a filter stage
 * that can eval is a filter stage that can read.
 */

/** Words that make `node` an evaluator rather than a script runner. */
const NODE_EVAL_FLAG = /^(?:-{1,2}(?:e|p|print|eval)(?:=.*)?|-[A-Za-z]*[ep][A-Za-z]*|--input-type(?:=.*)?)$/;
/** A word that looks like the script `node` was asked to run. */
const SCRIPT_ARG = /\/|\.[cm]?[jt]sx?$/;
/** Destinations that turn a copy into a print. */
const STD_STREAM = /^(?:\/dev\/(?:stdout|stderr|fd\/)|\/proc\/self\/fd\/)/;

/**
 * `systemctl`/`docker`/`npm` subcommand: the first argument that is not a flag.
 *
 * Deliberately does NOT try to skip a flag's VALUE. The first draft did, and it
 * read `systemctl --user cat <unit>` as "`--user` takes the value `cat`" and
 * allowed a unit-file dump straight through. Every real invocation in the
 * corpus puts the subcommand before any value-taking flag
 * (`systemctl --user show <unit> -p X --value`, `docker ps --filter name=…`,
 * `npm run gate`), so the simpler rule is both correct on the real traffic and
 * safe in the direction it errs.
 */
function subcommandOf(words) {
  return words.slice(1).find((w) => !w.startsWith('-')) ?? '';
}

const DOCKER_STATUS_SUBCOMMANDS = ['ps', 'images', 'image', 'inspect', 'stats', 'version', 'info', 'top', 'port'];

/**
 * curl is kept for one real purpose (corpus: 14 calls, ALL to `127.0.0.1:4317`):
 * confirming a LOCAL dev server's health. So it is localhost-only. The read holes
 * curl opens are (a) `file:` (and other local-file schemes) — the round-3 break —
 * and (b) a `-K <file>` config read that can itself redirect curl to `file:`. Both
 * are refused. A non-local host is refused too (the charter: http(s) to localhost
 * only). SSRF/exfil over http is not the profile's stated guarantee, but locality
 * costs nothing to enforce and the orchestrator never needs a remote fetch.
 */
const CURL_LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;
/** Any non-http(s) URL scheme followed by a slash — file:/, ftp://, gopher:/, scp:/, … */
const CURL_BAD_SCHEME =
  /(?:^|[\s"'=(])(?:file|ftp|ftps|gopher|gophers|dict|ldap|ldaps|scp|sftp|smb|smbs|tftp|telnet|imaps?|pop3s?|smtps?|rtsp|rtmps?|mqtt|wss?):\/+/i;

/**
 * curl safety on the RAW command region (quotes intact), because the per-stage
 * parser runs AFTER stripQuotedAndComments — a QUOTED `curl "file:/etc/passwd"`
 * would otherwise blank to `curl ` and be allowed while the real shell still reads
 * the file. Scans each `curl … (up to the next shell separator)` region. Returns an
 * offender or null. Exported for the enforcement suite's decider probes.
 */
export function curlRawViolation(raw) {
  const text = typeof raw === 'string' ? raw : '';
  for (const m of text.matchAll(/\bcurl\b([^|;&\n]*)/gi)) {
    const region = m[1];
    if (CURL_BAD_SCHEME.test(region)) return 'curl non-http scheme';
    // A config-file read (`-K`/`--config <file>`) can carry its own `url=file:/…`.
    if (/(?:^|\s)(?:-K|--config)(?:\s|=|$)/.test(region)) return 'curl -K (config file read)';
    // http(s):// host must be local (host ends at / : whitespace or a closing quote).
    for (const h of region.matchAll(/https?:\/\/([^/:\s"')\]]+)/gi))
      if (!CURL_LOCAL_HOST.test(h[1])) return 'curl to a non-local host';
    // A scheme-less host.tld / bare-IP target must be local too. Path segments
    // (preceded by `/`) are excluded by requiring a leading separator/quote.
    for (const t of region.matchAll(/(?:^|[\s"'=])((?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?=[/?"'\s]|$)/gi))
      if (!CURL_LOCAL_HOST.test(t[1])) return 'curl to a non-local host';
  }
  return null;
}

const ENFORCE_HEAD_ARG_RULES = {
  node(words) {
    if (words.some((w) => NODE_EVAL_FLAG.test(w))) return 'node -e';
    const args = words.slice(1);
    if (args.some((w) => !w.startsWith('-') && SCRIPT_ARG.test(w))) return null;
    if (args.length && args.every((w) => w === '--version' || w === '-v')) return null;
    // No script to run: a REPL, a `node -`, or a heredoc-fed program. The
    // heredoc body is cut off as DATA before this point, so without this the
    // whole program would be invisible to the policy.
    return 'node (stdin)';
  },
  npm(words) {
    const sub = subcommandOf(words);
    return sub === 'exec' || sub === 'x' ? `npm ${sub}` : null;
  },
  npx: () => 'npx',
  docker(words) {
    const sub = subcommandOf(words);
    return sub && !DOCKER_STATUS_SUBCOMMANDS.includes(sub) ? `docker ${sub}` : null;
  },
  systemctl(words) {
    const sub = subcommandOf(words);
    return sub === 'cat' ? 'systemctl cat' : null;
  },
  curl(words) { return curlRawViolation(words.join(' ')); },
  // git is ALLOW-KNOWN-GOOD (BUG-226 round 4). As a per-head arg rule it is decided
  // at EVERY pipeline stage, so `npm run gate | git show HEAD:x` cannot leak a read in
  // a filter position (the old inline git block decided stage 0 only).
  git(words) { return gitArgRule(words); },
  cp(words) { return words.slice(1).some((w) => STD_STREAM.test(w)) ? 'cp to a std stream' : null; },
  mv(words) { return words.slice(1).some((w) => STD_STREAM.test(w)) ? 'mv to a std stream' : null; },
};

/**
 * The command head of one shell segment: the first bare word that is neither an
 * environment assignment nor a shell keyword. Returns '' when the segment holds
 * no command (trailing separators and bare `fi`/`done` are common and are not
 * commands).
 */
export function bashSegmentHead(segment) {
  return bashSegmentWords(segment)[0] ?? '';
}

/**
 * The same segment, as the head followed by its ARGUMENTS — which is what the
 * head-argument rules above need. Returned as one array (head at index 0) so
 * there is exactly one place that decides where a segment's command begins;
 * `bashSegmentHead` is now a view onto this rather than a second parser
 * (ARCH-008 — a grammar implemented twice is two grammars).
 */
export function bashSegmentWords(segment) {
  const words = String(segment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || SHELL_KEYWORDS.has(words[i]))) i++;
  const rest = words.slice(i);
  if (!rest.length) return [];
  // A path-qualified invocation is still that command: /usr/bin/grep is grep.
  let head = rest[0];
  if (head.includes('/') && !head.startsWith('-')) head = head.slice(head.lastIndexOf('/') + 1);
  return [head, ...rest.slice(1)];
}


/**
 * Blank out quoted spans and comments in one left-to-right pass.
 *
 * NOT two regexes. Running `/'[^']*'/` and `/"…"/` independently mis-pairs the
 * moment a double-quoted string contains an apostrophe — and the real corpus
 * has them, because the orchestrator writes commit messages like
 * `-m "…the clean room's contamination strip…"`. The apostrophe opened a bogus
 * single-quoted span that swallowed the closing double quote, and the message
 * prose leaked back out as shell verbs. A scanner that honours whichever quote
 * opened FIRST is the only thing that gets this right.
 */
function stripQuotedAndComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += ' '; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      // An UNTERMINATED quote runs to end of input — treat the remainder as
      // data rather than as commands. Refusing to guess is safe here: the
      // enclosing decide() still has every earlier segment to judge.
      if (close < 0) { out += ' '; break; }
      out += ' ';
      i = close + 1;
      continue;
    }
    if (ch === '#' && (out === '' || /\s/.test(src[i - 1] ?? ' '))) {
      const nl = src.indexOf('\n', i);
      if (nl < 0) { out += ' '; break; }
      out += ' ';
      i = nl;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Decide one Bash command. Returns `{ allow, offender }` where `offender` is the
 * command head that caused a refusal, so the message can name it instead of
 * saying "denied".
 *
 * ── Why a pipeline's first stage is decided differently from its later ones ──
 *
 * Graded against the REAL orchestrator's 188 refused Bash calls rather than
 * against invented examples, and two things fell out that no fixture of mine
 * would have contained:
 *
 * 1. A `cd <repo-root>; …` prefix heads almost every real command. `cd`
 *    reads nothing; refusing it would have refused essentially the whole corpus
 *    for the wrong reason, including `npm run gate`.
 * 2. `git status --porcelain | head -5` is a status check, not a file read. The
 *    read — if there is one — happens at the FIRST stage of a pipeline; later
 *    stages consume the previous stage's stdout. Refusing `head` wherever it
 *    appears would have refused the gate-and-commit cluster the profile
 *    deliberately keeps, while `head -50 src/foo.ts` is refused anyway because
 *    at stage one `head` is not an allowed command head.
 *
 * So: stage one is decided by the allow list; later stages are filters and are
 * allowed EXCEPT re-entrant execution (EXEC_VERBS), which would otherwise be a
 * hole straight through the policy.
 */
export function decideBashCommand(command) {
  const cmd = typeof command === 'string' ? command : '';
  // A heredoc body is DATA, not commands — but the line that opens it is still a
  // command and is decided normally. Cutting at the first heredoc marker keeps an
  // embedded script's contents from being read as shell verbs.
  const heredoc = cmd.search(/<<-?\s*'?"?[A-Za-z_]/);
  /*
   * Strip redirections BEFORE splitting, or `2>&1` is torn in half by the `&`
   * in COMMAND_SPLIT and its orphaned `1` is read as a command head. Graded
   * against the real corpus, that single defect refused
   * `npm run board:gen >/dev/null 2>&1; npm run gate >/dev/null 2>&1` — the
   * gate-and-commit cluster this policy exists to KEEP. A redirection names a
   * destination, never a command, so removing it cannot hide one.
   */
  const decidable = (heredoc >= 0 ? cmd.slice(0, heredoc) : cmd)
    .replace(/\d*>>?&?\d*\s*|\d*<&?\d*\s*/g, ' ');

  /*
   * Command substitution is a command. `echo "$(grep -rn secret /)"` has `echo`
   * as its head and would otherwise sail through on the strength of it — the
   * real orchestrator writes exactly this shape
   * (`echo "service up: $(systemctl --user show …)"`), so it is not a
   * hypothetical. Substitution bodies are decided by the same rules, then the
   * substitution is blanked out so its contents are not also read as arguments.
   */
  const subs = [];
  let flattened = decidable
    .replace(/\$\(([^()]*)\)/g, (_m, body) => { subs.push(body); return ' '; })
    .replace(/`([^`]*)`/g, (_m, body) => { subs.push(body); return ' '; });
  for (const body of subs) {
    const inner = decideBashCommand(body);
    if (!inner.allow) return inner;
  }

  /*
   * QUOTED SPANS ARE DATA. This is the defect the real corpus found that no
   * fixture of mine contained, and it was the worst one: the orchestrator's own
   * board commits carry MULTI-LINE commit messages —
   *
   *   git commit -m "board: add INDEX rows for BUG-119 and BUG-120
   *
   *   Two tickets were filed with no index row, so board:check reported drift.
   *   …"
   *
   * — and because the splitter treats a newline as a command separator, the
   * prose of the message was being read as shell verbs. `Two`, `The`,
   * `Verification`, `Co-Authored-By:` were all reported as refused commands.
   * That would have refused the single most common thing the orchestrator does.
   * Substitutions are pulled out ABOVE this line, so blanking quotes here cannot
   * hide a command: `"$(grep …)"` has already been decided.
   */
  const quotedFlattened = flattened;   // quotes still intact — the curl raw guard needs them
  flattened = stripQuotedAndComments(flattened);

  let curlIsAHead = false;
  for (const pipeline of flattened.split(COMMAND_SPLIT)) {
    const stages = pipeline.split('|');
    for (let i = 0; i < stages.length; i++) {
      const words = bashSegmentWords(stages[i]);
      const head = words[0] ?? '';
      if (!head) continue;
      if (head === 'curl') curlIsAHead = true;
      // Re-entrant execution is refused at any depth.
      if (EXEC_VERBS.has(head)) return { allow: false, offender: head };
      /*
       * Head-argument rules are checked at EVERY stage too, for the same reason:
       * `git status | node -e "…readFileSync…"` is a read, and its head sits in
       * a filter position where stage-0 reasoning does not apply. `git` is an arg
       * rule now (BUG-226 round 4), so a git content/tree read is caught in a
       * filter stage too — not just at stage 0.
       */
      const argRule = ENFORCE_HEAD_ARG_RULES[head];
      if (argRule) {
        const offender = argRule(words);
        if (offender) return { allow: false, offender };
      }
      // Later stages are stdout filters; the read was already decided at stage 0.
      if (i > 0) continue;
      if (!ENFORCE_ALLOWED_BASH.includes(head)) return { allow: false, offender: head };
    }
  }
  /*
   * curl's URL argument is often QUOTED, and the per-stage parse above runs on the
   * quote-STRIPPED text — so a quoted `curl "file:/etc/passwd"` blanks to `curl `
   * and the arg rule sees no target, while the real shell still reads the file.
   * Re-check curl against the quotes-intact text here to close that (BUG-226 r4).
   */
  if (curlIsAHead) {
    const offender = curlRawViolation(quotedFlattened);
    if (offender) return { allow: false, offender };
  }
  return { allow: true, offender: null };
}

/**
 * The two fixed, GENERIC command shapes the advertiser probes each allowed head
 * with. NOT a per-head invocation table (that would be a THIRD owner of the Bash
 * verdict — ARCH-010); these are two questions asked of the ONE authority,
 * `decideBashCommand`. A bare head answers for everything with no arg rule; the
 * `./x.mjs` shape is what distinguishes a head that is only usable WITH a script
 * (`node` — bare `node` is refused as `node (stdin)`, `node ./x.mjs` is allowed)
 * from one with no allowed shape at all (`npx` — refused both ways). (BUG-226 r3.)
 */
const BASH_HEAD_PROBES = (head) => [head, `${head} ./x.mjs`];

/**
 * The Bash command heads worth ADVERTISING, derived by asking `decideBashCommand`
 * itself rather than re-reading one of its two declarations (ENFORCE_ALLOWED_BASH
 * and ENFORCE_HEAD_ARG_RULES). A head is advertised iff the decider allows at
 * least one of its probe shapes — so a head that is allowlisted but refused for
 * every argument (the `npx` contradiction) is automatically excluded, and the
 * advertiser can never name something the decider denies (BUG-226 round 3, the
 * single-authority fix for the Bash half). Errs toward UNDER-advertising, which
 * is the safe direction: the invariant is "never claim a denied command".
 */
export function allowedBashHeads() {
  return [...new Set(ENFORCE_ALLOWED_BASH)].filter((head) =>
    BASH_HEAD_PROBES(head).some((probe) => decideBashCommand(probe).allow),
  );
}

/**
 * The advertised heads that carry an argument rule — i.e. are allowed in some
 * forms but refused when talked into a read. Intersected with `allowedBashHeads()`
 * so a head that is NOT advertised (e.g. `npx`, whose arg rule refuses everything)
 * can never be named as "restricted", which would imply some shape of it works
 * (BUG-226 round 3, finding 4).
 */
export function restrictedBashHeads() {
  const advertised = new Set(allowedBashHeads());
  return Object.keys(ENFORCE_HEAD_ARG_RULES).filter((h) => advertised.has(h));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ORCH-BYPASS (FEAT-152) — the deliberate, audited inline escape hatch.
 *
 * The profile removes inline reading/searching/executing because that work
 * belongs in a dispatched lane. But sometimes the orchestrator genuinely needs
 * a command's OUTPUT in its OWN context — a status line, a count, one short
 * file that is the direct input to its very next decision — and dispatching a
 * lane only to relay that exact value back is pure ceremony. This is the
 * sanctioned way to do that, on three conditions the user set: the marker
 * carries a REAL reason, every use is LOGGED, and the criteria live in the
 * denial text itself so the model reads them at the wall.
 *
 * WHY A FIRST-LINE SHELL COMMENT. `# ORCH-BYPASS: <reason>` on the FIRST line is
 * ignored by bash as a comment, so nothing has to strip it before the command
 * runs. The marker MUST be the first line: a trailing `echo x # ORCH-BYPASS: …`
 * is a comment on some other command and must NOT open the hatch, or the hatch
 * becomes a way to smuggle a read past the profile behind a harmless-looking head.
 *
 * PURITY. Detection here is pure — it returns a verdict, it does not log. The
 * ledger write + running count are the hook's job (claude-runtime.ts), for the
 * same reason `decide()` is pure: the enforcement point owns the side effects,
 * the policy owns the decision (ARCH-008 — one definition, two importers).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The marker, and only on the first line. Capture group 1 is the raw reason. */
const BYPASS_FIRST_LINE = /^\s*#\s*ORCH-BYPASS:\s*(.*)$/;
/** A reason floor: enough to describe WHY, not just "need it" (7 chars). */
const BYPASS_MIN_REASON = 15;

/**
 * The rules — replayed in the denial text, so kept tight. When ORCH-BYPASS is
 * appropriate, and (the longer list) when it is not.
 */
const BYPASS_CRITERIA = [
  'Deliberate escape hatch (ORCH-BYPASS): if you need this command\'s OUTPUT as the',
  'direct input to your very NEXT decision, it is small (a status line, a count, one',
  'short file you will act on), and dispatching a lane would only relay that exact',
  'value straight back to you — prefix the command\'s FIRST line with a shell comment:',
  '    # ORCH-BYPASS: <why this output must land in THIS session>',
  `The reason is REQUIRED (>= ${BYPASS_MIN_REASON} chars). Every bypass is logged with its reason`,
  'and reviewed, and a running count is shown. NOT for: searching or exploring, reading',
  'code to understand it, running tests/builds/verification, anything you would then',
  'summarise, or anything that is a ticketed change.',
];

/**
 * Is this Bash command invoking the escape hatch? PURE — returns a verdict only.
 *   { present:false }                       — no marker on the first line
 *   { present:true, valid:false, problem }  — marker present, reason missing/short
 *   { present:true, valid:true,  reason }   — marker present with a usable reason
 */
export function detectOrchBypass(command) {
  const cmd = typeof command === 'string' ? command : '';
  // Only the FIRST line. `split('\n', 1)` bounds this to the first line no matter
  // how long the rest of the command is.
  const firstLine = cmd.split('\n', 1)[0] ?? '';
  const m = BYPASS_FIRST_LINE.exec(firstLine);
  if (!m) return { present: false };
  const reason = m[1].trim();
  if (reason.length < BYPASS_MIN_REASON) {
    return {
      present: true,
      valid: false,
      reason,
      problem: `the reason is ${reason.length === 0 ? 'missing' : `too short (${reason.length}/${BYPASS_MIN_REASON} chars)`}`,
    };
  }
  return { present: true, valid: true, reason };
}

/**
 * The denial for a marker that is present but unusable. Names the problem, shows
 * the shape, and carries the same criteria as every other refusal.
 */
function invalidBypassReason(problem) {
  // Routes through the ONE refusal builder (BUG-226 round 3), so this path — a
  // SECOND refusal route the round-2 verify found carrying no "Still available
  // here" list (break a) — now gets the help like every other refusal.
  return buildRefusal({
    lead: [
      `Orchestrator tool profile: the \`# ORCH-BYPASS:\` marker on this command is not usable — ${problem}.`,
      '',
      'The escape hatch needs a real reason on the command\'s FIRST line, e.g.:',
      '    # ORCH-BYPASS: need the live gate exit status to decide whether to commit now',
      'then the command itself on the following line(s).',
    ],
  });
}

/**
 * A one-phrase gloss for the few allowed tools that earn an explanation in the
 * "Still available here" line. DECORATION ONLY — the authoritative set of names
 * is ENFORCE_ALLOWED_TOOLS and is read from there; a tool with no gloss is named
 * by itself. A gloss keyed to a name no longer in the allowlist is simply unused,
 * so this map can never make the line claim a tool `decide()` does not permit.
 */
const STILL_AVAILABLE_GLOSS = {
  ListAgents: 'ListAgents (lane liveness — names + busy/idle)',
};

/**
 * The "Still available here" help text, GENERATED from the allowlists so it can
 * never drift from what `decide()` actually permits (ARCH-010 — one owner, read
 * everywhere else). The prose was hand-maintained and silently fell 9 tools
 * behind ENFORCE_ALLOWED_TOOLS — TaskCreate/Update/Get/List, Workflow, Skill,
 * TodoWrite, ExitPlanMode, ToolSearch — which BUG-226's clean-room verify caught
 * (P3). Every allowed tool is now named straight from ENFORCE_ALLOWED_TOOLS, and
 * Bash — decided per command HEAD, not by name — is described from its own single
 * owner, ENFORCE_ALLOWED_BASH, so both halves move with the policy automatically.
 * Returned as an array of lines (one per array element, joined with '\n' by the
 * caller). Exported so the enforcement suite can assert the line lists EXACTLY
 * the allowlist rather than re-typing a second copy of it.
 */
export function stillAvailableHere() {
  const named = ENFORCE_ALLOWED_TOOLS
    .filter((t) => t !== 'Bash')
    .map((t) => STILL_AVAILABLE_GLOSS[t] ?? t);
  // Derived from decideBashCommand itself (allowedBashHeads), not from the raw
  // allowlist — so an always-refused head (npx) is never advertised (BUG-226 r3).
  const bashHeads = allowedBashHeads().join(', ');
  const restricted = restrictedBashHeads().join('/');
  return [
    `Still available here: ${named.join(', ')}.`,
    `Plus Bash, decided per command HEAD (default-deny) — allowed heads: ${bashHeads}`,
    '(the gate, board bookkeeping, service/status reads). Some of those heads are',
    `allowed only in read-free forms — ${restricted} are refused when talked into a`,
    'read (e.g. node -e, npm exec, docker run, systemctl cat). git is ALLOW-known-good:',
    'status/log/diff --stat/branch/rev-parse/worktree and the commit-side verbs pass,',
    'while the content/tree readers (show, bare diff, log -p, ls-files, ls-tree,',
    'whatchanged, grep, blame, cat-file) and any other file read or tree-search are',
    'refused; curl is localhost-only (file: and non-local hosts refused). git WRITES',
    '(commit/add) are governed separately by the git-write policy, not promised here.',
  ];
}

/**
 * What a refused call should TELL the model — and therefore what the user reads
 * when it comes back. A restriction that produces an unexplained error is worse
 * than the drift it was meant to fix, so every refusal names three things: what
 * was refused, why, and the specific thing to do instead. The last part is what
 * turns a wall into a redirect.
 */
/**
 * FEAT-149 — the board:status redirect, as its own block so the ONE refusal
 * builder can splice it in without each caller re-typing it. Highest-value
 * placement: it fires exactly when an orchestrator is blocked from inspecting the
 * tree, which is when it is most tempted to substitute a lane's claim about a
 * ticket's state (measured 2026-09-23: a status asserted four times from
 * contradictory lane reports, wrong each time).
 */
function boardStatusRedirect() {
  return [
    "If what you wanted was a TICKET's or the BOARD's state — its status, round",
    'count, placement, dirty/committed, or latest activity — do NOT dispatch and',
    'do NOT trust a lane report for it. Run `npm run board:status -- <ID>` (or',
    'with no id for a whole-board summary). It is allowed under this profile',
    '(node/npm only), needs no lane, and reads the board through its own parser —',
    'so a status is CHECKED, never asserted from memory or relayed from a lane.',
  ];
}

/**
 * THE one refusal builder (BUG-226 round 3). EVERY orchestrator-profile refusal
 * message is assembled here, so none can omit the "Still available here" help
 * again — the round-1/round-2 failure was exactly that the help lived in ONE of
 * several refusal paths. Callers supply only their own LEAD (what was refused /
 * why / what to do instead); the help footer (derived from the same authority
 * that grants — stillAvailableHere) and the bypass criteria are appended here,
 * once, for all of them.
 */
function buildRefusal({ lead, readShaped = false }) {
  const lines = [...lead];
  if (readShaped) lines.push('', ...boardStatusRedirect());
  lines.push('', ...stillAvailableHere(), '', ...BYPASS_CRITERIA);
  return lines.join('\n');
}

function refusalReason(toolName, offender) {
  const what = offender ? `\`${offender}\` (via Bash)` : `\`${toolName}\``;
  return buildRefusal({
    lead: [
      `Orchestrator tool profile: ${what} is not available to this session.`,
      '',
      'This session is running as an ORCHESTRATOR in a project where the tool',
      'profile is enforced. Reading, searching and inspecting the tree inline is',
      'what the profile removes, because that work belongs in a dispatched lane —',
      'a lane reads with a fresh context that is thrown away, while anything you',
      'read here is re-read on every subsequent request for the rest of the session.',
      '',
      'Do this instead: dispatch it with the Agent tool. Give the lane the question,',
      'not your answer — e.g. an Explore agent for "where/what is X", a worker for a',
      'change. The lane has the full toolset, including Bash; nothing is being taken',
      'away from the work, only from this session.',
    ],
    readShaped: isReadShapedRefusal(toolName, offender),
  });
}

/**
 * FEAT-149 — is this refusal about reading/searching/inspecting the tree (as
 * opposed to, say, a refused `curl`)? Those are the calls where the orchestrator
 * was likely trying to check a fact — often a ticket's state — so the
 * board:status redirect is relevant. Covers the read-shaped tools and the
 * read-shaped Bash offenders decideBashCommand names.
 */
function isReadShapedRefusal(toolName, offender) {
  if (['Read', 'Grep', 'Glob'].includes(toolName)) return true;
  if (typeof offender === 'string' && offender) {
    return /\b(grep|rg|cat|less|more|head|tail|find|ls|sed|awk|git grep|git log|git show)\b/.test(
      offender,
    );
  }
  return false;
}

/**
 * THE decision. One function, called by the enforcing hook and by the tests, so
 * a policy question has exactly one answer in this repo (ARCH-008).
 *
 * @param {object} call
 * @param {string} call.toolName
 * @param {unknown} [call.toolInput]
 * @param {string|null|undefined} [call.agentId] - `agent_id` from the PreToolUse
 *   payload. PRESENT means a dispatched subagent made this call.
 * @returns {{ allow: boolean, reason: string|null, scope: 'subagent'|'orchestrator' }}
 */
export function decide({ toolName, toolInput, agentId } = {}) {
  /*
   * A DISPATCHED LANE KEEPS EVERYTHING. This is the first branch on purpose:
   * the restriction is on the orchestrating session only, and lane calls share
   * the parent's session id and transcript, so `agent_id` is the sole
   * discriminator (sdk.d.ts:174-176 — "Use this field (not agent_type)").
   * Getting this wrong does not degrade the feature, it breaks every lane in
   * the project.
   */
  if (agentId != null && String(agentId).length > 0) {
    return { allow: true, reason: null, scope: 'subagent' };
  }

  const name = typeof toolName === 'string' ? toolName : '';

  if (name === 'Bash') {
    const command = toolInput && typeof toolInput === 'object' ? toolInput.command : '';
    const { allow, offender } = decideBashCommand(command);
    // Allowed on its own merits (npm/node/git/status): a bypass marker, if any,
    // is just a harmless comment — nothing was bypassed, so nothing is logged.
    if (allow) return { allow: true, reason: null, scope: 'orchestrator' };
    // Refused by the profile. Only NOW does the audited escape hatch matter.
    const bp = detectOrchBypass(command);
    if (bp.present && bp.valid) {
      // Pure: we return the bypass event; the hook logs it and counts it.
      return {
        allow: true,
        reason: null,
        scope: 'orchestrator',
        bypass: { reason: bp.reason, command: typeof command === 'string' ? command : '' },
      };
    }
    if (bp.present && !bp.valid) {
      return { allow: false, reason: invalidBypassReason(bp.problem), scope: 'orchestrator' };
    }
    return { allow: false, reason: refusalReason(name, offender), scope: 'orchestrator' };
  }

  if (ENFORCE_ALLOWED_TOOLS.includes(name)) {
    return { allow: true, reason: null, scope: 'orchestrator' };
  }

  return { allow: false, reason: refusalReason(name, null), scope: 'orchestrator' };
}
