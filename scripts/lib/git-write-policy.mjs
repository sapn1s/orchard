/**
 * git-write-policy.mjs — FEAT-108. Deny every git WRITE from an agent session.
 *
 * WHY THIS EXISTS (the user, verbatim): "i think we need to stop commits
 * entirely pls. i will do all the git operations unless instructed otherwise.
 * agents doing it, every time they fuck up by adding some commit detail which
 * causes us to re-create whole main to avoid leaked private details, makes no
 * sense". The precedent: a dispatched LANE committed docs/bugs/BUG-155-*.md
 * carrying 3 absolute home paths, 3 username hits and a private project name.
 * The leak gate detected all 7 correctly and main went red anyway — the gate is
 * ADVISORY at the moment of commit. That is an enforcement gap, not a detection
 * gap, and instruction-based enforcement (a charter line) had already failed.
 *
 * ── Why a SEPARATE module from orchestrator-profile.mjs ──────────────────────
 * That file answers "which tools does the ORCHESTRATOR get?" and its `decide()`
 * EARLY-RETURNS `allow` for any subagent (a lane keeps its full toolset). This
 * policy is a different axis entirely: git writes are denied for EVERY agent
 * session — orchestrator AND lane — because BUG-155 was a lane. Folding a
 * lane-denies-nothing policy and a lane-denies-git policy into one `decide()`
 * would make each harder to read and to test. Two axes, two modules, each "one
 * definition" (ARCH-008). Both ride the same in-process PreToolUse callback in
 * claude-runtime.ts; this one runs FIRST and unconditionally.
 *
 * ── The block is on the TOOL PATH, so the user's terminal is untouched ───────
 * This decides a Bash TOOL CALL inside an SDK PreToolUse hook. A `git commit`
 * the user types into a real terminal never enters the SDK and never reaches
 * this code — there is no PATH shim, no shell alias, no global git hook. The
 * distinction between "agent" and "the user at the keyboard" is therefore
 * structural, not a check we perform: only agent tool calls are ever passed here.
 *
 * ── Deny-by-default is the whole robustness argument (requirement 2) ──────────
 * A hand-typed list of write subcommands is short by whatever nobody thought of,
 * and that failure has recurred on this board. So the READ set is the closed,
 * auditable list (git's read-only/inspection verbs) and EVERYTHING ELSE — every
 * write verb, every plumbing command, every future git subcommand, every
 * git-internal alias (`git ci`) — is classified as a write and denied. The
 * deny set is thus "all of git minus the reads", derived from git's own command
 * inventory rather than enumerated: scripts/verify-feat-108-git-write-block.mjs
 * runs `git --list-cmds` and asserts every command outside the read set denies.
 */

/* ── The escape hatch (requirement 4) ────────────────────────────────────────
 * The user said "unless instructed otherwise". `ORCHARD_ALLOW_GIT_WRITE=1`
 * disables the block for one dispatch. Enabling it is made VISIBLE, not silent —
 * claude-runtime.ts announces "[orchard] git-write block DISABLED …" on stderr
 * once per session when the hatch is open, so an opened hatch is never quiet.
 */
export function gitWriteBlockEnabled(env = process.env) {
  const v = env.ORCHARD_ALLOW_GIT_WRITE;
  if (v == null) return true; // block ON by default
  const s = String(v).trim().toLowerCase();
  return !(s === '1' || s === 'true' || s === 'yes' || s === 'on');
}

/**
 * PURE-READ git subcommands: inspection only, no change to refs, objects, the
 * index, the working tree, config or history. This is the CLOSED list; anything
 * not here is treated as a write (deny-by-default). Transcribed against the real
 * `git --list-cmds=main,others,builtins` inventory (git 2.x) so the choice of
 * what to omit is deliberate, not accidental — see the verify script.
 */
export const GIT_READONLY = new Set([
  'status', 'log', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files',
  'blame', 'cat-file', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'ls-remote', 'describe', 'name-rev', 'shortlog', 'whatchanged', 'grep',
  'count-objects', 'show-ref', 'for-each-ref', 'merge-base', 'cherry', 'var',
  'help', 'version', 'check-ignore', 'check-attr', 'check-mailmap',
  'check-ref-format', 'verify-commit', 'verify-tag', 'verify-pack',
  'get-tar-commit-id', 'annotate', 'range-diff', 'show-branch', 'show-index',
  'patch-id', 'stripspace', 'url-parse', 'fmt-merge-msg',
  // `git archive` reads a tree and emits a tarball; it mutates no ref, object,
  // index, working tree, config or history in ANY form. It is a pure read and
  // was missing here (BUG-165), which deny-by-default then mis-classified as a
  // write — silently disabling the entire clean-room export
  // (scripts/independent-verify.mjs pipes `git archive <rev> | tar -x`), so no
  // dispatch could verify itself (WA §I). ALL forms are allowed deliberately,
  // including `git archive --output=<path>`: `--output` writes a tarball to a
  // FILESYSTEM path, which is an ordinary file write the agent already has via
  // every other channel — it is not a repo mutation and cannot carry anything
  // into git history, which is the only leak vector this backstop guards. A
  // stdout-only predicate would add a special-case dual-read for zero safety
  // gain, so `archive` is an unconditional read.
  'archive',
]);

