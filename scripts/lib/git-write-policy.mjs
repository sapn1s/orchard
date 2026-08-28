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
  'patch-id', 'interpret-trailers', 'stripspace', 'url-parse', 'fmt-merge-msg',
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
};

/* ── git's GLOBAL options, which sit BEFORE the subcommand ────────────────────
 * `git -C <path> commit` and `git --git-dir=… commit` are the named evasions
 * (requirement 3): the real subcommand is `commit`, reached past a global
 * option. To find it we must skip these — and skip the VALUE of the ones that
 * take a separate token, or `git -C /repo commit` reads `/repo` as the
 * subcommand and sails through.
 */
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree',
  '--namespace', '--exec-path', '--config-env', '--super-prefix', '--attr-source']);

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

/** Decide one already-isolated `git …` token array. Returns an offender or null. */
function offenderForGit(tokens) {
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

const MAX_DEPTH = 6;

/**
 * Scan a Bash command for any git WRITE reachable at this layer. Returns the
 * offender string (`git <sub>`) or null. Recurses into command substitutions and
 * the code strings of `sh -c` / `bash -c` / `eval`, and looks through `env` and
 * `xargs` — the evasions requirement 3 asks to catch. What it CANNOT see is
 * listed in the ticket: a wrapper script, a non-shell interpreter (`python -c`,
 * `node -e`) that shells out, and shell aliases/functions.
 */
export function scanForGitWrite(command, depth = 0) {
  if (typeof command !== 'string' || depth > MAX_DEPTH) return null;

  // Heredoc bodies are DATA — decide the opening line, drop the body.
  const heredoc = command.search(/<<-?\s*['"]?[A-Za-z_]/);
  const src = heredoc >= 0 ? command.slice(0, heredoc) : command;

  // Command substitutions are commands. Recurse into each body, then blank them
  // so their contents are not re-read as arguments.
  const subs = [];
  const flattened = src
    .replace(/\$\(([^()]*)\)/g, (_m, b) => { subs.push(b); return ' '; })
    .replace(/`([^`]*)`/g, (_m, b) => { subs.push(b); return ' '; });
  for (const body of subs) {
    const o = scanForGitWrite(body, depth + 1);
    if (o) return o;
  }

  for (const tokens of tokenizeSegments(flattened)) {
    const h = headOf(tokens);
    if (!h) continue;
    const { head, args, all } = h;

    if (head === 'git') { const o = offenderForGit(all); if (o) return o; continue; }

    // `env GIT_DIR=… git commit` / `env -i git push` — strip env's preamble and re-decide.
    if (head === 'env') {
      let j = 0;
      while (j < args.length) {
        const a = args[j];
        if (ASSIGNMENT.test(a)) { j++; continue; }
        if (a === '-i' || a === '--ignore-environment' || a === '-') { j++; continue; }
        if (a === '-u' || a === '-C' || a === '-S') { j += 2; continue; }
        if (a.startsWith('-')) { j++; continue; }
        break;
      }
      const o = scanForGitWrite(args.slice(j).join(' '), depth + 1);
      if (o) return o;
      continue;
    }

    // `sh -c '…git commit…'` — the write is the code string. Recurse into it.
    if (EXEC_C.has(head)) {
      const ci = args.indexOf('-c');
      if (ci >= 0 && args[ci + 1] != null) { const o = scanForGitWrite(args[ci + 1], depth + 1); if (o) return o; }
      continue;
    }

    // `eval "git commit"` / `eval git commit` — the arguments ARE the command.
    if (head === 'eval') { const o = scanForGitWrite(args.join(' '), depth + 1); if (o) return o; continue; }

    // `git … | xargs git commit` — git sits after xargs' own flags.
    if (head === 'xargs') {
      const gi = args.findIndex((a) => basename(a) === 'git');
      if (gi >= 0) { const o = offenderForGit(['git', ...args.slice(gi + 1)]); if (o) return o; }
      continue;
    }
  }
  return null;
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
