#!/usr/bin/env node
/**
 * verify-orchestrator-enforcement.mjs — FEAT-096 phase 2.
 *
 * Grades the ENFORCING half of the orchestrator profile: `decide()`, the Bash
 * command classifier under it, and the two properties whose failure would be
 * worse than having no policy at all.
 *
 * WHAT THIS SUITE IS GRADED AGAINST, AND WHY IT MATTERS: the bulk of it runs
 * over the REAL orchestrator's own tool calls, read live out of this project's
 * transcript store — 584 calls made for their own reasons before any policy
 * existed. That is deliberate. An earlier draft of this classifier passed every
 * example I invented and then refused `npm run gate` and `cd <repo>; …` the
 * moment it met the real corpus, because a fixture encodes the author's mental
 * model instead of testing it. Two defects (the `2>&1` tear, the `cd` prefix)
 * were found only that way and are pinned below as must-FAIL proofs.
 *
 * When the transcript store is absent (a clone on another machine), the
 * real-corpus checks SKIP LOUDLY rather than silently passing.
 *
 * Run: npm run verify:orchestrator-enforcement
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decide,
  decideBashCommand,
  bashSegmentHead,
  stillAvailableHere,
  allowedBashHeads,
  restrictedBashHeads,
  ENFORCE_ALLOWED_TOOLS,
  ENFORCE_ALLOWED_BASH,
  ENFORCE_DENIED_GIT_SUBCOMMANDS,
  KNOWN_DENIED,
} from './lib/orchestrator-profile.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function skipped(name, why) { skip++; console.log(`  SKIP  ${name} — ${why}`); }

/* ═══ 1. The two must-not-breaks ═══════════════════════════════════════════
 * These are first because they are the failure modes that would make this
 * feature actively harmful rather than merely wrong.
 */

// (a) A dispatched worker keeps its FULL toolset. Lane calls share the parent's
// session id and transcript; `agent_id` is the only discriminator, so this is
// the single assumption the whole design rests on.
for (const tool of ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebFetch', 'NotebookEdit', 'mcp__serena__find_symbol']) {
  const d = decide({ toolName: tool, toolInput: { command: 'rm -rf / ; grep -rn x /' }, agentId: 'agent-abc123' });
  ok(`subagent keeps ${tool}`, d.allow === true && d.scope === 'subagent', JSON.stringify(d));
}
// agent_id present with an empty string is NOT a subagent — a falsy discriminator
// must not silently grant the lane exemption to the main thread.
ok('empty agent_id is not a subagent',
  decide({ toolName: 'Read', agentId: '' }).scope === 'orchestrator');
ok('null agent_id is not a subagent',
  decide({ toolName: 'Read', agentId: null }).scope === 'orchestrator');

// (b) A restricted session can still answer with NO tools at all. There is no
// code path here that can refuse a plain reply, so the property under test is
// that the policy is only ever consulted for a tool call — asserted by the
// absence of any global/session-level effect: decide() is pure and returns a
// per-call verdict.
ok('decide is per-call and pure (no session state)',
  decide({ toolName: 'Agent' }).allow === true &&
  decide({ toolName: 'Read' }).allow === false &&
  decide({ toolName: 'Agent' }).allow === true);

/* ═══ 2. Every refusal is LEGIBLE ══════════════════════════════════════════
 * "A restriction that produces an unexplained error is worse than the drift."
 * A refusal must name what was refused, why, and what to do instead.
 */
const refusals = [
  decide({ toolName: 'Read', toolInput: { file_path: '/x' } }),
  decide({ toolName: 'Grep', toolInput: {} }),
  decide({ toolName: 'Bash', toolInput: { command: 'grep -rn foo /src' } }),
  decide({ toolName: 'SomeToolInventedTomorrow', toolInput: {} }),
];
for (const [i, d] of refusals.entries()) {
  ok(`refusal ${i} is refused`, d.allow === false);
  ok(`refusal ${i} carries a reason`, typeof d.reason === 'string' && d.reason.length > 100);
  ok(`refusal ${i} names the remedy`, /Agent tool/.test(d.reason ?? ''));
  ok(`refusal ${i} says what is still available`, /Still available here/.test(d.reason ?? ''));
  ok(`refusal ${i} explains why`, /dispatched lane/.test(d.reason ?? ''));
}
ok('a refused Bash names the offending command, not just "Bash"',
  /`grep` \(via Bash\)/.test(decide({ toolName: 'Bash', toolInput: { command: 'grep -rn x /' } }).reason ?? ''));
ok('an allowed call carries no reason',
  decide({ toolName: 'Agent' }).reason === null);

/* ═══ 3. The tool-name policy, against the names this harness really emits ═══
 * The retroactive analysis found four live names missing from the profile's
 * lists entirely, `AskUserQuestion` among them — denying it would stop a
 * session asking its user anything.
 */
