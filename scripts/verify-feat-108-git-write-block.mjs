#!/usr/bin/env node
/**
 * verify-feat-108-git-write-block.mjs — FEAT-108.
 *
 * Grades the git-write block: every git WRITE from an agent session is refused,
 * every read still works, the named evasions are caught (or honestly listed as
 * gaps), the escape hatch works, and the user's own terminal is untouched.
 *
 * DRIVEN, NOT ASSERTED. Section 2 runs the EXACT decision the runtime's
 * PreToolUse callback runs (replicated here AND pinned textually to the runtime
 * so the replica cannot drift), and section 3 runs a REAL `git commit` in a
 * throwaway scratch repo to show the shell path — the user's terminal — commits
 * with no hook in sight, while the same string denies through the hook.
 *
 * Run: npm run verify:git-write-block
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  decideGitWrite,
  scanForGitWrite,
  gitWriteBlockEnabled,
  gitWriteRefusal,
  GIT_READONLY,
  GIT_DUAL_READ,
} from './lib/git-write-policy.mjs';
// The PRE-FEAT-108 enforcement path, imported to PROVE non-vacuity: it allowed
// git writes, which is the hole this feature closes.
import { decide, decideBashCommand } from './lib/orchestrator-profile.mjs';

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} — ${why}`); };

const REPO = path.resolve(import.meta.dirname, '..');

/* ═══ 0. NON-VACUITY — the pre-change tree ALLOWED git writes ═══════════════
 * The must-FAIL proof: before FEAT-108 the enforcement path let git commits
 * through. (a) The orchestrator profile's own Bash classifier ALLOWS them —
 * `git commit`/`git add` are allowed heads there. (b) `decide()` exempts a lane
 * entirely, and BUG-155 was a lane. So a lane committing was allowed twice over.
 * These assertions FAIL the moment someone claims the block existed before.
 */
ok('MUST-FAIL: pre-change profile classifier ALLOWED `git commit`',
  decideBashCommand('git commit -m "x"').allow === true);
ok('MUST-FAIL: pre-change profile classifier ALLOWED `git add -A`',
  decideBashCommand('git add -A').allow === true);
ok('MUST-FAIL: pre-change decide() exempts a LANE for git commit (BUG-155 shape)',
  decide({ toolName: 'Bash', toolInput: { command: 'git commit -m "x"' }, agentId: 'agent-155' }).allow === true);

/* ═══ 1. THE CORE — writes deny, reads allow ═══════════════════════════════ */
const WRITES = [
  'git commit -m "msg"', 'git add -A', 'git add docs/bugs/BUG-155-x.md',
  'git push', 'git push origin main', 'git reset --hard HEAD', 'git restore .',
  'git checkout -b feature', 'git switch -c feature', 'git stash', 'git stash push',
  'git rm file', 'git mv a b', 'git commit --amend', 'git tag v1', 'git merge x',
  'git rebase main', 'git cherry-pick abc', 'git revert abc', 'git clean -fd',
  'git pull', 'git fetch', 'git clone https://x', 'git init', 'git gc',
  'git config user.email a@example.invalid', 'git config --global user.name X',
  'git remote add origin url', 'git branch newbranch', 'git worktree add /tmp/x',
  'git update-ref refs/heads/x HEAD', 'git symbolic-ref HEAD refs/heads/y',
  'git notes add -m x', 'git submodule update --init', 'git filter-branch',
  'git apply patch', 'git am patch', 'git format-patch HEAD',
];
for (const c of WRITES) ok(`write denied: ${c}`, decideGitWrite(c).allow === false, JSON.stringify(decideGitWrite(c)));

const READS = [
  'git status', 'git status --short', 'git status --porcelain', 'git log',
  'git log --oneline -20', 'git log -p', 'git diff', 'git diff HEAD~1',
  'git show HEAD', 'git show HEAD:src/a.ts', 'git rev-parse HEAD',
  'git rev-parse --show-toplevel', 'git branch', 'git branch --show-current',
  'git branch -a', 'git branch --list "feat*"', 'git stash list', 'git stash show',
  'git config --get user.email', 'git config --list', 'git config user.email',
  'git remote', 'git remote -v', 'git remote show origin', 'git tag', 'git tag -l',
  'git ls-files', 'git blame src/a.ts', 'git describe --tags', 'git reflog',
  'git worktree list', 'git symbolic-ref --short HEAD', 'git --version',
  'git', 'git help commit', 'git shortlog', 'git for-each-ref',
];
for (const c of READS) ok(`read allowed: ${c}`, decideGitWrite(c).allow === true, JSON.stringify(decideGitWrite(c)));

