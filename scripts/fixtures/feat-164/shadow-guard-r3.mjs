/* PINNED FIXTURE (FEAT-164 r4 must-FAIL baseline): shadow-guard.mjs WITHOUT alias expansion (round 3),
 * synthesized from its exact prior lines. */
/**
 * shadow-guard.mjs — FEAT-170 shadow-repo pilot: the ONE place that decides whether a
 * git WRITE is inside an agent's own shadow repo (allowed) or anywhere else (today's
 * path: temp-index plumbing → host grant → deny).
 *
 * THE RULE (agent-vcs.md §10 finding 4, binding): the decision is made from the repo
 * git ACTUALLY RESOLVES for this invocation — the real git binary is asked, with the
 * invocation's own global options and environment — never from command text, cwd
 * text or argv paths. Every redirect git honours (GIT_DIR, --git-dir, a `.git`
 * gitfile, a `commondir` file, core.worktree, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 * -c, includes) therefore lands IN this check rather than around it.
 *
 * Allowed only when ALL hold (anything else → not a shadow write → caller's old path):
 *   1. not native Windows (Orchard needs WSL2; the shadow allow is simply off there);
 *   2. the baked root still realpaths to itself and is a real directory (a root swapped
 *      for a symlink turns every shadow allow off);
 *   3. global options parse strictly (an unknown one → refuse);
 *   4. the verb is on a closed allowlist of repo-local verbs (push / clone / worktree /
 *      submodule / maintenance / credential / aliases / unknown → refuse), with per-verb
 *      argument rules (config local only; merge-file only -p; apply/am never
 *      --unsafe-paths);
 *   5. git dir, common dir, index file's dir, objects dir and work tree all realpath
 *      INSIDE the root (strictly below it);
 *   6. no symlink anywhere under the git dir / common dir and no hard-linked file
 *      outside objects/ (git's lockfile writes through a symlinked config/packed-refs/
 *      refs; gc through a symlinked objects; reflogs append in place through a hardlink);
 *   7. `init` only for a FRESH target inside the root, with templates disabled.
 * On allow, the caller execs real git with the RESOLVED locations PINNED in the env
 * (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY
 * when the caller set them) and --git-dir/--work-tree/--bare removed from argv, so a
 * gitfile or commondir swapped after the check cannot redirect the write.
 *
 * NOT closed (stated, same-uid class, unchanged from the shim's own header): git by
 * absolute path or with a scrubbed PATH; direct file tampering (rm, editing .git);
 * a symlink planted inside a lane's .git between the walk and the exec by a
 * concurrent process; moving a real repo physically into the root.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Default shadow root, computed on the HOST at shim install (host env is trusted there). */
export function defaultShadowRoot(env = process.env) {
  let home;
  try { home = os.userInfo().homedir; } catch { home = os.homedir(); }
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(base, 'claude-station', 'shadow');
}

/** Create (0700) and canonicalise a root for baking. null when that is impossible. */
export function prepareShadowRoot(root) {
  if (!root || !path.isAbsolute(root)) return null;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(root);
    const st = fs.lstatSync(real);
    if (!st.isDirectory()) return null;
    return real;
  } catch { return null; }
}

/* git global options (git 2.39–2.5x). VALUE options take the next argv entry or `=v`. */
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']);
const GLOBAL_BOOL = new Set(['--bare', '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice']);
/** Removed from the exec argv: the resolved locations are pinned in the env instead. */
const PINNED_VALUE = new Set(['--git-dir', '--work-tree']);
const PINNED_BOOL = new Set(['--bare']);

/**
 * Split argv into { globals: string[][] (each option with its value), sub, rest } or
 * null when a global option is unknown or malformed (fail closed).
 */