for (const t of ['Agent', 'SendMessage', 'TaskStop', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'Workflow', 'ToolSearch', 'Skill', 'Edit', 'Write']) {
  ok(`orchestrator keeps ${t}`, decide({ toolName: t }).allow === true);
}
for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Monitor', 'mcp__serena__find_symbol', 'mcp__playwright__browser_navigate']) {
  ok(`orchestrator loses ${t}`, decide({ toolName: t }).allow === false);
}
ok('AskUserQuestion is allowed (the retroactive analysis flagged denying it as almost certainly unintended)',
  ENFORCE_ALLOWED_TOOLS.includes('AskUserQuestion'));
ok('no tool named Dispatch is in the policy (it does not exist in this harness)',
  !ENFORCE_ALLOWED_TOOLS.includes('Dispatch'));
ok('an unknown future tool is denied by default, not allowed by default',
  decide({ toolName: 'BrandNewToolName' }).allow === false);

/* ═══ 3b. ListAgents — the orchestrator's lane-LIVENESS read (BUG-226) ══════
 * WA §C REQUIRES confirming a lane is alive from ground truth before treating
 * it as dead or re-dispatching. `ListAgents` (the SDK's `ListPeers`) is the read
 * that answers it: the dispatched lanes and their busy/idle status — names and
 * state, no tree reading. It was never NAMED in ENFORCE_ALLOWED_TOOLS, so it
 * fell to default-deny: dispatch/steer/stop a lane were all allowed, while the
 * one verb that CHECKS whether the lane still runs was refused. Pinned both ways.
 */
ok('orchestrator keeps ListAgents (lane liveness, WA §C)',
  decide({ toolName: 'ListAgents' }).allow === true);
ok('ListAgents is in the one allow-list declaration (ARCH-010 — one owner)',
  ENFORCE_ALLOWED_TOOLS.includes('ListAgents'));
{
  /*
   * MUST-FAIL PROOF — synthesized pre-fix declaration, NOT HEAD-anchored
   * (docs/CONVENTIONS.md). The allowlist before this fix was exactly the current
   * one minus ListAgents, and a non-Bash tool is allowed IFF it is named in that
   * list (see decide()'s final branch). Reconstruct the pre-fix list and model
   * that same decision to show the old declaration refused ListAgents — so this
   * proof keeps biting even after the fix is committed.
   */
  const PRE_FIX_ALLOWED = ENFORCE_ALLOWED_TOOLS.filter((t) => t !== 'ListAgents');
  const preFixWouldAllow = (name) => name === 'Bash' || PRE_FIX_ALLOWED.includes(name);
  ok('MUST-FAIL: the pre-fix allowlist refused ListAgents (the proof is real)',
    preFixWouldAllow('ListAgents') === false);
  // Non-vacuity: the reconstruction still ALLOWS what the profile has always
  // allowed, so the proof above is about ListAgents specifically, not a broken model.
  ok('MUST-FAIL non-vacuity: the pre-fix model still allowed Agent and SendMessage',
    preFixWouldAllow('Agent') === true && preFixWouldAllow('SendMessage') === true);
}
ok('the still-available prose names ListAgents so a blocked session is told it has the liveness read',
  /ListAgents/.test(decide({ toolName: 'Read' }).reason ?? ''));