/* ── Dual-mode subcommands: read in some forms, write in others ───────────────
 * `git branch` lists; `git branch foo` creates. `git config --get x` reads;
 * `git config x y` writes. Each predicate returns TRUE only for the read form;
 * every other form (including the write form and anything ambiguous) is denied.
 * The predicates err toward denial: an unrecognised shape is NOT a read.
 */
const has = (args, names) => {
  const set = new Set(names);
  return args.some((a) => set.has(a) || (a.startsWith('--') && set.has(a.split('=')[0])));
};
/** First bare (non-flag) argument, skipping the values of value-taking flags. */
function firstPositional(args, valueFlags = new Set()) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1] ?? '';
    if (a.startsWith('-')) { if (valueFlags.has(a)) i++; continue; }
    return a;
  }
  return '';
}
function countPositionals(args, valueFlags = new Set()) {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { n += args.length - i - 1; break; }
    if (a.startsWith('-')) { if (valueFlags.has(a)) i++; continue; }
    n++;
  }
  return n;
}

const BRANCH_WRITE = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C',
  '--copy', '--set-upstream-to', '-u', '--unset-upstream', '--set-upstream', '--edit-description'];
const BRANCH_VALUEFLAGS = new Set(['--contains', '--no-contains', '--merged',
  '--no-merged', '--points-at', '--sort', '--format', '--color', '-l', '--list']);
const TAG_WRITE = ['-a', '--annotate', '-s', '--sign', '-d', '--delete', '-f',
  '--force', '-m', '--message', '-F', '--file', '-u', '--local-user', '-e', '--edit', '--create-reflog'];
const TAG_VALUEFLAGS = new Set(['--contains', '--no-contains', '--points-at',
  '--merged', '--no-merged', '--sort', '--format', '--color', '-n', '-l', '--list']);
const CONFIG_WRITE = ['--add', '--replace-all', '--unset', '--unset-all',
  '--rename-section', '--remove-section', '--edit', '-e'];
const CONFIG_VALUEFLAGS = new Set(['-f', '--file', '--blob', '--type', '-t', '--default']);

/** Read-form predicates. TRUE ⇒ allow; anything else about the subcommand ⇒ deny. */
export const GIT_DUAL_READ = {
  branch: (a) => !has(a, BRANCH_WRITE) && countPositionals(a, BRANCH_VALUEFLAGS) === 0,
  tag: (a) => !has(a, TAG_WRITE) && countPositionals(a, TAG_VALUEFLAGS) === 0,
  config: (a) => !has(a, CONFIG_WRITE) && countPositionals(a, CONFIG_VALUEFLAGS) < 2,
  remote: (a) => ['', 'show', 'get-url'].includes(firstPositional(a)),
  stash: (a) => ['list', 'show'].includes(firstPositional(a)),
  reflog: (a) => ['', 'show'].includes(firstPositional(a)),
  'symbolic-ref': (a) => !has(a, ['-d', '--delete']) && countPositionals(a) <= 1,
  worktree: (a) => firstPositional(a) === 'list',
  notes: (a) => ['', 'list', 'show'].includes(firstPositional(a)),
  submodule: (a) => ['', 'status', 'summary'].includes(firstPositional(a)),
  bundle: (a) => ['verify', 'list-heads'].includes(firstPositional(a)),
  // `git interpret-trailers` reads stdin → stdout (a pure read) UNLESS `--in-place`
  // is given, which REWRITES the named file in the working tree (FEAT-108 round-4
  // finding 3). The read form is allowed; `--in-place` (any write flag) denies.
  'interpret-trailers': (a) => !has(a, ['--in-place']),
};

/* ── GATE_EXEMPT_WRITES: granted writes that need no leak gate (FEAT-108 round 4) ──
 * The mandatory leak gate exists to stop repo CONTENT reaching git history or a
 * remote. Most git writes cannot do that: they mutate the index, the working tree,
 * local refs or config only. This is the CLOSED allowlist of those — the exact
 * analogue of GIT_READONLY. The grant path (git-grant.mjs) runs the gate on any
 * granted write whose subcommand is NOT here; so a publish (commit/push), an alias
 * (`git -c alias.x=commit x` → unknown sub `x`), an unknown/future verb, or a
 * publish CHAINED after one of these (`git add f && git commit`) all gate — closing
 * round-4 finding 1 and the alias evasion with ONE rule, not an enumeration of
 * publishers. Fail-closed: forgetting an entry only makes us stricter (over-gate),
 * never opens a leak. `add` MUST stay here — a granted `git add` with a failing or
 * absent gate is allowed by contract (verify-feat-108-git-grant, verify-bug-173).
 */
export const GATE_EXEMPT_WRITES = new Set([
  'add', 'rm', 'mv', 'reset', 'restore', 'checkout', 'switch', 'stash', 'clean',
  'branch', 'tag', 'config', 'remote', 'notes', 'symbolic-ref', 'submodule',
  'worktree', 'update-index', 'update-ref', 'sparse-checkout', 'reflog',
]);

