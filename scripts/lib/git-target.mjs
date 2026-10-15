/**
 * git-target.mjs — FEAT-164: what a git invocation is aimed at, resolved by the REAL git
 * with the invocation's own global options and environment (never from command text).
 *   - parseGlobals: strict split of git's global options / verb / rest (unknown → null);
 *   - expandGitAliases: aliases expanded through git's own config resolution;
 *   - resolveWriteTarget: the target the shim sends to the host's real-repo guard
 *     (agent-git-policy.mjs decideByTarget).
 * Moved verbatim out of FEAT-170's removed lane-repo guard module (2026-10-13); behaviour unchanged.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRemote } from './remote-url.mjs';

/* git global options (git 2.39–2.5x). VALUE options take the next argv entry or `=v`. */
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']);
const GLOBAL_BOOL = new Set(['--bare', '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice']);

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

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }

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
 * invocation's own global options and env (never
 * from command text). Sent by the shim to the host, whose real-repo guard
 * (agent-git-policy.mjs decideByTarget) picks the policy of the project that owns the target.
 *   { cwd, commonDir|null, gitDir|null, toplevel|null, worktree|null, creating?, verb, push?: { urls } }
 * `commonDir`/`gitDir`/`toplevel`/`worktree` are the ONE resolved target identity (FEAT-190 r9);
 * every host consumer reads them and none re-derives the repo from `cwd`.
 * Best-effort and bounded: anything unresolvable is left null and the host's rule
 * decides what null means (fail closed inside a registered work tree / for a push).
 */
export function resolveWriteTarget(argv, env = process.env, { realGit, cwd = process.cwd() } = {}) {
  const baseCwd = realOrNull(cwd) ?? cwd;
  const t = { cwd: baseCwd, commonDir: null, gitDir: null, toplevel: null, worktree: null, verb: null };
  const parsed = parseGlobals(argv);
  if (!parsed || !realGit) {
    if (argv.includes('push')) t.verb = 'push'; else if (argv.includes('send-pack')) t.verb = 'send-pack';
    return t;
  }
  // FEAT-164 r4 (verify 73256821): an ALIAS (`git -c alias.p=push p`, `pu = push` in
  // ~/.gitconfig) is expanded with git's OWN config resolution before anything is classified,
  // so the push checks see the command git will actually run.
  const exp = expandGitAliases(parsed, env, { realGit, cwd: baseCwd });
  t.alias = exp.state;
  if (exp.chain.length) t.aliasChain = exp.chain;
  if (exp.state === 'shell' || exp.state === 'unresolved') {
    // A shell alias runs arbitrary commands; an unresolvable one is unknowable. The host
    // refuses both under the policy (treated as a potential push / write).
    t.aliasDetail = exp.detail;
    return t;
  }
  const { globals, sub, rest } = exp;
  t.verb = sub;
  t.resolvedVerb = true;
  const c = cwdAfter(globals, baseCwd);
  t.cwd = realOrNull(c) ?? c;
  if (sub === 'init' || sub === 'clone') { t.creating = true; return t; }
  const g = globals.flat();
  // FEAT-190 r9 — resolve the FULL target repo identity ONCE, with the invocation's own globals
  // (-C / --git-dir / --work-tree) applied, so every host consumer (the permission decision, the
  // leak gate `gateRepo`, the cross-repo reach log and the audit entry) reads ONE resolved repo and
  // none re-derives it from the cwd. A `git --git-dir=Q/.git …` run from cwd=P must gate/record Q,
  // not P (IV run 027bd822 FINDING 1/2). `--git-common-dir` + `--absolute-git-dir` never fail for a
  // real repo (bare or not); `--show-toplevel` fails for a bare / no-work-tree repo, so it is a
  // SEPARATE call — folding it into the line above would fail the whole rev-parse for a bare repo
  // and lose commonDir/gitDir.
  const out = run(realGit, [...g, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'], env, baseCwd);
  if (out) {
    const lines = out.split('\n').filter(Boolean);
    if (lines[0] && path.isAbsolute(lines[0])) t.commonDir = realOrNull(lines[0]);
    if (lines[1] && path.isAbsolute(lines[1])) t.gitDir = realOrNull(lines[1]) ?? lines[1];
  }
  const topOut = run(realGit, [...g, 'rev-parse', '--show-toplevel'], env, baseCwd);
  const topLine = topOut ? topOut.split('\n').find(Boolean) : null;
  if (topLine && path.isAbsolute(topLine)) { const rt = realOrNull(topLine) ?? topLine; t.toplevel = rt; t.worktree = rt; }
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
    // THE remote parser (remote-url.mjs): a LOCAL remote becomes its absolute path; any other form is
    // passed on unchanged for the host to parse (and refuse when unparseable).
    const absolutize = (u) => { const r = parseRemote(u, { base: t.cwd }); return r && r.kind === 'local' ? r.path : u; };
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