/* ═══ 3c. "Still available here" prose is GENERATED from the allowlist (BUG-226) ══
 * The round-1 clean-room verify (dispatch anthropic run 9a3e17fc…, VERDICT BROKEN)
 * found the hand-written prose OMITTED 9 tools ENFORCE_ALLOWED_TOOLS allows —
 * TaskCreate/Update/Get/List, Workflow, Skill, TodoWrite, ExitPlanMode, ToolSearch.
 * The round-1 test only regex-checked the prose for "ListAgents"; it never diffed
 * the prose against the allowlist, so the drift was invisible. The fix builds the
 * line FROM the allowlist (ARCH-010 — one owner, read everywhere else), so the two
 * can't drift. Asserted against the REAL message a blocked session sees
 * (decide().reason), not only the helper, in BOTH directions, with a must-FAIL
 * reddening on the exact pre-fix hand-list this replaced.
 */
{
  const reason = decide({ toolName: 'Read' }).reason ?? '';
  // Direction 1 — every non-Bash allowed tool is named in the message the user reads.
  const omitted = ENFORCE_ALLOWED_TOOLS.filter((t) => t !== 'Bash' && !reason.includes(t));
  ok('the "Still available here" prose names EVERY tool in the allowlist (none omitted)',
    omitted.length === 0, `omitted: ${omitted.join(', ')}`);
  // The 9 tools the round-1 hand-list silently dropped are specifically present now.
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'Workflow',
    'Skill', 'TodoWrite', 'ExitPlanMode', 'ToolSearch']) {
    ok(`the prose now names ${t} (BUG-226 P3 — was omitted pre-fix)`, reason.includes(t));
  }
  // Bash is described from its own single owner (ENFORCE_ALLOWED_BASH), so the
  // Bash-subset wording is derived and accurate rather than a hand gloss that drifts.
  const bashOmitted = [...new Set(ENFORCE_ALLOWED_BASH)].filter((h) => !reason.includes(h));
  ok('the prose lists the Bash command heads from ENFORCE_ALLOWED_BASH (derived, accurate)',
    bashOmitted.length === 0, `omitted heads: ${bashOmitted.join(', ')}`);
  // Direction 2 — EXACTLY the allowlist: it must claim no tool decide() actually
  // denies. KNOWN_DENIED minus anything the enforcement list allows is the set of
  // genuinely-refused names; none may appear as a standalone word in the line.
  const lineText = stillAvailableHere().join(' ');
  const claimedButDenied = [...new Set(KNOWN_DENIED)].filter(
    (t) => !ENFORCE_ALLOWED_TOOLS.includes(t) && new RegExp(`\\b${t}\\b`).test(lineText),
  );
  ok('the prose claims NO tool outside the allowlist (lists EXACTLY the allowlist)',
    claimedButDenied.length === 0, `claimed but denied: ${claimedButDenied.join(', ')}`);

  /*
   * MUST-FAIL PROOF — the exact pre-fix HAND-LIST this fix replaced, synthesized
   * here (NOT read from HEAD, per docs/CONVENTIONS.md) so it keeps biting after
   * commit. Applying direction 1's check to the old prose must FAIL, proving the
   * guard catches drift rather than passing vacuously. `>= 9` not `=== 9` so a
   * future tool ADDED to the allowlist (more omissions) does not spuriously redden.
   */
  const PRE_FIX_PROSE =
    'Still available here: Agent, SendMessage, TaskStop, ListAgents (lane ' +
    'liveness — names + busy/idle), AskUserQuestion, Edit, Write, and Bash for ' +
    'npm/node/git/status commands (the gate, the board, your own commits).';
  const preFixOmitted = ENFORCE_ALLOWED_TOOLS.filter((t) => t !== 'Bash' && !PRE_FIX_PROSE.includes(t));
  ok('MUST-FAIL: the pre-fix hand-list omits allowlisted tools (guard bites on real drift)',
    preFixOmitted.length >= 9, `pre-fix omitted ${preFixOmitted.length}: ${preFixOmitted.join(', ')}`);
}