/* ── git's GLOBAL options, which sit BEFORE the subcommand ────────────────────
 * `git -C <path> commit` and `git --git-dir=… commit` are the named evasions
 * (requirement 3): the real subcommand is `commit`, reached past a global
 * option. To find it we must skip these — and skip the VALUE of the ones that
 * take a separate token, or `git -C /repo commit` reads `/repo` as the
 * subcommand and sails through.
 */
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree',
  '--namespace', '--exec-path', '--config-env', '--super-prefix', '--attr-source']);

/* ── Config-driven execution is a write on ANY head (FEAT-108 round 5, finding X) ─
 * `git -c diff.external='git commit …' diff` runs an arbitrary command through a
 * config option while the SUBCOMMAND (`diff`) reads as inert — so a read head
 * smuggles a write past the read allowlist. `core.pager`, `core.sshCommand`,
 * `sequence.editor`, `alias.*`, `*.textconv`, `filter.*`, `core.hooksPath`,
 * `core.fsmonitor` are all command-executing. Rather than enumerate the dangerous
 * keys (a losing game), a `-c`/`--config-env`/attached `-cKEY=` on ANY git head is
 * a WRITE unless the key is on this TINY allowlist of inert display settings —
 * fail-closed, so a config option nobody thought of denies. */
const CONFIG_KEY_ALLOWED = (raw) => {
  const s = String(raw ?? '');
  const eq = s.indexOf('='); // git splits a `-c key=value` on the FIRST '='
  const key = (eq >= 0 ? s.slice(0, eq) : s).trim().toLowerCase();
  if (key === 'core.quotepath' || key.startsWith('color.') || key.startsWith('advice.')) return true;
  // `diff.submodule` only selects HOW a submodule's changes are DISPLAYED (short |
  // log | diff per git-config(1)); it executes nothing and writes nothing — same
  // inert-display class as core.quotepath above, refused before only by omission
  // (BUG-228). The clean-room verifier (scripts/independent-verify.mjs) forces
  // `-c diff.submodule=short` so repo config can't inline a submodule's internal
  // patch into the diff it shows the verifier (BUG-186); without this that whole
  // path — ALL dispatch self-verification — is blocked. Restricted to its three
  // documented values, so a value nobody thought of still denies (fail-closed).
  if (key === 'diff.submodule') {
    const val = (eq >= 0 ? s.slice(eq + 1) : '').trim().toLowerCase();
    return val === 'short' || val === 'log' || val === 'diff';
  }
  return false;
};

/** The first non-allowlisted `-c`/`--config-env` config KEY on a git invocation, or null. */
function offendingConfigKey(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--version' || t === '--help' || t === '-h') return null;
    if (t === '-c' || t === '--config-env') { const v = tokens[i + 1]; if (!CONFIG_KEY_ALLOWED(v)) return String(v ?? '(missing)').split('=')[0]; i += 2; continue; }
    if (t.startsWith('--config-env=')) { const v = t.slice(13); if (!CONFIG_KEY_ALLOWED(v)) return v.split('=')[0]; i++; continue; }
    if (t.startsWith('-c') && t.length > 2) { const v = t.slice(2); if (!CONFIG_KEY_ALLOWED(v)) return v.split('=')[0]; i++; continue; }
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    return null; // reached the subcommand with no offending config
  }
  return null;
}

/**
 * From the tokens of a `git …` invocation (index 0 == 'git'), return the
 * subcommand and its args, having skipped global options. Returns null when
 * there is no subcommand (bare `git`, `git --version`, `git --help`) — those are
 * info/usage and are allowed.
 */
function gitSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--version' || t === '--help' || t === '-h') return null; // info
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { i += 2; continue; } // opt + its value
    if (t.startsWith('-')) { i++; continue; } // any other global flag (=-form or bare)
    return { sub: t, args: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Decide one already-isolated `git …` token array. Returns an offender or null.
 * Exported (FEAT-135) so the invocation-layer git shim reuses this EXACT read /
 * write classification — one definition of "what is a git write" (ARCH-008),
 * shared by the command-string hook and the PATH shim.
 */
export function offenderForGit(tokens) {
  // Config-driven execution (round-5 finding X): a `-c <key>` that runs a command
  // makes even a read head a write. Checked BEFORE the subcommand classification so
  // `git -c diff.external=… diff` cannot pass as the inert `diff` read.
  const badKey = offendingConfigKey(tokens);
  if (badKey != null) return `git -c ${badKey}`;
  const parsed = gitSubcommand(tokens);
  if (!parsed) return null; // bare git / --version / --help
  const { sub, args } = parsed;
  if (GIT_READONLY.has(sub)) return null;
  const dual = GIT_DUAL_READ[sub];
  if (dual && dual(args)) return null;
  return `git ${sub}`; // write, unknown, or write-form dual → DENY (deny-by-default)
}

/* ── Quote-aware tokenizer ────────────────────────────────────────────────────
 * The orchestrator profile's parser BLANKS quoted spans (they are data there).
 * This policy cannot: `sh -c 'git commit'` hides the whole write inside a quoted
 * string. So this tokenizer keeps quoted content as token text (a quoted span is
 * one token) and splits into segments on ; && || | & and newline only OUTSIDE
 * quotes. That single property is what lets the exec-string cases below reach in.
 */
function tokenizeSegments(str) {
  const segments = [];
  let cur = [];
  let tok = '';
  let hasTok = false; // true once a token has begun (so an empty '' is still a token)
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false; } };
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = []; } };
  let i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === '\\') { tok += str[i + 1] ?? ''; hasTok = true; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const close = str.indexOf(ch, i + 1);
      if (close < 0) { tok += str.slice(i + 1); hasTok = true; break; }
      tok += str.slice(i + 1, close); hasTok = true; i = close + 1; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pushTok(); i++; continue; }
    if (ch === '\n' || ch === ';') { pushSeg(); i++; continue; }
    if (ch === '&') { pushSeg(); i += str[i + 1] === '&' ? 2 : 1; continue; }
    if (ch === '|') { pushSeg(); i += str[i + 1] === '|' ? 2 : 1; continue; }
    // Subshell / grouping parens are segment boundaries: `(git branch x)` must not
    // fuse `(git` into one token that hides the head (FEAT-108 round-4 finding 2).
    // `$( )` command substitutions are stripped BEFORE tokenizing, so any paren
    // left here is a subshell/group or arithmetic — treating it as a break is safe
    // (an arithmetic operand is never a command head).
    if (ch === '(' || ch === ')') { pushSeg(); i++; continue; }
    if (ch === '#' && !hasTok) { const nl = str.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    tok += ch; hasTok = true; i++;
  }
  pushSeg();
  return segments;
}

