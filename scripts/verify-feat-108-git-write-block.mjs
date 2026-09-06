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
  runtimeSrc.indexOf('evaluateGitWrite(') < runtimeSrc.indexOf('const d = decide('));
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
];
for (const [cmd, label] of EVASIONS_CAUGHT) {
  const d = decideGitWrite(cmd);
  ok(`evasion caught (${label}): ${cmd.slice(0, 60)}`, d.allow === false, `offender=${d.offender}`);
}

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