/* ═══ 3d. SINGLE AUTHORITY: every refusal carries the help, and the help names
 *        ONLY what the two deciders actually allow (BUG-226 round 3) ════════
 * Round 1 broke via a hand-list; round 2 broke via (a) a SECOND refusal path
 * (invalidBypassReason) with no help, and (b) the Bash half advertising `npx`
 * which decideBashCommand refuses unconditionally. The redesign: every refusal
 * is built by ONE function, and the help's tool/Bash sets are derived from the
 * SAME authority that grants (decide / decideBashCommand), not a parallel list.
 */
{
  const RE = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  // ── Property A: EVERY refusal path carries the help ──────────────────────
  // Three decide() refusal routes — a non-Bash tool, a read-shaped Bash command,
  // and a Bash command with a PRESENT-but-INVALID ORCH-BYPASS marker (the second
  // route round-2 (a) found carrying no help). All must name the help now.
  const refusalPaths = [
    ['non-Bash tool', decide({ toolName: 'Read', toolInput: { file_path: '/x' } })],
    ['read-shaped Bash', decide({ toolName: 'Bash', toolInput: { command: 'grep -rn x /' } })],
    ['invalid ORCH-BYPASS marker',
      decide({ toolName: 'Bash', toolInput: { command: '# ORCH-BYPASS: x\ngrep -rn x /' } })],
  ];
  for (const [label, d] of refusalPaths) {
    ok(`refusal path "${label}" is refused`, d.allow === false, JSON.stringify(d).slice(0, 120));
    ok(`refusal path "${label}" carries "Still available here"`,
      /Still available here/.test(d.reason ?? ''));
    const toolsMissing = ENFORCE_ALLOWED_TOOLS.filter((t) => t !== 'Bash' && !RE(t).test(d.reason ?? ''));
    ok(`refusal path "${label}" names every allowlisted tool`,
      toolsMissing.length === 0, `missing: ${toolsMissing.join(', ')}`);
  }
  // The invalid-bypass route specifically is the round-2 (a) regression — pin it.
  ok('the invalid-ORCH-BYPASS refusal names the liveness read (help is present, not just a stub)',
    /ListAgents/.test(refusalPaths[2][1].reason ?? ''));

  // ── Property B: every ADVERTISED Bash head has an allowed shape ───────────
  // Token-match the GENERATED Bash line (NOT reason.includes over the whole
  // message — the read-shaped refusal already contains "(node/npm only)", which
  // would mask a dropped head; plan-review finding 6).
  const bashLine = stillAvailableHere().find((l) => /allowed heads:/.test(l)) ?? '';
  // Parse the head list the line actually advertises (delimiter-based, so a
  // non-word head like `[` or `[[` is matched exactly, not via \b which they fail).
  const headTokens = (bashLine.split('allowed heads:')[1] ?? '').split(/,\s*/).map((s) => s.trim());
  const advertised = allowedBashHeads();
  const PROBE = (h) => [h, `${h} ./x.mjs`];
  for (const h of advertised) {
    ok(`advertised head "${h}" appears as a token in the generated Bash line`,
      headTokens.includes(h), bashLine);
    ok(`advertised head "${h}" has at least one shape decideBashCommand ALLOWS`,
      PROBE(h).some((p) => decideBashCommand(p).allow));
  }
  // The round-2 (b) offender, both directions: npx is neither advertised nor allowed.
  ok('npx is NOT in the advertised Bash heads (round-2 b)', !advertised.includes('npx'));
  ok('npx is NOT a token in the generated Bash line', !headTokens.includes('npx'));
  ok('decideBashCommand refuses `npx tsx x` (the real authority)',
    decideBashCommand('npx tsx x').allow === false);
  ok('`node` IS advertised (bare node is refused but `node <script>` is allowed — not dropped)',
    advertised.includes('node') && headTokens.includes('node'));

  // Restricted heads are a subset of advertised (finding 4 — npx must not sneak
  // back as "restricted", which would imply some shape of it works).
  const restricted = restrictedBashHeads();
  ok('restricted heads are a subset of the advertised heads',
    restricted.every((h) => advertised.includes(h)), `restricted: ${restricted.join(', ')}`);
  ok('npx is NOT named as a restricted head', !restricted.includes('npx'));

  // ── Property C: the Bash prose does not PROMISE git commits (finding 3) ───
  // The git-write block is default-ON and denies commits before decide() runs, so
  // advertising "your own commits" is advertising a refused command one layer up.
  ok('the generated help does not promise git commits', !/your own commits?/i.test(stillAvailableHere().join(' ')));

  // ── MUST-FAIL (a): the pre-fix invalid-bypass message had NO help ─────────
  // Synthesized pre-fix text (NOT read from HEAD — docs/CONVENTIONS.md), so the
  // proof keeps biting after commit. The guard above must distinguish it from the
  // fixed message.
  const PRE_FIX_INVALID_BYPASS = [
    'Orchestrator tool profile: the `# ORCH-BYPASS:` marker on this command is not usable — the reason is missing.',
    '',
    "The escape hatch needs a real reason on the command's FIRST line, e.g.:",
    '    # ORCH-BYPASS: need the live gate exit status to decide whether to commit now',
    'then the command itself on the following line(s).',
  ].join('\n');
  ok('MUST-FAIL (a): the pre-fix invalid-bypass message OMITS "Still available here" (guard is real)',
    !/Still available here/.test(PRE_FIX_INVALID_BYPASS));
  ok('…and the fixed invalid-bypass message now CARRIES it',
    /Still available here/.test(refusalPaths[2][1].reason ?? ''));

  // ── MUST-FAIL (b): the pre-fix raw-allowlist advertisement named npx, which
  // the decider refuses. Reconstruct the pre-fix advertiser (raw ENFORCE_ALLOWED_BASH
  // with npx re-added) and show it names a head decideBashCommand refuses. ──────
  const PRE_FIX_HEADS = [...new Set(['npx', ...ENFORCE_ALLOWED_BASH])];
  const preFixAdvertisedButRefused = PRE_FIX_HEADS.filter(
    (h) => !PROBE(h).some((p) => decideBashCommand(p).allow),
  );
  ok('MUST-FAIL (b): the pre-fix raw advertisement names a head decideBashCommand refuses',
    preFixAdvertisedButRefused.includes('npx'), `offenders: ${preFixAdvertisedButRefused.join(', ')}`);
  ok('…and the derived advertisement names NO head decideBashCommand refuses',
    advertised.every((h) => PROBE(h).some((p) => decideBashCommand(p).allow)));

  // ── Property D: every advertised TOOL is allowed by the real decide() ─────
  for (const t of ENFORCE_ALLOWED_TOOLS.filter((t) => t !== 'Bash')) {
    ok(`advertised tool "${t}" is allowed by decide()`, decide({ toolName: t }).allow === true);
  }
}

/* ═══ 4. Bash: the two defects the real corpus found, pinned as must-FAIL ═══
 * Both of these PASSED a hand-written fixture set and FAILED the real data.
 * They are asserted here by the property, and separately by the pre-fix
 * behaviour, so a regression cannot pass quietly.
 */

// MUST-FAIL PROOF 1 — the `2>&1` tear. Splitting on a bare `&` cut `2>&1` in
// half and read the orphaned `1` as a command head, refusing the gate cluster.
const REPO = path.resolve(import.meta.dirname, '..');
const gateCluster = `cd ${REPO}; npm run board:gen >/dev/null 2>&1; npm run gate >/dev/null 2>&1; G=$?; echo "gate exit=$G"`;
ok('MUST-FAIL 1: the real gate-and-board cluster is ALLOWED', decideBashCommand(gateCluster).allow === true,
  `offender=${decideBashCommand(gateCluster).offender}`);
{
  // The pre-fix algorithm, reconstructed (not imported from HEAD, per
  // docs/CONVENTIONS.md) — it must still exhibit the defect.
  const preFix = (cmd) => cmd.split(/(?:\|\||&&|[;\n|&])+/).map((s) => s.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean).every((h) => ENFORCE_ALLOWED_BASH.includes(h));
  ok('MUST-FAIL 1: the pre-fix splitter still refuses it (the proof is real)', preFix(gateCluster) === false);
}