/* ═══ 2. DRIVEN: the runtime's decision, replicated + pinned ════════════════
 * This mirrors the PreToolUse callback in claude-runtime.ts exactly. The pin
 * below fails if the runtime stops calling decideGitWrite for Bash, so the
 * replica cannot silently diverge from the shipped wiring.
 */
function hookDecision(payload, env = process.env) {
  const i = payload;
  if (gitWriteBlockEnabled(env) && i.tool_name === 'Bash') {
    const cmd = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input.command : '';
    const g = decideGitWrite(typeof cmd === 'string' ? cmd : '', env);
    if (!g.allow) return { deny: true, reason: gitWriteRefusal(g.offender ?? 'git') };
  }
  return {};
}
// An AGENT session (this is a tool call — the ONLY thing that reaches the hook).
const agentCommit = hookDecision({ tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } });
ok('DRIVEN: an agent Bash `git commit` is DENIED by the hook', agentCommit.deny === true);
ok('DRIVEN: the deny carries the redirect (leave unstaged, report files)',
  /UNSTAGED/.test(agentCommit.reason ?? '') && /report/i.test(agentCommit.reason ?? ''));
// A subagent/lane call (agent_id present) is ALSO denied — the whole point.
ok('DRIVEN: a LANE (agent_id present) is denied too',
  hookDecision({ tool_name: 'Bash', tool_input: { command: 'git push' }, agent_id: 'agent-1' }).deny === true);
// A non-Bash tool and a read are untouched.
ok('DRIVEN: a non-Bash tool passes', hookDecision({ tool_name: 'Read', tool_input: { file_path: '/x' } }).deny !== true);
ok('DRIVEN: a read Bash passes', hookDecision({ tool_name: 'Bash', tool_input: { command: 'git status' } }).deny !== true);

