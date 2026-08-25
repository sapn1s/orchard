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
  'npm', 'npx', 'node',            // gate, board:gen/check/tool, dispatch.mjs, verifiers
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
 * `git` subcommands that exist to print file content or history bodies. These
 * are reads wearing a git prefix, and letting them through would leave the
 * largest hole in the Bash policy — `git show HEAD:src/foo.ts` is `cat`.
 * `git status`, `git log --oneline`, `git add`, `git commit` are unaffected.
 */
export const ENFORCE_DENIED_GIT_SUBCOMMANDS = ['show', 'diff', 'grep', 'blame', 'cat-file', 'log'];

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
 * The command head of one shell segment: the first bare word that is neither an
 * environment assignment nor a shell keyword. Returns '' when the segment holds
 * no command (trailing separators and bare `fi`/`done` are common and are not
 * commands).
 */
export function bashSegmentHead(segment) {
  const words = String(segment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || SHELL_KEYWORDS.has(words[i]))) i++;
  let head = words[i] ?? '';
  // A path-qualified invocation is still that command: /usr/bin/grep is grep.
  if (head.includes('/') && !head.startsWith('-')) head = head.slice(head.lastIndexOf('/') + 1);
  return head;
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
  flattened = stripQuotedAndComments(flattened);

  for (const pipeline of flattened.split(COMMAND_SPLIT)) {
    const stages = pipeline.split('|');
    for (let i = 0; i < stages.length; i++) {
      const head = bashSegmentHead(stages[i]);
      if (!head) continue;
      // Re-entrant execution is refused at any depth.
      if (EXEC_VERBS.has(head)) return { allow: false, offender: head };
      // Later stages are stdout filters; the read was already decided at stage 0.
      if (i > 0) continue;
      if (!ENFORCE_ALLOWED_BASH.includes(head)) return { allow: false, offender: head };
      if (head === 'git') {
        const words = stages[i].trim().split(/\s+/).filter(Boolean);
        const sub = words.find((w, j) => j > 0 && !w.startsWith('-'));
        // `git log --oneline` is a status check; `git log -p` prints file bodies.
        if (sub === 'log') {
          if (/(?:^|\s)(?:-p|--patch|-[A-Za-z]*p)(?:\s|$)/.test(stages[i])) {
            return { allow: false, offender: 'git log -p' };
          }
          continue;
        }
        if (sub && ENFORCE_DENIED_GIT_SUBCOMMANDS.includes(sub)) {
          return { allow: false, offender: `git ${sub}` };
        }
      }
    }
  }
  return { allow: true, offender: null };
}

/**
 * What a refused call should TELL the model — and therefore what the user reads
 * when it comes back. A restriction that produces an unexplained error is worse
 * than the drift it was meant to fix, so every refusal names three things: what
 * was refused, why, and the specific thing to do instead. The last part is what
 * turns a wall into a redirect.
 */
function refusalReason(toolName, offender) {
  const what = offender ? `\`${offender}\` (via Bash)` : `\`${toolName}\``;
  return [
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
    '',
    'Still available here: Agent, SendMessage, TaskStop, AskUserQuestion, Edit,',
    'Write, and Bash for npm/node/git/status commands (the gate, the board, your',
    'own commits).',
  ].join('\n');
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
    const { allow, offender } = decideBashCommand(
      toolInput && typeof toolInput === 'object' ? toolInput.command : '',
    );
    return allow
      ? { allow: true, reason: null, scope: 'orchestrator' }
      : { allow: false, reason: refusalReason(name, offender), scope: 'orchestrator' };
  }

  if (ENFORCE_ALLOWED_TOOLS.includes(name)) {
    return { allow: true, reason: null, scope: 'orchestrator' };
  }

  return { allow: false, reason: refusalReason(name, null), scope: 'orchestrator' };
}