// MUST-FAIL PROOF 2 — the `cd` prefix. `cd <repo>;` heads almost every real
// orchestrator command; refusing it refused the corpus for the wrong reason.
ok('MUST-FAIL 2: `cd <repo> && npm run gate` is ALLOWED', decideBashCommand(`cd ${REPO} && npm run gate`).allow === true);
ok('MUST-FAIL 2: cd is in the allow list', ENFORCE_ALLOWED_BASH.includes('cd'));

/* ═══ 5. Bash: the holes a name-only policy leaves ═════════════════════════ */
const bashCases = [
  // The user's actual complaint, verbatim in shape: a fresh session's first act.
  ['grep -rn -i "request an app" /workspace/kenimai-website/src --include="*.tsx" -l | head', false],
  ['echo hi; grep -rn secret /', false],            // compound: any segment refuses
  ['echo "$(grep -rn secret /)"', false],           // command substitution
  ['echo `cat /etc/passwd`', false],                // backtick substitution
  ['git status --porcelain | xargs cat', false],    // re-entrant exec downstream
  ['git status --porcelain | sh', false],
  ['npm run gate | python3 -c "import sys"', false],
  ['sh -c "npm run gate"', false],
  ['/usr/bin/grep -rn x /', false],                 // path-qualified is still grep
  ['GATE=1 grep -rn x /', false],                   // skip assignments to find the head
  ['if npm run gate; then echo ok; fi', true],      // shell keywords are transparent
  ['git show HEAD:src/a.ts', false],                // git subcommands that print bodies
  ['git diff package.json | head -20', false],
  ['git log -p -3', false],
  ['git log --oneline -3', true],                   // …but status-shaped git is kept
  ['git status --porcelain | head -5', true],       // downstream filters are fine
  ['git add docs/bugs/X.md && git commit -m "x"', true],
  ['head -50 src/foo.ts', false],                   // …because at stage 1 head is not allowed
  ['npm run board:tool -- query --status=open', true],
  ['node scripts/dispatch.mjs --provider openai', true], // FEAT-043 cross-provider survives
  ['python3 -c "print(1)"', false],
  ['ls -la', false],
  ['find . -name "*.ts"', false],
  ['rg -n playwright docs/', false],
  ['cat > out.mjs <<\'EOF\'\ngrep -rn secret /\nEOF', false],  // heredoc opener still decided
  ['npm run gate <<\'EOF\'\ngrep -rn x /\nEOF', true],  // heredoc BODY is data, not commands
  ['', true],                                       // empty command is not a read
];
for (const [cmd, expected] of bashCases) {
  const got = decideBashCommand(cmd).allow;
  ok(`bash: ${JSON.stringify(cmd).slice(0, 78)} -> ${expected ? 'allow' : 'deny'}`, got === expected, `got ${got}`);
}
ok('bashSegmentHead strips a leading env assignment', bashSegmentHead('FOO=1 npm run gate') === 'npm');
ok('bashSegmentHead strips a shell keyword', bashSegmentHead('then npm run gate') === 'npm');
ok('bashSegmentHead resolves a path-qualified head', bashSegmentHead('/usr/bin/grep -rn x') === 'grep');
ok('bashSegmentHead on an empty segment returns empty', bashSegmentHead('   ') === '');
ok('git content subcommands are declared, not inlined', ENFORCE_DENIED_GIT_SUBCOMMANDS.includes('show') && ENFORCE_DENIED_GIT_SUBCOMMANDS.includes('diff'));

/* ═══ 6. Robustness — a policy bug must never take a session down ══════════
 * The hook wrapping this fails open, but decide() itself must not throw on a
 * hostile or malformed payload either, or the fail-open path is doing all the
 * work and hiding a crash.
 */
const hostile = [
  { toolName: 'Bash', toolInput: null },
  { toolName: 'Bash', toolInput: { command: null } },
  { toolName: 'Bash', toolInput: { command: 12345 } },
  { toolName: 'Bash', toolInput: { command: 'x'.repeat(500_000) } },
  { toolName: 'Bash', toolInput: { command: '$('.repeat(5000) } },
  { toolName: 'Bash', toolInput: { command: '`'.repeat(5000) } },
  { toolName: 'Bash', toolInput: { command: '|'.repeat(20000) } },
  { toolName: null },
  { toolName: undefined },
  {},
  undefined,
];
for (const [i, payload] of hostile.entries()) {
  let threw = null;
  const t0 = Date.now();
  try { decide(payload); } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  ok(`hostile payload ${i} does not throw`, threw === null, String(threw));
  ok(`hostile payload ${i} decides in under 1s (no catastrophic backtracking)`, ms < 1000, `${ms}ms`);
}