/** Leading no-op words that are not the command itself. `command git commit` is a commit. */
const NOOP_HEADS = new Set(['command', 'nohup', 'time', 'builtin', '!', '{', '}',
  'then', 'else', 'elif', 'do', 'done', 'fi', 'in', 'if', 'for', 'while', 'until', 'case', 'esac']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXEC_C = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

/* ── FAIL-CLOSED head handling (FEAT-108 round 5) ─────────────────────────────
 * Rounds 1-4 tried to ENUMERATE the shells/wrappers a git write can hide behind
 * (sh -c, env, xargs, eval …) and SKIPPED every other head, so `exec git commit`,
 * `nice git commit`, `sudo git push`, `timeout 10 git commit`,
 * `find … -exec git commit`, `git${IFS}commit` and `env -S git commit` all sailed
 * through — and a MISS here is FAIL-OPEN (a real, ungated commit runs). Round 5
 * flips the default. A command is proven git-clean ONLY when its head is one that
 * DOES NOT execute its arguments as a command (NON_RUNNER_HEADS — echo/printf/
 * grep/…, pure data sinks). EVERY other non-git head is treated as a possible
 * command RUNNER: if a bare `git` write is reachable in its tokens, or a nested
 * shell it wraps, that write is refused. So a wrapper nobody enumerated fails
 * CLOSED. See INVARIANT on classifyTokens.
 */
const NON_RUNNER_HEADS = new Set([
  'echo', 'printf', 'print', 'cat', 'tac', 'less', 'more', 'head', 'tail',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'man', 'which', 'type', 'whatis',
  'apropos', 'wc', 'ls', 'stat', 'file', 'base64', 'md5sum', 'sha1sum',
  'sha256sum', 'cksum', 'dirname', 'basename', 'realpath', 'readlink', 'true',
  'false', 'test', 'printenv', 'pwd', 'hostname', 'date', 'seq', 'yes', 'tee',
]);

/* git subcommands that are NOT also ordinary system commands. Seeing one as a bare
 * command HEAD means the real `git` head was expanded/aliased away
 * (`$(which git) commit`) — refuse. `rm`/`mv`/`reset`/`config`/`branch`/`tag` are
 * omitted on purpose: they ARE real commands, so a bare `rm` head is the system rm. */
const GIT_ONLY_SUBCMDS = new Set(['commit', 'push', 'fetch', 'pull', 'merge',
  'rebase', 'cherry-pick', 'revert', 'stash', 'checkout', 'switch', 'clone',
  'am', 'format-patch', 'interpret-trailers']);

/** Strip a `/usr/bin/git`-style path down to the basename so the head is `git`. */
function basename(word) {
  return word.includes('/') && !word.startsWith('-') ? word.slice(word.lastIndexOf('/') + 1) : word;
}

/** Head (first real command word) and its args for one segment's tokens. */
function headOf(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || NOOP_HEADS.has(tokens[i]))) i++;
  const rest = tokens.slice(i);
  if (!rest.length) return null;
  return { head: basename(rest[0]), args: rest.slice(1), all: [basename(rest[0]), ...rest.slice(1)] };
}

const MAX_DEPTH = 8;

/* ── Strip quotes, keeping inner content as splittable text (round 5, finding P) ─
 * `printf 'git commit' | sh` hides the write in printf's DATA, which `sh` then
 * executes. To see it we drop the quote CHARACTERS but keep the content, so the
 * data tokenizes into words a git-write scan can find. */