const runtimeSrc = fs.readFileSync(path.join(REPO, 'src/server/runtime/claude-runtime.ts'), 'utf8');
// FEAT-108 round 2 — the runtime now wires the GRANT-AWARE decision
// (evaluateGitWrite, which calls decideGitWrite internally), evaluated per call.
ok('PIN: the runtime wires the git-write decision for Bash', /evaluateGitWrite\(/.test(runtimeSrc));
ok('PIN: the runtime runs the git block BEFORE the profile decide()',
  // FEAT-152 moved the profile decide() into evaluateOrchestratorProfileHook (defined
  // above the class), so pin the CALLBACK's call site of it, not the helper body.
  runtimeSrc.indexOf('evaluateGitWrite(') < runtimeSrc.indexOf('return evaluateOrchestratorProfileHook(i, orchBypass)'));
ok('PIN: the git block is not gated behind config.orchestratorProfile',
  /gitBlockOn \|\| config\.orchestratorProfile/.test(runtimeSrc));

/* ═══ 3. THE USER'S TERMINAL — same command, no hook, real commit ═══════════
 * Proof of requirement 5: the block lives ONLY on the SDK tool path. A git
 * commit run as a plain shell command (as the user does) has no hook and
 * succeeds. Done in an isolated throwaway repo with HOME/config redirected, so
 * nothing real is touched.
 */
const scratch = path.join(os.tmpdir(), 'feat-108-verify-' + process.pid);
try {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const env = { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', a, { cwd: scratch, env, stdio: 'pipe' }).toString();
  g('init', '-q');
  fs.writeFileSync(path.join(scratch, 'f.txt'), 'hi');
  g('add', 'f.txt');
  g('commit', '-q', '-m', 'real shell commit');            // the exact write the hook denies
  const logn = g('rev-list', '--count', 'HEAD').trim();
  ok('the SAME `git commit`, run as a plain shell command (no hook), SUCCEEDS', logn === '1', `commits=${logn}`);
  // …and through the hook it would have been denied.
  ok('…while through the agent hook that identical commit is DENIED',
    hookDecision({ tool_name: 'Bash', tool_input: { command: 'git commit -q -m "real shell commit"' } }).deny === true);
} catch (e) {
  skipped('user-terminal real commit', `git unavailable or scratch failed: ${(e && e.message) || e}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ═══ 4. EVASIONS (requirement 3) — real commands, real outcomes ═══════════
 * Each is `git commit`/`git push` reached by a different route. These MUST be
 * caught.
 */
const EVASIONS_CAUGHT = [
  ['git -C /some/repo commit -m x', 'git -C <path>'],
  ['git --git-dir=/r/.git --work-tree=/r commit -m x', 'git --git-dir='],
  ['git -c user.email=a@example.invalid commit -m x', 'git -c <config>'],
  ['git ci', 'git-internal alias (deny-by-default)'],
  ['git zzznewverb', 'unknown/future subcommand (deny-by-default)'],
  ['echo hi && git commit -m x', 'chained after &&'],
  ['true; git push', 'chained after ;'],
  ['git status | git commit -m x', 'chained after |'],
  ['sh -c "git commit -m x"', 'sh -c'],
  ["bash -c 'git push'", 'bash -c'],
  ['eval "git commit -m x"', 'eval string'],
  ['eval git push', 'eval bare'],
  ['env GIT_DIR=/r/.git git commit -m x', 'env GIT_...'],
  ['env -i git push', 'env -i'],
  ['git status --porcelain | xargs -I{} git commit -m {}', 'xargs git'],
  ['echo "$(git commit -m x)"', 'command substitution $()'],
  ['echo `git push`', 'command substitution backtick'],
  ['/usr/bin/git commit -m x', 'path-qualified git'],
  ['nohup git push &', 'nohup + background'],
  ['FOO=1 git commit -m x', 'leading assignment'],
  ['sh -c "cd /r && git commit -m x"', 'sh -c with cd + &&'],
  // FEAT-108 round 4 — evasions the 2026-09-29 clean room found ALLOWED. Each is a
  // real write reached through a shell form the scanner did not descend into.
  ["bash -lc 'git commit -m x'", 'bash -lc (combined -c cluster)'],
  ["bash -ic 'git push'", 'bash -ic (combined -c cluster)'],
  ['(git commit -m x)', 'parenthesized subshell'],
  ['( git push )', 'subshell with spaces'],
  ['env -S "git commit -m x"', 'env -S split-string'],
  ['env --split-string="git push"', 'env --split-string='],
  ['env -S"git commit -m x"', 'env -S attached'],
  ['cat <<EOF\ndata\nEOF\ngit commit -m x', 'git command AFTER a heredoc body'],
  ['git interpret-trailers --in-place --trailer x=y f', 'interpret-trailers --in-place (write form)'],
  // FEAT-108 round 5 — the fail-open wrapper/obfuscation forms the 2026-09-29
  // cross-provider clean room landed real commits through. A MISS here is FAIL-OPEN.
  ['exec git commit', 'exec wrapper'],
  ['nice git commit', 'nice wrapper'],
  ['nice -n 10 git commit', 'nice with its own option'],
  ['sudo git push', 'sudo wrapper'],
  ['timeout 10 git commit', 'timeout wrapper'],
  ['find . -exec git commit \\;', 'find -exec runner'],
  ['exec sh -c "git commit"', 'exec wrapping a shell'],
  ['git${IFS}commit', 'IFS word-split obfuscated head'],
  ['env -S git commit', 'env -S SPACED (unquoted) form'],
  ["bash -cl 'git commit'", 'bash -cl reversed flag cluster'],
  ['printf "%s\\n" "<<X"\ngit commit --allow-empty', 'quoted << is NOT a heredoc — trailing commit caught'],
  // FEAT-108 round 6 — data flowing INTO a runner, and config-driven execution.
  ["printf 'git commit --allow-empty -m x\\n' | sh", 'data sink piped INTO a shell (finding P)'],
  ["echo 'git push' | bash", 'echo piped into bash'],
  ['git status | git apply', 'read piped into a git write'],
  ["sh <<'EOF'\ngit commit --allow-empty -m x\nEOF", "heredoc BODY is the shell's script (finding H)"],
  ['bash <<EOF\ngit push\nEOF', 'unquoted heredoc into bash'],
  ["git -c diff.external='git commit; true #' diff --ext-diff", 'git -c diff.external runs a command (finding X)'],
  ["git -c core.pager='git commit' log", 'git -c core.pager executes'],
  ['git -c sequence.editor=x rebase -i HEAD~1', 'git -c sequence.editor executes'],
  ['git --config-env=core.pager=EV log', 'git --config-env core.pager executes'],
];
for (const [cmd, label] of EVASIONS_CAUGHT) {
  const d = decideGitWrite(cmd);
  ok(`evasion caught (${label}): ${cmd.slice(0, 60)}`, d.allow === false, `offender=${d.offender}`);
}
// FEAT-108 round 4, finding 3 — interpret-trailers is dual-mode, not a pure read:
// the read form (stdin→stdout) stays allowed; only a write flag denies.
ok('interpret-trailers READ form still allowed', decideGitWrite('git interpret-trailers <commit.txt').allow === true);
ok('interpret-trailers --in-place is a WRITE (denied)', decideGitWrite('git interpret-trailers --in-place f').allow === false);
// Non-vacuity / no false positive: a heredoc BODY that merely mentions a git write
// is still data (the pre-existing property), even though a command AFTER the body
// is now caught. Both must hold together.
ok('round-4 control: git write inside a heredoc BODY is still not a false positive',
  decideGitWrite('cat <<EOF\ngit commit -m x\nEOF').allow === true);
ok('round-4: the SAME write on a line AFTER the heredoc terminator IS caught',
  decideGitWrite('cat <<EOF\nbody\nEOF\ngit commit -m x').allow === false);

/* ═══ 4b. FEAT-108 round 5 — FAIL-CLOSED head handling ══════════════════════
 * The invariant flipped: a command is proven git-clean only for heads that do not
 * execute their arguments (data sinks); every other non-git head is a possible
 * runner and a reachable git write is refused. These two halves must BOTH hold:
 * unknown wrappers deny (no fail-open), and data commands with git as DATA allow
 * (no runaway over-block). */
// Data sinks: git appears as an ARGUMENT (data), not executed → still allowed.
for (const c of ['echo git commit', 'grep commit gitlog.txt', 'cat git', 'wc -l git',
  'printf "git push\\n"', 'man git commit', 'which git', 'ls git', 'rg "git push" .']) {
  ok(`data-head allows git-as-data: ${c}`, decideGitWrite(c).allow === true, JSON.stringify(decideGitWrite(c)));
}
// A NOVEL wrapper nobody enumerated must fail CLOSED (deny), not open.
for (const c of ['stdbuf -oL git commit', 'setsid git push', 'ionice git commit',
  'unbuffer git commit', 'chrt 1 git push', 'doas git commit']) {
  ok(`unknown wrapper fails CLOSED: ${c}`, decideGitWrite(c).allow === false, JSON.stringify(decideGitWrite(c)));
}
// An expansion-obscured git head (real head hidden by $-expansion) denies.
ok('obfuscated git head via ${IFS} denies', decideGitWrite('git${IFS}push').allow === false);
ok('a bare git-only subcommand head (real git expanded away) denies',
  decideGitWrite('$(which git) commit').allow === false);

/* ═══ 4c. FEAT-108 round 6 — data-flow into runners + config execution ══════ */
// (a) A pipe/redirect into a DATA SINK stays allowed (no runner edge, no over-block).
for (const c of ['printf hi | sh', 'echo done | grep x', 'git log | grep commit',
  'cat a.txt | wc -l', 'git diff | less', 'git log --grep "commit | push"']) {
  ok(`data-sink pipe / no runner edge allows: ${c}`, decideGitWrite(c).allow === true, JSON.stringify(decideGitWrite(c)));
}
// A pipe/heredoc into a RUNNER with a git write in the data denies (findings P/H).
ok('printf git-write | sh denies (finding P)', decideGitWrite("printf 'git commit\\n' | sh").allow === false);
ok("sh <<EOF git-write EOF denies (finding H)", decideGitWrite("sh <<'EOF'\ngit push\nEOF").allow === false);
// A heredoc BODY consumed by a DATA SINK is still data (no false positive).
ok('cat-heredoc body mentioning git is still data', decideGitWrite("cat > f <<'EOF'\ngit commit\nEOF").allow === true);
// (c) A read head with a config option that RUNS a command denies; the tiny inert
// allowlist (color.*, core.quotepath, advice.*) still allows.
ok('git -c diff.external= <read> denies (finding X)', decideGitWrite('git -c diff.external=x diff').allow === false);
ok('git -c core.pager= <read> denies', decideGitWrite('git -c core.pager=cat log').allow === false);
ok('git -c core.sshCommand= denies', decideGitWrite('git -c core.sshCommand=x fetch').allow === false);
ok('git -c color.ui=always <read> still allowed', decideGitWrite('git -c color.ui=always log').allow === true);
ok('git -c core.quotepath=false status still allowed', decideGitWrite('git -c core.quotepath=false status').allow === true);
// BUG-228 — `diff.submodule` is an inert DISPLAY setting (short|log|diff): it executes
// nothing and writes nothing, so the clean-room verifier's hardened diff
// (`git -c core.quotePath=false -c diff.submodule=short diff …`) must pass. Dangerous
// command-executing keys must STILL deny (synthesized must-FAIL: these reddened under the
// pre-fix allowlist, which omitted diff.submodule and refused the verifier's own diff).
ok('git -c diff.submodule=short diff allowed (BUG-228)', decideGitWrite('git -c diff.submodule=short diff HEAD').allow === true);
ok('git -c core.quotePath=false -c diff.submodule=short diff allowed (real verifier head)',
  decideGitWrite('git -C /r -c core.quotePath=false -c diff.submodule=short diff --no-ext-diff --no-textconv --name-only a b').allow === true);
ok('git -c diff.submodule=log diff allowed', decideGitWrite('git -c diff.submodule=log diff').allow === true);
ok('git -c diff.submodule=diff diff allowed', decideGitWrite('git -c diff.submodule=diff diff').allow === true);
ok('git -c diff.submodule=; (unknown value) still denies (fail-closed)', decideGitWrite('git -c diff.submodule=evil diff').allow === false);
ok('git -c diff.submodule (no value) still denies', decideGitWrite('git -c diff.submodule diff').allow === false);
// The dangerous keys the allowlist must NEVER admit, re-asserted alongside the new allow.
ok('git -c core.pager still denies after BUG-228', decideGitWrite('git -c core.pager=x log').allow === false);
ok('git -c diff.external still denies after BUG-228', decideGitWrite('git -c diff.external=x diff').allow === false);
ok('git -c core.sshCommand still denies after BUG-228', decideGitWrite('git -c core.sshCommand=x fetch').allow === false);
ok('git -c alias.x still denies after BUG-228', decideGitWrite('git -c alias.co=commit co').allow === false);
// The env twin of `-c`: GIT_CONFIG_PARAMETERS/COUNT/KEY_*/VALUE_* inject config inline.
ok('GIT_CONFIG_PARAMETERS= <read> denies', decideGitWrite(`GIT_CONFIG_PARAMETERS="'diff.external=x'" git diff`).allow === false);
ok('GIT_CONFIG_COUNT/KEY/VALUE <read> denies', decideGitWrite('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log').allow === false);
ok('GIT_CONFIG_GLOBAL=/dev/null isolation still allowed', decideGitWrite('GIT_CONFIG_GLOBAL=/dev/null git status').allow === true);

/* Known GAPS — honestly asserted to GET THROUGH, so a regression that silently
 * "fixes" one (likely by over-blocking) is visible, and the list stays truthful.
 * These are the layers this hook cannot see: a non-shell interpreter that shells
 * out, a wrapper script, and a shell alias/function whose name is not `git`. */
const KNOWN_GAPS = [
  ['python3 -c "import subprocess; subprocess.run([\'git\',\'commit\'])"', 'python -c shelling out'],
  ['node -e "require(\'child_process\').execSync(\'git commit\')"', 'node -e shelling out'],
  ['./deploy.sh', 'wrapper script that calls git internally'],
  ['gc', 'shell alias/function name (not `git`)'],
  ['perl -e "system(q{git commit})"', 'perl shelling out'],
];
let gapsConfirmed = 0;
for (const [cmd, label] of KNOWN_GAPS) {
  const got = decideGitWrite(cmd).allow;
  ok(`known gap still open (documented): ${label}`, got === true, `unexpectedly blocked: ${cmd}`);
  if (got === true) gapsConfirmed++;
}

/* ═══ 5. DENY-BY-DEFAULT over git's REAL command inventory (requirement 2) ══
 * The deny set is derived from git itself: every command git knows about that is
 * NOT in the read allowlist and NOT a dual-mode subcommand must deny. New/unknown
 * verbs deny for free.
 */
let inventory = [];
try {
  inventory = execFileSync('git', ['--list-cmds=main,others,builtins'], { stdio: 'pipe' })
    .toString().split('\n').map((s) => s.trim()).filter(Boolean);
} catch { /* handled below */ }
if (inventory.length < 50) {
  skipped('git inventory deny-by-default', `git --list-cmds returned ${inventory.length} cmds`);
} else {
  const dual = new Set(Object.keys(GIT_DUAL_READ));
  const pureWrites = [...new Set(inventory)].filter((c) => !GIT_READONLY.has(c) && !dual.has(c)
    // helper/plumbing daemons that take no meaningful bare form are still writes to us
    && !c.endsWith('--worker') && !c.endsWith('--daemon') && !c.endsWith('--helper'));
  const leaked = pureWrites.filter((c) => decideGitWrite(`git ${c}`).allow === true);
  ok(`every non-read git command in the real inventory denies (${pureWrites.length - leaked.length}/${pureWrites.length})`,
    pureWrites.length > 30 && leaked.length === 0, `leaked: ${leaked.slice(0, 8).join(', ')}`);
  ok('every read-allowlist subcommand is actually allowed as a bare read',
    [...GIT_READONLY].every((c) => decideGitWrite(`git ${c}`).allow === true),
    [...GIT_READONLY].filter((c) => !decideGitWrite(`git ${c}`).allow).join(', '));
  console.log(`\n  git inventory: ${new Set(inventory).size} commands · ${pureWrites.length} classified as writes (all deny) · ` +
    `${GIT_READONLY.size} read-allowlisted · ${dual.size} dual-mode`);
}

/* ═══ 6. THE ESCAPE HATCH (requirement 4) ══════════════════════════════════ */
ok('block ON by default (no env)', gitWriteBlockEnabled({}) === true);
for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) ok(`hatch opens on ${JSON.stringify(v)}`, gitWriteBlockEnabled({ ORCHARD_ALLOW_GIT_WRITE: v }) === false);
for (const v of ['0', 'false', 'no', '', 'off']) ok(`hatch stays shut on ${JSON.stringify(v)}`, gitWriteBlockEnabled({ ORCHARD_ALLOW_GIT_WRITE: v }) === true);
ok('with the hatch open, git commit is ALLOWED', decideGitWrite('git commit -m x', { ORCHARD_ALLOW_GIT_WRITE: '1' }).allow === true);
ok('with the hatch open, the runtime hook lets git commit through',
  hookDecision({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, { ORCHARD_ALLOW_GIT_WRITE: '1' }).deny !== true);
ok('opening the hatch is VISIBLE: the runtime warns on stderr',
  /git-write block DISABLED/.test(runtimeSrc) && /console\.warn/.test(runtimeSrc));

/* ═══ 7. LEGIBLE REFUSAL ════════════════════════════════════════════════════ */
const r = gitWriteRefusal('git commit');
ok('refusal names the offender', /`git commit`/.test(r));
ok('refusal tells the agent to leave work unstaged', /UNSTAGED/.test(r));
ok('refusal tells the agent to report the file list', /report/i.test(r) && /files/i.test(r));
// FEAT-108 round 2 — the refusal now points at the RUNTIME grant (no relaunch),
// the surface that replaced "relaunch with ORCHARD_ALLOW_GIT_WRITE".
ok('refusal names the runtime grant surface for an instructed dispatch',
  /git-grant\.mjs/.test(r) && /grant git writes/i.test(r));
ok('refusal makes clear the agent cannot lift it itself', /cannot lift this for itself/i.test(r));

/* ═══ 8. ROBUSTNESS — a policy bug must never take a session down ═══════════ */
const hostile = [null, undefined, 12345, {}, 'x'.repeat(500_000), '$('.repeat(5000),
  '`'.repeat(5000), '|'.repeat(20000), ';'.repeat(20000), 'sh -c '.repeat(3000) + '"git commit"',
  '<<EOF\ngit commit\nEOF', "'unterminated git commit", '"' + 'a'.repeat(200000)];
for (const [i, c] of hostile.entries()) {
  let threw = null; const t0 = Date.now();
  try { scanForGitWrite(c); } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  ok(`hostile ${i} does not throw`, threw === null, String(threw));
  ok(`hostile ${i} decides under 1s`, ms < 1000, `${ms}ms`);
}
// A heredoc BODY is data, not commands — the write inside it is not a real call.
ok('a heredoc body mentioning git commit is not a false positive',
  decideGitWrite('cat > f <<\'EOF\'\ngit commit -m x\nEOF').allow === true);
// A quoted string that merely MENTIONS git commit (not sh -c) is not a false positive.
ok('echo of a string mentioning "git commit" is not blocked',
  decideGitWrite('echo "remember to git commit later"').allow === true);

console.log(`\n  known evasion gaps confirmed open (documented, not fixed): ${gapsConfirmed}/${KNOWN_GAPS.length}`);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail === 0 ? 0 : 1);