/* ═══ 6b. The corpus-classification ORACLE (BUG-185) ═══════════════════════
 * An INDEPENDENT cross-check of what a real command actually DOES, used by the
 * section-7 corpus assertions to decide which commands the policy must allow
 * (pure gate/board work) and which it must refuse (a file read / tree search).
 * It is deliberately not `decideBashCommand` itself — an oracle that just called
 * the policy would assert nothing — but it must model a command the SAME way the
 * shell does: quoted prose is DATA, not commands.
 *
 * The first cut of this oracle split the RAW command on newlines and read the
 * first word of every line as a command head. Two real command shapes that
 * entered the corpus after FEAT-096 closed at 122/122 broke that, reddening a
 * clean HEAD (BUG-185):
 *   - a multi-line dispatch prompt — `node dispatch-client.mjs … "You are a
 *     VERIFIER … diff the files …"` — whose prompt-line-start words and whose
 *     "git diff"/"git show" PROSE were scored as reads. The policy correctly
 *     ALLOWS it (a node script; the prompt is an argument).
 *   - a `npx tsx …` / `node -e …` compound that also runs the gate — not a read,
 *     but not pure gate work either. The policy correctly REFUSES it (`npx` /
 *     `node -e` are not on the allow list), so it must not be expected allowed.
 * The policy was right on both; the ORACLE was wrong. Fix: strip a command's
 * DATA (heredoc bodies, redirections, substitutions, quoted spans, comments)
 * before classifying — mirroring decideBashCommand — and count a command as
 * "pure gate work" only when every stage-one head is gate/board GLUE
 * (npm/git/cd/echo/…), never an arbitrary executable (npx/node/python/…).
 * This file re-implements the strip because orchestrator-profile.mjs does not
 * export it; section 6c's non-vacuity proofs keep the re-implementation honest.
 */