export function parseGlobals(argv) {
  const globals = [];
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (!t.startsWith('-')) break;
    if (GLOBAL_BOOL.has(t)) { globals.push([t]); i += 1; continue; }
    if (GLOBAL_VALUE.has(t)) { if (i + 1 >= argv.length) return null; globals.push([t, argv[i + 1]]); i += 2; continue; }
    const eq = t.indexOf('=');
    if (eq > 0 && GLOBAL_VALUE.has(t.slice(0, eq)) && t.startsWith('--')) { globals.push([t.slice(0, eq), t.slice(eq + 1)]); i += 1; continue; }
    if (t.startsWith('--exec-path')) { globals.push([t]); i += 1; continue; }
    return null; // unknown global option (incl. --list-cmds, --super-prefix): not decidable → refuse
  }
  if (i >= argv.length) return null;
  return { globals, sub: argv[i], rest: argv.slice(i + 1) };
}

/** Repo-local verbs a lane may run in its own shadow repo. Closed list; anything else is refused. */
export const SHADOW_VERBS = new Set([
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'commit-tree',
  'config', 'gc', 'hash-object', 'init', 'merge', 'merge-file', 'merge-tree', 'mktree',
  'mv', 'notes', 'pack-refs', 'prune', 'read-tree', 'rebase', 'reflog', 'repack', 'replace',
  'rerere', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'symbolic-ref', 'tag',
  'update-index', 'update-ref', 'write-tree',
]);

/**
 * Options that make an allowed verb write OUTSIDE the resolved repo (plan review 1 #2):
 * an index or pack at an arbitrary path, patch files anywhere, or paths beyond the
 * work tree. Refused in any position, in `--opt` and `--opt=value` form.
 */
const OUT_OF_REPO_OPTS = ['--output', '--output-directory', '--index-output', '--build-fake-ancestor', '--filter-to', '--unsafe-paths', '--separate-git-dir'];

/** Per-verb argument rules. Returns a refusal reason or null. */
function verbArgsRefusal(sub, rest, env) {
  const has = (...names) => rest.some((a) => names.includes(a) || names.some((n) => n.startsWith('--') && a.startsWith(`${n}=`)));
  for (const o of OUT_OF_REPO_OPTS) if (has(o)) return `${o} writes outside the lane repo`;
  if (sub === 'config') {
    if (has('--global', '--system', '--file', '-f')) return 'config outside the lane repo (--global/--system/--file)';
    if (rest.some((a) => /^-f./.test(a))) return 'config --file (short form)';
    if (env.GIT_CONFIG) return 'GIT_CONFIG redirects config writes';
  }
  if (sub === 'merge-file' && !has('-p', '--stdout')) return 'merge-file writes in place; only -p/--stdout is allowed in a lane';
  return null;
}

const inside = (root, p) => p.startsWith(root + path.sep);
function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }
/** realpath of p, or of its parent joined with its basename when p does not exist yet. */
function realLoose(p) {
  const r = realOrNull(p);
  if (r) return r;
  const d = realOrNull(path.dirname(p));
  return d ? path.join(d, path.basename(p)) : null;
}

/**
 * Walk a git dir: any symlink anywhere, or a hard-linked regular file outside objects/,
 * makes it unsafe. Returns the offending path or null.
 */
export function unsafeGitDirEntry(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return d; }
    const inObjects = inside(path.join(dir, 'objects'), path.join(d, 'x')) || d === path.join(dir, 'objects');
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) return p;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (inObjects) continue;
      if (e.isFile()) {
        try { if (fs.lstatSync(p).nlink > 1) return p; } catch { return p; }
      } else if (!e.isFile()) return p; // fifo/socket/device in a git dir: refuse
    }
  }
  return null;
}

/** cwd after applying every -C in order (git semantics: each -C is relative to the previous). */
function cwdAfter(globals, base) {
  let cwd = base;
  for (const [o, v] of globals) if (o === '-C' && v !== '') cwd = path.resolve(cwd, v);
  return cwd;
}

function run(realGit, args, env, cwd) {
  const r = spawnSync(realGit, args, { encoding: 'utf8', env, cwd, timeout: 15000 });
  return (r.status ?? 1) === 0 ? String(r.stdout) : null;
}