function flattenQuotes(text) {
  let out = ''; let sq = false, dq = false; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (sq) { if (ch === "'") sq = false; else out += ch; i++; continue; }
    if (dq) { if (ch === '"') dq = false; else if (ch === '\\') { out += (text[i + 1] ?? ''); i += 2; continue; } else out += ch; i++; continue; }
    if (ch === "'") { sq = true; i++; continue; }
    if (ch === '"') { dq = true; i++; continue; }
    if (ch === '\\') { out += (text[i + 1] ?? ''); i += 2; continue; }
    out += ch; i++;
  }
  return out;
}

/** Head (first real command word) of a raw text fragment, or '' — used to test a
 * pipe/redirect consumer or a heredoc consumer without a full parse. */
function textHead(fragment) {
  const words = String(fragment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || NOOP_HEADS.has(words[i]))) i++;
  return words[i] ? basename(words[i]) : '';
}

/** True if `head` is NOT a proven data sink — i.e. it may execute what it is fed
 * (a shell, xargs, an unknown command). The fail-closed side of the pipe/redirect
 * rule: a consumer we cannot prove inert is treated as a runner. */
const isRunnerConsumer = (head) => head !== '' && !NON_RUNNER_HEADS.has(head);

/* ── Pipe / redirect INTO a runner (FEAT-108 round 5, finding P) ──────────────
 * A `|` whose downstream head is not a data sink, or a `<`/`<<<` stdin redirect
 * into a non-data-sink, makes the upstream/redirected DATA executable. Detected on
 * the QUOTE-FLATTENED text (so an operator inside quotes is not mistaken for a real
 * one — and conversely a git write inside quoted data becomes visible). */
function feedsRunner(command) {
  const flat = flattenQuotes(command);
  // pipes: protect `||`, then split on single `|`; any stage after the first whose
  // head is a runner is a runner edge.
  const stages = flat.replace(/\|\|/g, '\u0001').split('|');
  for (let s = 1; s < stages.length; s++) if (isRunnerConsumer(textHead(stages[s]))) return true;
  // stdin redirects (`<`, `<<<`; heredoc `<<` bodies are handled separately): the
  // consumer is the command that owns the redirect on its simple-command segment.
  for (const seg of flat.split(/;|\n|&&|\u0001|&|\(|\)/)) {
    if (/(^|\s)<(?!<)/.test(seg) || /<<</.test(seg)) { if (isRunnerConsumer(textHead(seg))) return true; }
  }
  return false;
}

/* ── Quote-aware heredoc parse (FEAT-108 rounds 4-5, findings B + H) ───────────
 * Heredoc BODIES are DATA when the consumer is a data sink (`cat <<EOF …`), but
 * when the consumer is a RUNNER the body IS that runner's script (`sh <<EOF
 * git commit EOF` — round-5 finding H). So: parse quote-awarely; for each heredoc
 * whose consumer head is a runner, RETURN its body to be scanned as command text;
 * for the rest, drop the body. Either way the opener line and everything after the
 * terminator survive in `stripped` (so a command AFTER the body is still scanned,
 * round-4 finding). A `<<` inside quotes is not an opener (round-4 finding B).
 */
function parseHeredocs(command) {
  if (!command.includes('<<')) return { stripped: command, runnerBodies: [] };
  let out = '';
  let sq = false, dq = false;
  let lineText = ''; // current logical line up to the current point (for consumer head)
  const pending = []; // { delim, dash, capture }
  const runnerBodies = [];
  let i = 0; const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === '\n') {
      out += ch; lineText = ''; i++;
      while (pending.length) {
        const d = pending.shift();
        const body = [];
        while (i < n) {
          let j = command.indexOf('\n', i);
          if (j < 0) j = n;
          const line = command.slice(i, j);
          const trimmed = d.dash ? line.replace(/^\t+/, '') : line;
          i = j < n ? j + 1 : n;
          if (trimmed === d.delim) break; // terminator consumed, not emitted
          body.push(line);
        }
        if (d.capture) runnerBodies.push(body.join('\n'));
      }
      continue;
    }
    if (sq) { out += ch; lineText += ch; if (ch === "'") sq = false; i++; continue; }
    if (dq) {
      if (ch === '\\') { const s = ch + (command[i + 1] ?? ''); out += s; lineText += s; i += 2; continue; }
      out += ch; lineText += ch; if (ch === '"') dq = false; i++; continue;
    }
    if (ch === '\\') { const s = ch + (command[i + 1] ?? ''); out += s; lineText += s; i += 2; continue; }
    if (ch === "'") { sq = true; out += ch; lineText += ch; i++; continue; }
    if (ch === '"') { dq = true; out += ch; lineText += ch; i++; continue; }
    if (ch === '<' && command[i + 1] === '<') {
      const m = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(command.slice(i));
      if (m) {
        // Consumer = the last simple command on this line before the `<<`.
        const lastCmd = flattenQuotes(lineText).split(/;|&&|\|\||\||&/).pop() ?? '';
        pending.push({ delim: m[3], dash: m[1] === '-', capture: isRunnerConsumer(textHead(lastCmd)) });
        out += m[0]; lineText += m[0]; i += m[0].length; continue;
      }
    }
    out += ch; lineText += ch; i++;
  }
  return { stripped: out, runnerBodies };
}