// Ported from orchestrator-profile.mjs `stripQuotedAndComments`: a single
// left-to-right pass that honours whichever quote opened FIRST. A naive
// two-regex strip mis-pairs the moment a double-quoted dispatch prompt contains
// an apostrophe — and the real corpus has them.
function stripQuotedAndComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += ' '; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      if (close < 0) { out += ' '; break; }
      out += ' '; i = close + 1; continue;
    }
    if (ch === '#' && (out === '' || /\s/.test(src[i - 1] ?? ' '))) {
      const nl = src.indexOf('\n', i);
      if (nl < 0) { out += ' '; break; }
      out += ' '; i = nl; continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// A command reduced to just its executable structure, in the same order
// decideBashCommand uses: heredoc body cut off, redirections blanked,
// substitutions blanked, then quoted/commented spans blanked. What remains is
// real command text, so prose inside an argument cannot masquerade as a command.
function decidableForOracle(cmd) {
  const heredoc = cmd.search(/<<-?\s*'?"?[A-Za-z_]/);
  const body = (heredoc >= 0 ? cmd.slice(0, heredoc) : cmd)
    .replace(/\d*>>?&?\d*\s*|\d*<&?\d*\s*/g, ' ')
    .replace(/\$\([^()]*\)/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  return stripQuotedAndComments(body);
}

const headsOfStripped = (stripped) => stripped
  .split(/(?:\|\||&&|[;\n&])+/)
  .map((pl) => bashSegmentHead(pl.split('|')[0]))
  .filter(Boolean);

// The stage-one command heads of a command (its DATA already stripped): the head
// of each &&/||/;/&/newline-separated segment, ignoring downstream pipe stages.
const stageOneHeads = (cmd) => headsOfStripped(decidableForOracle(cmd));

const READ_HEADS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'cat', 'find', 'ls', 'awk', 'sed', 'head', 'tail',
  'python', 'python3', 'perl', 'xargs', 'sh', 'bash', 'wc', 'jq', 'du', 'tree', 'diff', 'stat', 'file',
  'strings', 'od', 'xxd', 'less', 'more', 'comm', 'column']);

// `git show` / `git diff` / `git grep` / `git log -p` print file bodies — reads
// wearing a git prefix, which the policy refuses. Tested against the DATA-stripped
// command so a "git diff" sitting in a quoted dispatch prompt is not mistaken for
// a real read (BUG-185 offender B).
const readsViaGit = (stripped) => /\bgit\s+(?:show|diff|grep|blame|cat-file)\b/.test(stripped)
  || /\bgit\s+log\b[^;&|\n]*(?:\s-p\b|--patch)/.test(stripped);

const readsAFile = (cmd) => {
  const stripped = decidableForOracle(cmd);
  return headsOfStripped(stripped).some((h) => READ_HEADS.has(h)) || readsViaGit(stripped);
};

// "Pure gate work": a command whose ONLY substantive heads are the gate/board and
// the glue around them (cd/echo/git commit/…). An arbitrary executable (npx,
// node, python, a service tool) means the call does something ELSE the policy may
// legitimately refuse, so it is NOT the compliance floor this asserts — it is
// counted among the refused-compound gate commands instead. `git` stays in the
// set (a gate cluster commits), and `!readsAFile` still excludes `git show`.
const GATE_CONTEXT_HEADS = new Set(['npm', 'git', 'cd', 'echo', 'true', 'false', ':', 'test', '[', '[[',
  'set', 'export', 'printf', 'date', 'pwd', 'which', 'mkdir', 'touch', 'chmod', 'cp', 'mv', 'wait', 'sleep', 'uptime']);
const isPureGateWork = (cmd) => /npm run (?:gate|board:(?:gen|check|tool))\b/.test(cmd)
  && !readsAFile(cmd)
  && stageOneHeads(cmd).every((h) => GATE_CONTEXT_HEADS.has(h));

/* ═══ 6c. The oracle is HONEST — non-vacuity of the BUG-185 fix ═════════════
 * Fixed synthetic inputs (never corpus-derived, so the baseline cannot move):
 * the strip must not have turned readsAFile / isPureGateWork into always-false.
 * If a future edit over-strips or blanket-loosens the oracle, these redden.
 */
// Genuine reads are STILL flagged.
ok('oracle flags a bare file read', readsAFile('cat src/server/board.ts') === true);
ok('oracle flags a tree search', readsAFile('grep -rn secret src/') === true);
ok('oracle flags `git show` as a read', readsAFile('git show HEAD:src/a.ts') === true);
ok('oracle flags `git diff | head` as a read', readsAFile('git diff package.json | head -20') === true);
ok('oracle flags a read that trails a gate command',
  readsAFile(`cd ${REPO} && npm run gate && cat src/server/board.ts`) === true);
ok('oracle flags a read in a later pipeline segment', readsAFile('npm run gate; sed -n 1,5p src/a.ts') === true);
// Data inside quotes/prompts is NOT a command — the two shapes BUG-185 mislabelled.
ok('oracle does NOT read a read-verb WORD inside a quoted prompt',
  readsAFile('node scripts/dispatch.mjs --provider openai "find the bug then diff the files and cat the log"') === false);
ok('oracle does NOT read "git diff" PROSE inside a quoted prompt',
  readsAFile('node src/server/dispatch-client.mjs --class verify "run git diff and git show HEAD to confirm the claim"') === false);
// Pure-gate classification: the compliance floor is IN, non-gate work is OUT.
ok('oracle: `cd <repo> && npm run gate` is pure gate work', isPureGateWork(`cd ${REPO} && npm run gate`) === true);
ok('oracle: `npm run board:gen && npm run gate` is pure gate work', isPureGateWork('npm run board:gen && npm run gate') === true);
ok('oracle: a gate command that also runs `npx` is NOT pure gate work (offender A1)',
  isPureGateWork('npx tsx scripts/x.mjs 2>&1 | tail -3; npm run gate') === false);
ok('oracle: a gate command that also runs `node -e` is NOT pure gate work (offender A2)',
  isPureGateWork('npm run board:gen && node -e "console.log(1)" && npm run gate') === false);
ok('oracle: a gate command that also reads a file is NOT pure gate work',
  isPureGateWork('npm run gate && cat src/a.ts') === false);
// And the policy agrees with the oracle on those synthetic offenders: pure ones
// allowed, the non-pure ones refused — this is what section 7 asserts over the
// real corpus, pinned here so it survives a corpus that no longer contains them.
ok('policy allows the synthetic pure-gate command', decideBashCommand(`cd ${REPO} && npm run gate`).allow === true);
ok('policy refuses the synthetic npx-compound gate command',
  decideBashCommand('npx tsx scripts/x.mjs 2>&1 | tail -3; npm run gate').allow === false);
ok('policy refuses the synthetic node-e-compound gate command',
  decideBashCommand('npm run board:gen && node -e "console.log(1)" && npm run gate').allow === false);
ok('policy allows the synthetic multi-line dispatch command (prompt is data)',
  decideBashCommand('node src/server/dispatch-client.mjs --class verify "run git diff and git show HEAD to confirm the claim"').allow === true);

/* ═══ 7. THE REAL CORPUS — the orchestrator's own calls ════════════════════ */
// The transcript store dir is the repo path with separators flattened. Derived,
// never written literally, so this file carries no absolute home path.
const store = path.join(os.homedir(), '.claude', 'projects', REPO.replace(/\//g, '-'));
if (!fs.existsSync(store)) {
  skipped('real-corpus grading', `transcript store absent at ${store}`);
} else {
  const files = fs.readdirSync(store).filter((f) => f.endsWith('.jsonl'));
  const calls = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(store, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.timestamp || r.timestamp < '2026-08-18T00:00:00Z') continue;
      const c = r.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) if (b.type === 'tool_use') calls.push(b);
    }
  }
  if (calls.length < 100) {
    skipped('real-corpus grading', `only ${calls.length} recent calls found`);
  } else {
    let threw = 0;
    for (const c of calls) { try { decide({ toolName: c.name, toolInput: c.input }); } catch { threw++; } }
    ok(`decide() survives all ${calls.length} real recent tool calls without throwing`, threw === 0, `${threw} threw`);

    const bash = calls.filter((c) => c.name === 'Bash').map((c) => String(c.input?.command ?? ''));
    const allowedBash = bash.filter((c) => decideBashCommand(c).allow);

    /*
     * A NOTE ON WHAT THESE CHECKS CAN AND CANNOT ASSERT, because the first
     * draft of them was wrong in a way worth recording.
     *
     * I initially asserted "every real command containing `npm run gate` is
     * allowed". It failed 29/41, and the policy was right and the assertion was
     * wrong: the real orchestrator writes ONE Bash call that runs the gate AND
     * greps a file AND lists a directory (90% of its commands serve more than
     * one purpose). Such a command is refused, correctly, because it contains a
     * read — the orchestrator has to split it. That is a real cost and it is
     * reported below as a number rather than asserted away.
     *
     * Likewise the leak detector must use the POLICY's semantics: `curl … |
     * grep -o x` is a stdout filter, not a file read, and counting it as a leak
     * was an error in the test, not in the classifier.
     */
    // The oracle (stageOneHeads / READ_HEADS / readsViaGit / readsAFile /
    // isPureGateWork) is defined at module scope — section 6b — so the section-6c
    // non-vacuity proofs can exercise it even when the corpus is absent.

    // The property that actually matters: a command that ONLY runs the gate /
    // board / its own commit is allowed. This is the compliance floor — the
    // working agreement REQUIRES the gate before a commit, so a policy that
    // refuses it makes the orchestrator non-compliant rather than restricted.
    const pureGate = bash.filter(isPureGateWork);
    const pureGateAllowed = pureGate.filter((c) => decideBashCommand(c).allow);
    ok(`every real gate/board command that does not also read a file is allowed (${pureGateAllowed.length}/${pureGate.length})`,
      pureGate.length > 0 && pureGateAllowed.length === pureGate.length,
      pureGate.filter((c) => !decideBashCommand(c).allow).slice(0, 2).map((c) => c.slice(0, 120)).join(' ⟂ '));

    // The thing the feature exists to stop: a read or a tree search at the head
    // of a pipeline. Downstream filters are excluded because the policy does
    // not treat them as reads.
    const realSearch = bash.filter((c) => readsAFile(c));
    const realSearchRefused = realSearch.filter((c) => !decideBashCommand(c).allow);
    ok(`every real file-read / tree-search command is refused (${realSearchRefused.length}/${realSearch.length})`,
      realSearch.length > 0 && realSearchRefused.length === realSearch.length,
      realSearch.filter((c) => decideBashCommand(c).allow).slice(0, 2).map((c) => c.slice(0, 120)).join(' ⟂ '));

    // The false-ALLOW direction — the one that would make the policy a fiction.
    const leaked = allowedBash.filter((c) => readsAFile(c));
    ok(`no file-reading command leaked into the allowed set (${leaked.length} leaks)`, leaked.length === 0,
      leaked.slice(0, 3).map((c) => c.slice(0, 120)).join(' ⟂ '));

    // Reported, not asserted: the honest cost of the policy on real behaviour.
    const gateAll = bash.filter((c) => /npm run (?:gate|board:(?:gen|check|tool))\b/.test(c));
    const gateCompoundRefused = gateAll.filter((c) => !decideBashCommand(c).allow);
    console.log(`\n  real corpus: ${calls.length} calls since 2026-08-18 · ` +
      `${bash.length} Bash (${allowedBash.length} allowed, ${bash.length - allowedBash.length} refused)`);
    console.log(`  gate/board commands: ${gateAll.length} total, ${pureGate.length} pure (all allowed), ` +
      `${gateCompoundRefused.length} refused because the SAME call also reads a file or runs non-gate work ` +
      `(e.g. npx/node -e) — those must be split.`);
    console.log(`  file-read / tree-search commands: ${realSearch.length}, all refused.`);
  }
}

/* ═══ 8. The kenimai-website report itself ═════════════════════════════════
 * The literal first command of the session that prompted this work, taken from
 * that session's real transcript rather than paraphrased.
 */
const KENIMAI_FIRST = 'grep -rn -i "request an app\\|request-an-app\\|#form\\|#request\\|#contact" /workspace/kenimai-website/src --include="*.tsx" --include="*.ts" --include="*.astro" --include="*.jsx" --include="*.js" --include="*.html" -l | head; echo ---; ls /workspace/kenimai-website';
const kd = decide({ toolName: 'Bash', toolInput: { command: KENIMAI_FIRST } });
ok('the reported session\'s literal first command is refused', kd.allow === false);
ok('…and the refusal names grep', /`grep`/.test(kd.reason ?? ''));
ok('…and tells it to dispatch instead', /Agent tool/.test(kd.reason ?? ''));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail === 0 ? 0 : 1);