/** Positional dir of `git init [opts] [dir]`. */
function initTarget(rest) {
  const VAL = new Set(['-b', '--initial-branch', '--template', '--separate-git-dir', '--object-format', '--ref-format', '--shared']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') return rest[i + 1] ?? null;
    if (a.startsWith('-')) { if (VAL.has(a) && a !== '--shared') i++; continue; }
    return a;
  }
  return null;
}

/* ─────────────── FEAT-164 r4: aliases, expanded by git's own config resolution ─────────────── */

const builtinCache = new Map(); // realGit → Set | null
/** git's builtin commands (`git --list-cmds=builtins`); builtins take precedence over aliases. */
export function gitBuiltins(realGit) {
  if (builtinCache.has(realGit)) return builtinCache.get(realGit);
  let set = null;
  try {
    const r = spawnSync(realGit, ['--list-cmds=builtins'], { encoding: 'utf8', timeout: 10000 });
    if ((r.status ?? 1) === 0) set = new Set(String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { set = null; }
  if (set && set.size) builtinCache.set(realGit, set);
  return set && set.size ? set : null;
}

/** git's split_cmdline: whitespace-separated words, '…' and "…" quoting, backslash escapes.
 * Returns null on an unbalanced quote (git refuses such an alias too). */
export function splitGitCmdline(s) {
  const out = []; let cur = ''; let has = false; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (ch === '\\') { if (i + 1 >= s.length) return null; cur += s[++i]; has = true; continue; }
    if (q === '"') { if (ch === '"') q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}

export const ALIAS_MAX_DEPTH = 10;

/**
 * Expand `parsed` ({ globals, sub, rest }) through git aliases, the way git does: a builtin is
 * never an alias; otherwise `git <globals> config --get alias.<sub>` (so -c, --config-env,
 * includes and every config scope apply). Returns { state, globals, sub, rest, chain, detail }:
 *   none        not an alias (a builtin, or an external git-<cmd> / unknown command)
 *   expanded    one or more aliases expanded; globals/sub/rest are the resulting command
 *   shell       a `!…` shell alias — arbitrary commands, refused by the host
 *   unresolved  config unreadable, unparsable value, a loop, or deeper than ALIAS_MAX_DEPTH
 */
export function expandGitAliases(parsed, env, { realGit, cwd }) {
  let globals = parsed.globals; let sub = parsed.sub; let rest = parsed.rest;
  const chain = [];
  const builtins = gitBuiltins(realGit);
  const done = (state, detail = null) => ({ state, globals, sub, rest, chain, detail });
  for (let depth = 0; depth <= ALIAS_MAX_DEPTH; depth++) {
    if (builtins && builtins.has(sub)) return done(chain.length ? 'expanded' : 'none');
    let r;
    try { r = spawnSync(realGit, [...globals.flat(), 'config', '--get', `alias.${sub}`], { encoding: 'utf8', env, cwd, timeout: 15000 }); }
    catch (e) { return done('unresolved', `alias lookup for "${sub}" failed: ${e.message}`); }
    if (r.status === 1 && !String(r.stderr || '').trim()) {
      // Not an alias. Without the builtin list we cannot tell a builtin from an unknown name.
      return builtins ? done(chain.length ? 'expanded' : 'none') : done('unresolved', 'git could not list its builtin commands');
    }
    if ((r.status ?? 1) !== 0) return done('unresolved', `git config --get alias.${sub} failed: ${String(r.stderr || '').trim().split('\n')[0]}`);
    const value = String(r.stdout).replace(/\n$/, '');
    chain.push(`${sub} = ${value}`);
    if (value.trimStart().startsWith('!')) return done('shell', `alias "${sub}" is a shell command`);
    const words = splitGitCmdline(value);
    if (!words || !words.length) return done('unresolved', `alias "${sub}" cannot be parsed`);
    const p2 = parseGlobals([...words, ...rest]);
    if (!p2) return done('unresolved', `alias "${sub}" expands to options this guard cannot parse`);
    if (chain.some((c) => c.startsWith(`${p2.sub} = `))) return done('unresolved', `alias loop at "${p2.sub}"`);
    globals = [...globals, ...p2.globals]; sub = p2.sub; rest = p2.rest;
  }
  return done('unresolved', `aliases nest deeper than ${ALIAS_MAX_DEPTH}`);
}

/** Options of `git push` that take a SEPARATE value (so the value is not the repository). */
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

/**
 * FEAT-164 — WHAT a git write is aimed at, resolved by the REAL git with the
 * invocation's own global options and env (the same rule as the shadow decision: never
 * from command text). Sent by the shim to the host, whose real-repo guard
 * (agent-git-policy.mjs decideByTarget) picks the policy of the project that owns the target.
 *   { cwd, commonDir|null, creating?, verb, push?: { urls } }
 * Best-effort and bounded: anything unresolvable is left null and the host's rule
 * decides what null means (fail closed inside a registered work tree / for a push).
 */
export function resolveWriteTarget(argv, env = process.env, { realGit, cwd = process.cwd() } = {}) {
  const baseCwd = realOrNull(cwd) ?? cwd;
  const t = { cwd: baseCwd, commonDir: null, verb: null };
  const parsed = parseGlobals(argv);
  if (!parsed || !realGit) {
    if (argv.includes('push')) t.verb = 'push'; else if (argv.includes('send-pack')) t.verb = 'send-pack';
    return t;
  }
  const { globals, sub, rest } = parsed;
  t.verb = sub;
  const c = cwdAfter(globals, baseCwd);
  t.cwd = realOrNull(c) ?? c;
  if (sub === 'init' || sub === 'clone') { t.creating = true; return t; }
  const g = globals.flat();
  const out = run(realGit, [...g, 'rev-parse', '--path-format=absolute', '--git-common-dir'], env, baseCwd);
  const line = out ? out.split('\n').find(Boolean) : null;
  if (line && path.isAbsolute(line)) t.commonDir = realOrNull(line);
  if (sub === 'push' || sub === 'send-pack') {
    let repo = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--') { repo = rest[i + 1] ?? null; break; }
      if (a.startsWith('--repo=')) { repo = a.slice(7); continue; }
      if (a === '--repo') { repo = rest[i + 1] ?? null; i++; continue; }
      if (a.startsWith('-')) { if (PUSH_VALUE_OPTS.has(a)) i++; continue; }
      if (repo === null) repo = a;
      break;
    }
    // FEAT-164 r3 (verify 01a12c67): the destination is resolved BY GIT, exactly as push resolves
    // it — url.<base>.insteadOf / pushInsteadOf / includes / pushurl are git's to apply, never
    // re-implemented here. Anything git cannot resolve for us leaves `urls` EMPTY, which the
    // host refuses (fail closed).
    //   - a configured remote NAME → `git remote get-url --push --all <name>` (applies insteadOf,
    //     pushInsteadOf and pushurl exactly as push does; measured, git 2.39);
    //   - a URL/path ARGUMENT → `git ls-remote --get-url <arg>` applies insteadOf; git offers no
    //     read-only resolver that applies pushInsteadOf to a raw URL, so when ANY pushInsteadOf is
    //     in effect (any scope, incl. -c and includes) such a push is unresolvable → refused;
    //   - a remote defined where `get-url` cannot see it (e.g. only via -c remote.<n>.url) →
    //     unresolvable → refused.
    const cfgGrep = (re) => (run(realGit, [...g, 'config', '--get-regexp', re], env, baseCwd) || '').split('\n').filter(Boolean);
    const getUrl = (name) => {
      const o = run(realGit, [...g, 'remote', 'get-url', '--push', '--all', name], env, baseCwd);
      return o ? o.split('\n').filter(Boolean) : null;
    };
    const absolutize = (u) => (path.isAbsolute(u) || /^[a-z][a-z0-9+.-]*:/i.test(u) || (/^[^/\\]+:/.test(u) && !/^[A-Za-z]:[\\/]/.test(u)) ? u : path.resolve(t.cwd, u));
    let urls = [];
    let name = repo;
    if (!name) {
      const br = (run(realGit, [...g, 'symbolic-ref', '--quiet', '--short', 'HEAD'], env, baseCwd) || '').trim();
      const cfg = (k) => (run(realGit, [...g, 'config', '--get', k], env, baseCwd) || '').trim();
      name = (br && cfg(`branch.${br}.pushRemote`)) || cfg('remote.pushDefault') || (br && cfg(`branch.${br}.remote`)) || 'origin';
    }
    const named = getUrl(name);
    if (named) urls = named.map(absolutize);
    else {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const remoteDefined = cfgGrep(`^remote\\.${esc}\\.(url|pushurl)$`).length > 0;
      const pushRewrites = cfgGrep('^url\\..*\\.pushinsteadof$').length > 0;
      if (!remoteDefined && !pushRewrites) {
        const u = (run(realGit, [...g, 'ls-remote', '--get-url', name], env, baseCwd) || '').split('\n').find(Boolean);
        if (u) urls = [absolutize(u)];
      }
    }
    t.push = { urls };
  }
  return t;
}

/**
 * The decision. `argv` = git's args without the head. Returns
 *   { allow: false, why }                                   not a shadow write
 *   { allow: true, exec: { argv, env }, gitDir, top }       exec real git with these
 */
export function shadowDecision(argv, env, { realGit, shadowRoot, platform = process.platform, cwd = process.cwd() } = {}) {
  const no = (why) => ({ allow: false, why });
  if (platform === 'win32') return no('native Windows: the shadow allow is off (Orchard needs WSL2)');
  if (!realGit || !shadowRoot || !path.isAbsolute(shadowRoot)) return no('no shadow root baked');
  let rootSt;
  try { rootSt = fs.lstatSync(shadowRoot); } catch { return no('shadow root missing'); }
  if (!rootSt.isDirectory() || realOrNull(shadowRoot) !== shadowRoot) return no('shadow root is not the baked real directory');
  const root = shadowRoot;

  const parsed = parseGlobals(argv);
  if (!parsed) return no('unparsed global options');
  const { globals, sub, rest } = parsed;
  if (!SHADOW_VERBS.has(sub)) return no(`\`${sub}\` is not a lane-local verb`);
  const argRefusal = verbArgsRefusal(sub, rest, env);
  if (argRefusal) return no(argRefusal);
  if (env.GIT_SHALLOW_FILE) return no('GIT_SHALLOW_FILE redirects a write');
  if (env.GIT_ALTERNATE_OBJECT_DIRECTORIES) return no('alternates are refused in lanes (GIT_ALTERNATE_OBJECT_DIRECTORIES)');
  const baseCwd = realOrNull(cwd) ?? cwd;

  if (sub === 'init') {
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_TEMPLATE_DIR']) {
      if (env[k]) return no(`init with ${k} set`);
    }
    if (globals.some(([o]) => PINNED_VALUE.has(o) || PINNED_BOOL.has(o))) return no('init with --git-dir/--work-tree/--bare');
    if (rest.some((a) => a === '--template' || a.startsWith('--template='))) return no('init --template (templates are disabled in lanes)');
    const c = cwdAfter(globals, baseCwd);
    const t = initTarget(rest);
    const target = path.resolve(c, t ?? '.');
    const bare = rest.includes('--bare');
    // nearest existing ancestor must realpath inside the root
    let anc = target;
    while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
    const ancReal = realOrNull(anc);
    if (!ancReal || !(ancReal === root ? target !== anc : inside(root, ancReal))) return no('init target is not inside the shadow root');
    const tReal = realLoose(target);
    if (!tReal || !inside(root, tReal)) return no('init target is not inside the shadow root');
    const gd = bare ? tReal : path.join(tReal, '.git');
    if (bare) {
      try { if (fs.readdirSync(gd).length) return no('init --bare into a non-empty dir'); } catch { /* absent: fresh */ }
    } else {
      let exists = true;
      try { fs.lstatSync(gd); } catch { exists = false; }
      if (exists) return no('init over an existing .git (re-init is refused in lanes)');
    }
    const i = argv.indexOf('init');
    // A fresh, sanitised environment: no GIT_* redirect or config can shape the new repo.
    const ienv = {};
    for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_') || /^GIT_TRACE/.test(k)) ienv[k] = v;
    return { allow: true, exec: { argv: [...argv.slice(0, i + 1), '--template=', ...argv.slice(i + 1)], env: ienv }, gitDir: gd, top: bare ? null : tReal };
  }

  // Resolution by the REAL git, with this invocation's own globals and env.
  const g = globals.flat();
  const out = run(realGit, [...g, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--git-path', 'index', '--git-path', 'objects', '--is-bare-repository'], env, baseCwd);
  if (!out) return no('git could not resolve a repository');
  const lines = out.split('\n').filter((l) => l !== '');
  if (lines.length !== 5) return no('unexpected rev-parse output');
  const [gitDir0, commonDir0, index0, objects0, bareS] = lines;
  if (![gitDir0, commonDir0, index0, objects0].every((p) => path.isAbsolute(p))) return no('a resolved path is not absolute');
  const bare = bareS === 'true';
  let top = null;
  if (!bare) {
    const t = run(realGit, [...g, 'rev-parse', '--path-format=absolute', '--show-toplevel'], env, baseCwd);
    if (!t || !path.isAbsolute(t.trim())) return no('non-bare repository without a resolvable work tree');
    top = realOrNull(t.trim());
    if (!top || !inside(root, top)) return no('work tree outside the shadow root');
  }
  const gitDir = realOrNull(gitDir0); const commonDir = realOrNull(commonDir0); const objects = realOrNull(objects0);
  const index = realLoose(index0);
  for (const [name, p] of [['git dir', gitDir], ['common dir', commonDir], ['objects', objects], ['index', index]]) {
    if (!p || !inside(root, p)) return no(`${name} resolves outside the shadow root`);
  }
  try { const st = fs.lstatSync(index); if (!st.isFile() || st.nlink > 1) return no('index is not a private regular file'); } catch (e) { if (e?.code !== 'ENOENT') return no('index unreadable'); }
  if (fs.existsSync(path.join(objects, 'info', 'alternates')) || fs.existsSync(path.join(commonDir, 'objects', 'info', 'alternates'))) return no('alternates are refused in lanes (objects/info/alternates)');
  for (const d of new Set([gitDir, commonDir])) {
    const bad = unsafeGitDirEntry(d);
    if (bad) return no(`unsafe entry in the lane git dir: ${bad}`);
  }
  if (!inside(commonDir, objects) && objects !== path.join(commonDir, 'objects')) {
    const bad = unsafeGitDirEntry(objects);
    if (bad) return no(`unsafe entry in the objects dir: ${bad}`);
  }

  // Pin the resolved locations; drop the argv forms that would re-resolve them.
  const keep = [];
  for (const opt of globals) if (!PINNED_VALUE.has(opt[0]) && !PINNED_BOOL.has(opt[0])) keep.push(...opt);
  const xenv = { ...env, GIT_DIR: gitDir, GIT_COMMON_DIR: commonDir };
  if (top) xenv.GIT_WORK_TREE = top; else delete xenv.GIT_WORK_TREE;
  if (env.GIT_INDEX_FILE) xenv.GIT_INDEX_FILE = index;
  if (env.GIT_OBJECT_DIRECTORY) xenv.GIT_OBJECT_DIRECTORY = objects;
  return { allow: true, exec: { argv: [...keep, sub, ...rest], env: xenv }, gitDir, top };
}