/**
 * Classify ONE simple command's tokens, calling `sink(offender)` for a git write
 * (sink returns true to STOP). Returns true once sink stopped.
 *
 * INVARIANT (round 5): the tokens are proven git-clean ONLY when the head is `git`
 * classifying as a read, a data sink (NON_RUNNER_HEADS), or a non-git command with
 * no reachable git write. A non-git, non-data head is a possible RUNNER: a bare
 * `git` write in its tokens, a shell it wraps, an expansion-obscured git head, or a
 * git-only subcommand standing as the head (real head expanded away) are all
 * refused. Anything git-writeish the parser cannot decide fails CLOSED.
 */
function classifyTokens(tokens, depth, sink) {
  if (depth > MAX_DEPTH) return sink('git (undecidable — depth)');
  const h = headOf(tokens);
  if (!h) return false;
  const { head, args, all } = h;

  // A plain `git …` invocation — the ordinary path. A leading `GIT_CONFIG_PARAMETERS`
  // / `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` env assignment
  // injects arbitrary config inline (the env twin of `-c` — round-5 finding X, rule c),
  // so it is a WRITE on ANY git head, read or not. (`GIT_CONFIG_GLOBAL`/`_SYSTEM` point
  // to config FILES and are left alone — the `=/dev/null` isolation idiom is common;
  // a malicious file path is a documented residual.)
  if (head === 'git') {
    if (tokens.some((t) => ASSIGNMENT.test(t) && /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_|VALUE_)/.test(t))) return sink('git (GIT_CONFIG env injection)');
    const o = offenderForGit(all); return o ? sink(o) : false;
  }

  // A bare git-ONLY subcommand as the head ⇒ the real `git` was expanded/aliased away.
  if (GIT_ONLY_SUBCMDS.has(head)) return sink(`git ${head}`);

  // A head that CONTAINS `git`, is not literally git, and carries an expansion
  // (`git${IFS}commit`, `${g}git push`) is an obfuscated git head — fail closed.
  if (/git/.test(head) && /[$`{}]/.test(head)) return sink('git (obfuscated head)');

  // `env …` — assignments + env's own options, then the command. `-S`/`--split-string`
  // is transparent: its value + the rest form the command string env splits and runs
  // (`env -S git commit` and `env -S "git commit"` alike — round-5 finding A).
  if (head === 'env') {
    let j = 0;
    while (j < args.length) {
      const a = args[j];
      if (ASSIGNMENT.test(a)) { j++; continue; }
      if (a === '-i' || a === '--ignore-environment' || a === '-') { j++; continue; }
      if (a === '-u' || a === '-C') { j += 2; continue; }
      if (a === '-S' || a === '--split-string') { j++; continue; }
      if (a.startsWith('--split-string=')) { if (walkGitWrites(a.slice(15), depth + 1, sink)) return true; j++; continue; }
      if (a.startsWith('-S')) { if (walkGitWrites(a.slice(2), depth + 1, sink)) return true; j++; continue; }
      if (a.startsWith('-')) { j++; continue; }
      break;
    }
    // Re-tokenize the remainder as ONE string: env's `-S` splits its value on
    // whitespace, so a QUOTED `-S "git push"` (one token) must be re-split, and a
    // spaced `-S git push` (already two tokens) joins back to the same command.
    return walkGitWrites(args.slice(j).join(' '), depth + 1, sink);
  }

  // `sh -c '…'` / `bash -lc '…'` / `bash -cl '…'` — the command is a code STRING.
  // The shell's `-c` takes the next word as that string regardless of flag-cluster
  // order (`-lc`/`-cl`) or attached form (`-cCMD`), plus positional args ($0,$1…).
  // Recurse into EVERY non-flag argument (and any attached `-cCMD`) so no ordering
  // or extra positional can hide the write (round-5 finding A — `bash -cl`).
  if (EXEC_C.has(head)) {
    for (const a of args) {
      if (a.startsWith('-')) {
        const mm = /^-[a-z]*c([^-].*)$/.exec(a);
        if (mm && walkGitWrites(mm[1], depth + 1, sink)) return true;
        continue;
      }
      if (walkGitWrites(a, depth + 1, sink)) return true;
    }
    return false;
  }

  // `eval "git commit"` / `eval git commit` — the arguments ARE the command.
  if (head === 'eval') return walkGitWrites(args.join(' '), depth + 1, sink);

  // `xargs [flags] git commit` (or `xargs sh -c '…'`).
  if (head === 'xargs') {
    const gi = args.findIndex((a) => basename(a) === 'git');
    if (gi >= 0) { const o = offenderForGit(['git', ...args.slice(gi + 1)]); if (o && sink(o)) return true; }
    const si = args.findIndex((a) => EXEC_C.has(basename(a)) || basename(a) === 'env');
    if (si >= 0 && classifyTokens(args.slice(si), depth + 1, sink)) return true;
    return false;
  }

  // A DATA SINK — does not execute its args, so a `git` among them is data. Clean.
  if (NON_RUNNER_HEADS.has(head)) return false;

  // GENERIC RUNNER (fail-closed): any other head may exec a git write in its args.
  // (1) a nested shell / env / eval / xargs it wraps (`exec sh -c '…'`, `sudo env …`).
  for (let k = 0; k < all.length; k++) {
    const b = basename(all[k]);
    if (EXEC_C.has(b) || b === 'env' || b === 'eval' || b === 'xargs') {
      if (classifyTokens(all.slice(k), depth + 1, sink)) return true;
      break;
    }
  }
  // (2) a bare `git` write token anywhere in its arguments
  //     (`exec`/`nice`/`sudo`/`timeout`/`find … -exec … git commit`).
  for (let k = 1; k < all.length; k++) {
    if (basename(all[k]) === 'git') { const o = offenderForGit(all.slice(k)); if (o && sink(o)) return true; }
  }
  return false;
}

/**
 * ONE shared walker (ARCH-010): call `sink(offender)` for every git WRITE reachable
 * at this layer, in source order. `sink` returns true to STOP (scanForGitWrite wants
 * only the first). Fail-closed per-command head handling lives in classifyTokens.
 * Recurses into command substitutions; heredoc bodies are stripped quote-awarely.
 * What it still CANNOT see (documented gaps; the FEAT-135 PATH shim is the backstop):
 * a non-shell interpreter that shells out (`python -c`, `node -e`), a wrapper SCRIPT,
 * and a shell alias/function not named `git`.
 */
function walkGitWrites(command, depth, sink) {
  if (typeof command !== 'string' || depth > MAX_DEPTH) return false;

  // Heredocs (round-5 finding H): a body consumed by a RUNNER is that runner's
  // script — scan it as command text; a body consumed by a data sink is dropped.
  // Either way the opener line + post-terminator commands survive in `src`.
  const { stripped: src, runnerBodies } = parseHeredocs(command);
  for (const body of runnerBodies) if (walkGitWrites(body, depth + 1, sink)) return true;

  // Data flow into a runner (round-5 finding P): a pipe/redirect whose consumer is
  // not a data sink executes the DATA fed to it, so quoted/redirected data counts as
  // command text. Emit EVERY git write visible in the flattened line (not just the
  // first) so collectGitWrites sees a publish hidden in the piped data and still
  // gates it — rule (a), fail-closed.
  if (feedsRunner(src)) {
    const words = flattenQuotes(src).split(/[\s;&|()<>]+/).filter(Boolean);
    for (let k = 0; k < words.length; k++) {
      if (basename(words[k]) === 'git') { const o = offenderForGit(words.slice(k)); if (o && sink(o)) return true; }
    }
  }

  // Command substitutions are commands. Recurse into each body, then blank them so
  // their contents are not re-read as arguments.
  const subs = [];
  const flattened = src
    .replace(/\$\(([^()]*)\)/g, (_m, b) => { subs.push(b); return ' '; })
    .replace(/`([^`]*)`/g, (_m, b) => { subs.push(b); return ' '; });
  for (const body of subs) if (walkGitWrites(body, depth + 1, sink)) return true;

  for (const tokens of tokenizeSegments(flattened)) {
    if (classifyTokens(tokens, depth, sink)) return true;
  }
  return false;
}

/**
 * The FIRST git WRITE reachable in a Bash command (`git <sub>`) or null. Thin
 * wrapper over the shared walker — the enforcing hook's allow/deny answer.
 */
export function scanForGitWrite(command, depth = 0) {
  let found = null;
  walkGitWrites(command, depth, (o) => { found = o; return true; });
  return found;
}

/**
 * ALL git-write offenders in a command, in source order (FEAT-108 round 4). The
 * grant-time leak-gate decision needs EVERY write, not just the first: a publish
 * chained after a non-publish write (`git add f && git commit`) must not skip the
 * mandatory gate. Same walker, so the hook's classification and this can't diverge.
 */
export function collectGitWrites(command, depth = 0) {
  const out = [];
  walkGitWrites(command, depth, (o) => { out.push(o); return false; });
  return out;
}

/**
 * THE decision, called by the enforcing hook and by the tests (one answer per
 * repo). `{ allow, offender }`. When the escape hatch is open, everything allows.
 */
export function decideGitWrite(command, env = process.env) {
  if (!gitWriteBlockEnabled(env)) return { allow: true, offender: null };
  const offender = scanForGitWrite(typeof command === 'string' ? command : '');
  return offender ? { allow: false, offender } : { allow: true, offender: null };
}

/* ── BUG-231 — can every git write in this command be PROVEN to reach the shim? ──
 * The FEAT-135 shim sees a git invocation only when `git` is resolved through the
 * session's PATH. When the PreToolUse hook can prove that for EVERY write in a Bash
 * command, it may leave the leak gate to the shim, which runs it at the moment of
 * the write (and so also catches a leak the command itself creates before it
 * commits). When it cannot, the hook keeps its pre-exec gate exactly as before.
 *
 * Deliberately CONSERVATIVE, and only ever used to choose WHERE the gate runs,
 * never WHETHER: a false "no" costs one extra gate run; a false "yes" would let a
 * bypassing write skip the gate. So anything that could change how `git` resolves —
 * any mention of PATH, a path-qualified head, a wrapper/runner head, a function or
 * alias definition, sourcing, command substitution, heredocs, process substitution,
 * piping into a runner — answers false. A user-defined shell function routing a verb
 * to an absolute git is caught separately by the per-verb reach proof in
 * git-grant.mjs (a verb defers only after the shim has observed that verb).
 */
const SHIM_UNSURE_HEADS = new Set(['env', 'command', 'builtin', 'exec', 'eval', 'source', '.', 'hash',
  'alias', 'unalias', 'unset', 'enable', 'function', 'sudo', 'doas', 'su', 'xargs', 'export', 'declare',
  'typeset', 'local', 'readonly', 'set', 'shopt', 'trap', 'nohup', 'time', 'nice', 'timeout', 'find',
  'stdbuf', 'chroot', 'setsid', 'unshare', 'nsenter', 'flock', 'watch', 'parallel']);
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'then', 'else', 'elif', 'do', 'done', 'fi', 'in', 'if',
  'for', 'while', 'until', 'case', 'esac']);

/** BUG-231 — the git writes in a command whose head is a literal bare `git` (after
 * leading assignments / shell keywords): the invocations that CAN reach the shim, so
 * the only ones a hook decision opens a redeemable slot for. Source order. */
export function bareGitWrites(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const out = [];
  for (const tokens of tokenizeSegments(command)) {
    let i = 0;
    while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || SHELL_KEYWORDS.has(tokens[i]))) i++;
    if (tokens[i] !== 'git') continue;
    const o = offenderForGit(tokens.slice(i));
    if (o) out.push(o);
  }
  return out;
}

export function gitWritesReachShim(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/PATH/.test(command)) return false;                       // any PATH mention, anywhere
  if (/\$\(|`|<<|<\(|>\(|\(\s*\)/.test(command)) return false;  // substitutions, heredocs, function defs
  if (feedsRunner(command)) return false;                      // data piped/redirected into a runner
  const all = collectGitWrites(command);
  if (!all.length) return false;
  let seen = 0;
  for (const tokens of tokenizeSegments(command)) {
    let i = 0;
    while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || SHELL_KEYWORDS.has(tokens[i]))) i++;
    const rest = tokens.slice(i);
    if (!rest.length) continue;
    const head = rest[0];
    if (SHIM_UNSURE_HEADS.has(head) || EXEC_C.has(basename(head))) return false;
    if (head !== 'git' && basename(head) === 'git') return false; // a path-qualified git never meets the shim
    let found = 0;
    walkGitWrites(rest.join(' '), 0, () => { found++; return false; });
    if (!found) continue;
    if (head !== 'git') return false;                           // a write reached through some other head
    if (tokens.slice(0, i).some((t) => /^GIT_CONFIG_/.test(t))) return false;
    seen += found;
  }
  return seen === all.length;
}

/**
 * What a refused git write tells the agent. The user's whole complaint is that a
 * silent commit leaked private paths; the fix is not just to refuse but to
 * redirect — leave the work in the tree, report the files, let the user commit.
 */
export function gitWriteRefusal(offender) {
  return [
    `Git writes are disabled for agent sessions: \`${offender}\` (via Bash) was blocked.`,
    '',
    'The user does ALL git operations by hand. An agent commit that carried a home',
    'path or a private name into a public history has cost a full rewrite of main',
    'more than once, so no agent — orchestrator or lane — commits, adds, stashes,',
    'resets, pushes, or otherwise writes git. That trade is deliberate: losing',
    'uncommitted work is accepted; a leaked commit is not.',
    '',
    'Do this instead: leave your changes in the working tree, UNSTAGED, and report',
    'the exact list of files you changed (one line each) in your final message.',
    'The user reviews and commits. Read-only git — status, diff, log, show,',
    'rev-parse, branch --show-current — still works, so you can inspect and report.',
    '',
    'If this dispatch was explicitly told to commit, the USER can grant git writes',
    'for this project at runtime (dashboard "Allow git writes", or',
    '`node scripts/git-grant.mjs <project> --once`) with no relaunch. An agent',
    'cannot lift this for itself; the grant comes from the user only.',
  ].join('\n');
}

/**
 * FEAT-108 round 2 — a git write was PERMITTED by a runtime grant, but the
 * mandatory leak gate FAILED. The grant lifts the prohibition; it never lifts
 * the gate. This is the message for that refusal: the commit/push carries a
 * private token, so it is blocked exactly as an ungranted one would be — the
 * safety property (never leak) is enforced by the mechanism, not by the grant.
 */
export function gitWriteGateFailedRefusal(offender, gateDetail = '') {
  const detail = String(gateDetail || '').trim();
  return [
    `Git writes ARE granted for this project, but \`${offender}\` was blocked: the`,
    'leak gate FAILED. A grant lifts the prohibition on git writes; it never lifts',
    'the leak gate. This commit/push would carry a private token (a home path, a',
    'username, or a private project name) into history — the exact leak FEAT-108',
    'exists to prevent, and the trade the user set is explicit: a leaked commit is',
    'never acceptable, granted or not.',
    '',
    'Fix the leak the gate reports, then retry — or leave the work UNSTAGED and',
    'report the file list for the user to handle. Run `npm run gate` to see the',
    'hits yourself.',
    ...(detail ? ['', 'Leak gate said:', detail] : []),
  ].join('\n');
}
