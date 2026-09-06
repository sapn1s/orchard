/**
 * Per-project git status + actions, by driving the `git` and `gh` CLIs the
 * machine already has. Deliberately no npm git library and no third-party
 * GitHub MCP server — each would add a supply-chain trust boundary for
 * something two argv calls do.
 *
 * Every command here is a fixed argv (execFile, never a shell), so a commit
 * message or branch name cannot become shell.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export class GitError extends Error {
  readonly status: number;
  readonly gitStatus?: GitStatus;
  constructor(status: number, message: string, gitStatus?: GitStatus) { super(message); this.status = status; this.gitStatus = gitStatus; }
}

function git(cwd: string, args: string[], timeoutMs = 15_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args],
      // execFile has no shell and pipes stdout/stderr by definition.
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: env ?? process.env },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0,
        out: stdout ?? '',
        err: (stderr || error?.message || '').trim(),
      }));
  });
}

/**
 * fetch/push/pull are the only git ops that touch the network, and a network op
 * with no bound is how the sync control ends up stuck on "Working…" forever: a
 * remote that prompts for a credential/passphrase/host-key with no tty, or a
 * black-hole that accepts the connection and never answers, hangs `git` for the
 * full hard timeout (a minute) — long enough that any panel navigation in the
 * meantime strands the client's in-flight flag permanently. Force every network
 * op to fail fast and honestly instead: never prompt (fail closed with no tty),
 * cap ssh connect/banner time, and abort a stalled HTTP transfer in seconds with
 * a real reason rather than riding the whole timeout.
 */
const NET_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? 'ssh'} -oBatchMode=yes -oConnectTimeout=10 -oStrictHostKeyChecking=accept-new`,
};
const NET_CONF = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=15'];
function netGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string; err: string }> {
  return git(cwd, [...NET_CONF, ...args], timeoutMs, NET_ENV);
}

export interface GitStatus {
  repo: boolean;
  /** Repo root — can differ from hostPath when the project sits inside one. */
  toplevel: string | null;
  branch: string | null;      // null = detached (see `detachedAt`)
  detachedAt: string | null;
  dirty: number;              // changed + untracked paths
  /** Changed text-line totals vs HEAD. A final unterminated line counts as one;
   *  binary files contribute no text lines. null means HEAD is absent or Git
   *  could not compute the tracked totals. */
  added: number | null;
  removed: number | null;
  /** Whether `added` also includes every untracked text file. false means the
   *  totals are the always-cheap tracked totals only (untracked input was too
   *  numerous, too large, binary, unreadable, or could not be enumerated). */
  untrackedLinesIncluded: boolean;
  /** vs the last-FETCHED upstream ref — statusOf never touches the network,
   *  so `behind` can lag reality until something fetches. null = no upstream. */
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  remoteUrl: string | null;
  lastCommit: string | null;  // "abc1234 subject"
}

export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export interface GitChange {
  path: string;
  oldPath: string | null;
  type: GitChangeType;
  staged: boolean;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

async function repoRoot(hostPath: string): Promise<string> {
  const top = await git(hostPath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.out.trim()) throw new GitError(409, 'not a git repository');
  return top.out.trim();
}

/** Porcelain v1 -z has literal paths: XY SP path NUL [old-path NUL for R/C]. */
async function porcelain(hostPath: string): Promise<Array<{ x: string; y: string; path: string; oldPath: string | null }>> {
  await repoRoot(hostPath);
  const r = await git(hostPath, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.code !== 0) throw new GitError(500, `git status failed: ${r.err}`);
  const fields = r.out.split('\0');
  const rows: Array<{ x: string; y: string; path: string; oldPath: string | null }> = [];
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const rec = fields[i];
    if (rec.length < 4 || rec[2] !== ' ') throw new GitError(500, 'git status returned malformed porcelain');
    const x = rec[0], y = rec[1], path = rec.slice(3);
    // In porcelain v1 -z, renames reverse the human format: destination first,
    // source in the following NUL field.
    const oldPath = (x === 'R' || x === 'C' || y === 'R' || y === 'C') ? (fields[++i] ?? null) : null;
    rows.push({ x, y, path, oldPath });
  }
  return rows;
}

function changeType(x: string, y: string): GitChangeType {
  if (x === '?' && y === '?') return 'untracked';
  const c = y !== ' ' ? y : x;
  if (c === 'A') return 'added';
  if (c === 'D') return 'deleted';
  if (c === 'R' || c === 'C') return 'renamed';
  return 'modified';
}

async function numstat(hostPath: string): Promise<Map<string, { added: number | null; removed: number | null; binary: boolean }>> {
  const head = await git(hostPath, ['rev-parse', '--verify', 'HEAD']);
  const args = head.code === 0
    ? ['diff', '--numstat', '-z', 'HEAD', '--']
    : ['diff', '--numstat', '-z', '--cached', '--'];
  const r = await git(hostPath, args);
  const out = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
  if (r.code !== 0) return out;
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const m = parts[i].match(/^([^\t]+)\t([^\t]+)\t(.*)$/s);
    if (!m) continue;
    let p = m[3];
    if (!p) { // rename/copy: empty pathname then old NUL new NUL
      i++;
      p = parts[++i] ?? '';
    }
    const binary = m[1] === '-' || m[2] === '-';
    out.set(p, { added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  return out;
}

export async function changes(hostPath: string): Promise<{ status: GitStatus; changes: GitChange[] }> {
  const rows = await porcelain(hostPath);
  const counts = await numstat(hostPath);
  const root = await repoRoot(hostPath);
  const list = rows.map((r): GitChange => {
    let n = counts.get(r.path) ?? { added: 0, removed: 0, binary: false };
    if (r.x === '?' && r.y === '?') {
      try {
        const target = `${root}/${r.path}`;
        if (!fs.lstatSync(target).isFile()) throw new Error('not a regular file');
        const b = fs.readFileSync(target);
        const binary = b.subarray(0, 8_000).includes(0);
        n = { added: binary ? null : textLineCount(b), removed: binary ? null : 0, binary };
      } catch { n = { added: null, removed: null, binary: true }; }
    }
    return { path: r.path, oldPath: r.oldPath, type: changeType(r.x, r.y), staged: r.x !== ' ' && r.x !== '?', ...n };
  });
  return { status: await statusOf(hostPath), changes: list };
}

function textLineCount(b: Buffer): number {
  return b.length ? b.toString('utf8').split('\n').length - 1 + (b[b.length - 1] === 10 ? 0 : 1) : 0;
}

async function validatedChanges(hostPath: string, requested: unknown) {
  const requestedPaths = typeof requested === 'string' ? [requested] : requested;
  if (!Array.isArray(requestedPaths) || !requestedPaths.length || requestedPaths.some((p) => typeof p !== 'string'))
    throw new GitError(400, 'stage: path must be a string or a non-empty array of strings');
  const rows = await porcelain(hostPath);
  return requestedPaths.map((path) => {
    const row = rows.find((r) => r.path === path || r.oldPath === path);
    if (!row) throw new GitError(400, 'stage: path is not present in this repository status');
    return row;
  });
}

async function validatedChange(hostPath: string, requested: unknown) {
  if (typeof requested !== 'string') throw new GitError(400, 'stage: path must be a string');
  const row = (await porcelain(hostPath)).find((r) => r.path === requested || r.oldPath === requested);
  if (!row) throw new GitError(400, 'stage: path is not present in this repository status');
  return row;
}

/** Toggle only the named status entry. Index-only unstaging never discards work. */
export async function stage(hostPath: string, requested: unknown, staged: boolean): Promise<{ paths: Array<{ path: string; staged: boolean }>; status: GitStatus }> {
  const rows = await validatedChanges(hostPath, requested);
  // A rename source has vanished from the worktree, so `git add` must not
  // receive it. Unstaging is the inverse: restore both HEAD paths or the old
  // name remains staged as a deletion.
  const addressable = staged ? new Set((await porcelain(hostPath)).map((row) => row.path)) : null;
  const paths = [...new Set(rows.flatMap((row) => [
    row.path,
    ...(row.oldPath && (!staged || addressable?.has(row.oldPath)) ? [row.oldPath] : []),
  ]))];
  const hasHead = (await git(hostPath, ['rev-parse', '--verify', 'HEAD'])).code === 0;
  for (let i = 0; i < paths.length; i += 250) {
    const chunk = paths.slice(i, i + 250);
    const args = staged ? ['add', '-A', '--', ...chunk]
      : hasHead ? ['restore', '--staged', '--', ...chunk]
      : ['rm', '--cached', '-r', '--', ...chunk];
    const r = await git(hostPath, args);
    if (r.code !== 0) throw new GitError(500, `git ${staged ? 'add' : 'unstage'} failed: ${r.err || r.out}`);
  }
  const refreshed = await porcelain(hostPath);
  return { paths: rows.map((row) => ({ path: row.path, staged: refreshed.some((r) => r.path === row.path && r.x !== ' ' && r.x !== '?') })), status: await statusOf(hostPath) };
}

export async function diff(hostPath: string, requested: unknown): Promise<{ path: string; diff: string; binary: boolean; truncated: boolean }> {
  const row = await validatedChange(hostPath, requested);
  const root = await repoRoot(hostPath);
  const paths = [...new Set([row.path, row.oldPath].filter((p): p is string => !!p))];
  const isUntracked = row.x === '?' && row.y === '?';
  const hasHead = (await git(hostPath, ['rev-parse', '--verify', 'HEAD'])).code === 0;
  const args = isUntracked
    ? ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', row.path]
    : hasHead
      ? ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...paths]
      : ['diff', '--cached', '--no-ext-diff', '--binary', '--', ...paths];
  const r = await git(isUntracked ? root : hostPath, args, 20_000);
  // --no-index reports differences as exit 1. Other failures are errors.
  if (r.code !== 0 && !(isUntracked && r.code === 1)) throw new GitError(500, `git diff failed: ${r.err}`);
  const binary = /(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(r.out);
  const limited = truncateDiff(r.out);
  return { path: row.path, diff: binary ? 'Binary file — preview unavailable.' : limited.text, binary, truncated: limited.truncated };
}

export async function statusOf(hostPath: string): Promise<GitStatus> {
  const none: GitStatus = { repo: false, toplevel: null, branch: null, detachedAt: null, dirty: 0, added: null, removed: null, untrackedLinesIncluded: false, ahead: null, behind: null, upstream: null, remoteUrl: null, lastCommit: null };
  if (!fs.existsSync(hostPath)) return none;
  const top = await git(hostPath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return none;
  const s: GitStatus = { ...none, repo: true, toplevel: top.out.trim() };
  const br = await git(hostPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (br.code === 0 && br.out.trim()) s.branch = br.out.trim();
  else {
    const sha = await git(hostPath, ['rev-parse', '--short', 'HEAD']);
    if (sha.code === 0) s.detachedAt = sha.out.trim();
  }
  const st = await git(hostPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (st.code === 0) {
    const fields = st.out.split('\0');
    for (let i = 0; i < fields.length && fields[i]; i++) {
      s.dirty++;
      if (fields[i][0] === 'R' || fields[i][0] === 'C' || fields[i][1] === 'R' || fields[i][1] === 'C') i++;
    }
  }
  const ns = await git(hostPath, ['diff', '--numstat', 'HEAD', '--']);
  if (ns.code === 0) {
    let added = 0, removed = 0;
    for (const line of ns.out.split('\n').filter(Boolean)) {
      const [a, d] = line.split('\t');
      if (a !== '-' && d !== '-') { added += Number(a); removed += Number(d); }
    }
    s.added = added;
    s.removed = removed;
    const untracked = await git(hostPath, ['ls-files', '--others', '--exclude-standard', '-z']);
    const paths = untracked.code === 0 ? untracked.out.split('\0').filter(Boolean) : [];
    const MAX_UNTRACKED_FILES = 5_000, MAX_UNTRACKED_BYTES = 32 * 1024 * 1024, MAX_SINGLE_FILE = 4 * 1024 * 1024;
    let includeUntracked = untracked.code === 0 && paths.length <= MAX_UNTRACKED_FILES;
    if (includeUntracked) {
      const root = top.out.trim();
      let bytes = 0, untrackedAdded = 0;
      for (const path of paths) {
        try {
          const target = `${root}/${path}`;
          const stat = await fs.promises.lstat(target);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_SINGLE_FILE || bytes + stat.size > MAX_UNTRACKED_BYTES) { includeUntracked = false; break; }
          bytes += stat.size;
          const b = await fs.promises.readFile(target);
          if (b.subarray(0, 8_000).includes(0)) continue;
          untrackedAdded += textLineCount(b);
        } catch { includeUntracked = false; break; }
      }
      if (includeUntracked) added += untrackedAdded;
    }
    if (includeUntracked) s.added = added;
    s.untrackedLinesIncluded = includeUntracked;
  }
  const up = await git(hostPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.code === 0 && up.out.trim()) {
    s.upstream = up.out.trim();
    const lr = await git(hostPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (lr.code === 0) {
      const [behind, ahead] = lr.out.trim().split(/\s+/).map(Number);
      s.behind = Number.isFinite(behind) ? behind : null;
      s.ahead = Number.isFinite(ahead) ? ahead : null;
    }
  }
  const rem = await git(hostPath, ['remote', 'get-url', 'origin']);
  if (rem.code === 0) s.remoteUrl = rem.out.trim();
  const log = await git(hostPath, ['log', '-1', '--format=%h %s']);
  if (log.code === 0) s.lastCommit = log.out.trim() || null;
  return s;
}

/** git init -b main. Refuses when already a repo. */
export async function init(hostPath: string): Promise<GitStatus> {
  if ((await statusOf(hostPath)).repo) throw new GitError(409, 'already a git repository');
  const r = await git(hostPath, ['init', '-b', 'main']);
  if (r.code !== 0) throw new GitError(500, `git init failed: ${r.err}`);
  return statusOf(hostPath);
}

/**
 * FEAT-130 — the mandatory, fail-closed leak gate on the UI/CLI commit path.
 *
 * The UI/CLI `commit()` used to run `git commit` with no gate call, so a commit
 * from the app bypassed everything on a PUBLIC-bound repo. This runs THIS repo's
 * scripts/leak-gate.mjs (the SAME gate `npm run gate` and the FEAT-108 agent
 * path use) against the target repo's STAGED INDEX (--staged), committer identity
 * AND the pending commit message. FEAT-130 round 2: the gate MUST scan the index,
 * not the working tree — `git commit` records the staged bytes, so a
 * working-tree scan was bypassable by staging a secret then cleaning/deleting the
 * worktree copy. Any hit — or any inability to RUN the gate — REFUSES the commit
 * (fail-closed): a gate that can be skipped when it errors is not a gate. The
 * message is written to a temp file so it is scanned exactly as it will be
 * recorded, without ever becoming shell.
 */
const ORCHARD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function runCommitLeakGate(hostPath: string, message: string): { ok: boolean; detail: string } {
  const gate = path.join(ORCHARD_ROOT, 'scripts', 'leak-gate.mjs');
  if (!fs.existsSync(gate)) return { ok: false, detail: `leak gate not found at ${gate} — refusing to commit unscanned (fail-closed)` };
  let msgFile = '';
  try {
    msgFile = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-commit-')) + '/COMMIT_MSG';
    fs.writeFileSync(msgFile, message, 'utf8');
    execFileSync(process.execPath, [gate, '--summary', '--staged', '--identity', `--commit-msg=${msgFile}`], {
      cwd: hostPath, stdio: 'pipe', timeout: 60_000,
    });
    return { ok: true, detail: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() || e.message || 'leak gate failed';
    return { ok: false, detail: out.slice(0, 1500) };
  } finally {
    try { if (msgFile) fs.rmSync(path.dirname(msgFile), { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/** Commit the index exactly as staged; never stages working-tree files. */
export async function commit(hostPath: string, input: string | { title?: unknown; description?: unknown; message?: unknown }): Promise<{ committed: string; status: GitStatus }> {
  const title = (typeof input === 'string' ? input : String(input.title ?? input.message ?? '')).trim();
  const description = (typeof input === 'string' ? '' : String(input.description ?? '')).trim();
  if (!title) throw new GitError(400, 'commit: a message is required');
  const before = await statusOf(hostPath);
  if (!before.repo) throw new GitError(409, 'not a git repository');
  if (!before.dirty) throw new GitError(409, 'nothing to commit — the working tree is clean');
  const staged = await git(hostPath, ['diff', '--cached', '--quiet', '--exit-code']);
  if (staged.code === 0) throw new GitError(409, 'nothing staged to commit');
  // FEAT-130 — fail-closed leak gate before the commit is created.
  const gate = runCommitLeakGate(hostPath, description ? `${title}\n\n${description}` : title);
  if (!gate.ok) throw new GitError(422, `commit refused — leak gate:\n${gate.detail}`);
  const c = await git(hostPath, ['commit', '-m', title, ...(description ? ['-m', description] : []), '--']);
  if (c.code !== 0) throw new GitError(500, `git commit failed: ${c.err || c.out}`);
  const sha = (await git(hostPath, ['rev-parse', '--short', 'HEAD'])).out.trim();
  return { committed: sha, status: await statusOf(hostPath) };
}

/** git push; first push of a branch gets -u origin <branch>. */
export async function push(hostPath: string): Promise<{ pushed: true; detail: string; status: GitStatus }> {
  const s = await statusOf(hostPath);
  if (!s.repo) throw new GitError(409, 'not a git repository');
  if (!s.remoteUrl) throw new GitError(409, 'no remote named origin — create the GitHub repo first');
  const args = s.upstream ? ['push'] : ['push', '-u', 'origin', s.branch ?? 'HEAD'];
  const r = await netGit(hostPath, args, 60_000);
  if (r.code !== 0) throw new GitError(502, `git push failed: ${r.err || r.out}`);
  return { pushed: true, detail: (r.err || r.out).trim().slice(0, 500), status: await statusOf(hostPath) };
}

/** git pull --ff-only — never invents a merge on the user's behalf. */
export async function pull(hostPath: string): Promise<{ pulled: true; detail: string; status: GitStatus }> {
  const s = await statusOf(hostPath);
  if (!s.repo) throw new GitError(409, 'not a git repository');
  if (!s.upstream) throw new GitError(409, 'no upstream to pull from');
  const r = await netGit(hostPath, ['pull', '--ff-only'], 60_000);
  if (r.code !== 0) throw new GitError(502, `git pull --ff-only failed: ${r.err || r.out}`);
  return { pulled: true, detail: (r.err || r.out).trim().slice(0, 500), status: await statusOf(hostPath) };
}

/** Fetch only updates remote-tracking refs; it never changes index or worktree. */
export async function fetch(hostPath: string): Promise<{ fetched: true; detail: string; status: GitStatus }> {
  const s = await statusOf(hostPath);
  if (!s.repo) throw new GitError(409, 'not a git repository');
  const remote = s.upstream?.split('/')[0] ?? (s.remoteUrl ? 'origin' : null);
  if (!remote) throw new GitError(409, 'no remote to fetch from');
  const r = await netGit(hostPath, ['fetch', remote], 60_000);
  if (r.code !== 0) throw new GitError(502, `git fetch failed: ${r.err || r.out}`.trim());
  return { fetched: true, detail: (r.err || r.out).trim().slice(0, 500), status: await statusOf(hostPath) };
}

export interface GitBranch { name: string; upstream: string | null; ahead: number | null; behind: number | null; current: boolean }

export async function branches(hostPath: string): Promise<{ branches: GitBranch[]; remotes: string[] }> {
  await repoRoot(hostPath);
  // ASCII unit/record separators cannot occur in a Git ref name.
  const format = '%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1e';
  const local = await git(hostPath, ['for-each-ref', `--format=${format}`, 'refs/heads']);
  if (local.code !== 0) throw new GitError(500, `git branches failed: ${local.err}`);
  const list = local.out.split('\x1e').map((record) => record.replace(/^\n|\n$/g, '')).filter(Boolean).map((record): GitBranch => {
    const [name, upstream, track, head] = record.split('\x1f');
    const ahead = track?.match(/ahead (\d+)/)?.[1];
    const behind = track?.match(/behind (\d+)/)?.[1];
    return { name, upstream: upstream || null, ahead: upstream ? Number(ahead ?? 0) : null, behind: upstream ? Number(behind ?? 0) : null, current: head === '*' };
  });
  const remote = await git(hostPath, ['for-each-ref', '--format=%(refname:short)%00', 'refs/remotes']);
  if (remote.code !== 0) throw new GitError(500, `git remote branches failed: ${remote.err}`);
  return { branches: list, remotes: remote.out.split('\0').map((v) => v.trim()).filter(Boolean) };
}

async function refuseDirty(hostPath: string): Promise<void> {
  const s = await statusOf(hostPath);
  if (!s.repo) throw new GitError(409, 'not a git repository');
  if (s.dirty) throw new GitError(409, s.dirty === 1
    ? '1 file has uncommitted changes — commit them first; Orchard will not carry them across branches or discard them'
    : `${s.dirty} files have uncommitted changes — commit them first; Orchard will not carry them across branches or discard them`);
}

export async function switchBranch(hostPath: string, name: unknown): Promise<{ switched: string; status: GitStatus }> {
  if (typeof name !== 'string' || name.startsWith('-')) throw new GitError(400, 'switch-branch: invalid branch name');
  const actual = await branches(hostPath);
  if (!actual.branches.some((branch) => branch.name === name)) throw new GitError(400, `switch-branch: unknown local branch ${JSON.stringify(name)}`);
  await refuseDirty(hostPath);
  const r = await git(hostPath, ['switch', name]);
  if (r.code !== 0) throw new GitError(409, r.err || r.out, await statusOf(hostPath));
  return { switched: name, status: await statusOf(hostPath) };
}

export async function createBranch(hostPath: string, name: unknown): Promise<{ created: string; status: GitStatus }> {
  if (typeof name !== 'string' || name.startsWith('-')) throw new GitError(400, 'create-branch: invalid branch name');
  const valid = await git(hostPath, ['check-ref-format', '--branch', name]);
  if (valid.code !== 0) throw new GitError(400, `create-branch: invalid branch name ${JSON.stringify(name)}`);
  await refuseDirty(hostPath);
  const r = await git(hostPath, ['switch', '-c', name]);
  if (r.code !== 0) throw new GitError(409, r.err || r.out);
  return { created: name, status: await statusOf(hostPath) };
}

/**
 * Check out a remote-tracking branch (e.g. `origin/rebrand/kenimai`) as a new
 * LOCAL branch that tracks it. The remote ref must be one the repo actually
 * carries (validated against `branches().remotes`), never free-form. Like every
 * other switch here it REFUSES on a dirty tree rather than carrying or
 * discarding the user's work, and surfaces git's own message on any conflict.
 * If a local branch of the same short name already exists, this switches to it
 * rather than erroring — the row is a "check this out" action, and the local
 * branch is where its tracking already lives.
 */
export async function checkoutRemote(hostPath: string, remoteRef: unknown): Promise<{ checkedOut: string; tracking: string; status: GitStatus }> {
  if (typeof remoteRef !== 'string' || remoteRef.startsWith('-')) throw new GitError(400, 'checkout-remote: invalid remote branch name');
  const actual = await branches(hostPath);
  if (!actual.remotes.includes(remoteRef)) throw new GitError(400, `checkout-remote: unknown remote branch ${JSON.stringify(remoteRef)}`);
  // `origin/rebrand/kenimai` → local `rebrand/kenimai`; a bare remote name or a
  // `.../HEAD` symref is not a checkoutable branch.
  const slash = remoteRef.indexOf('/');
  const local = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  if (!local || local === 'HEAD' || local.endsWith('/HEAD')) throw new GitError(400, `checkout-remote: ${JSON.stringify(remoteRef)} is not a checkoutable branch`);
  await refuseDirty(hostPath);
  const existing = actual.branches.some((branch) => branch.name === local);
  const r = await git(hostPath, existing ? ['switch', local] : ['switch', '--track', remoteRef]);
  if (r.code !== 0) throw new GitError(409, r.err || r.out, await statusOf(hostPath));
  return { checkedOut: local, tracking: remoteRef, status: await statusOf(hostPath) };
}

export interface GitStash { ref: string; branch: string | null; subject: string; timestamp: string }

export async function stashList(hostPath: string): Promise<{ stashes: GitStash[] }> {
  await repoRoot(hostPath);
  const r = await git(hostPath, ['stash', 'list', '--format=%gd%x00%gs%x00%aI%x00']);
  if (r.code !== 0) throw new GitError(500, `git stash list failed: ${r.err}`);
  const fields = r.out.split('\0');
  const stashes: GitStash[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const ref = fields[i].trim();
    if (!ref) continue;
    const subject = fields[i + 1];
    const branch = subject.match(/^(?:WIP on|On) ([^:]+):/)?.[1] ?? null;
    stashes.push({ ref, branch, subject, timestamp: fields[i + 2].trim() });
  }
  return { stashes };
}

async function validatedStash(hostPath: string, requested: unknown): Promise<string> {
  if (typeof requested !== 'string') throw new GitError(400, 'stash-show: ref must be a string');
  const { stashes } = await stashList(hostPath);
  if (!stashes.some((entry) => entry.ref === requested)) throw new GitError(400, 'stash-show: unknown stash ref');
  return requested;
}

export async function stashShow(hostPath: string, requested: unknown, path?: unknown): Promise<{ ref: string; files: GitChange[]; path?: string; diff?: string; truncated?: boolean }> {
  const ref = await validatedStash(hostPath, requested);
  const n = await git(hostPath, ['stash', 'show', '--numstat', '-u', '-z', ref]);
  if (n.code !== 0) throw new GitError(500, `git stash show failed: ${n.err}`);
  const files = parseNumstat(n.out);
  if (path === undefined) return { ref, files };
  if (typeof path !== 'string' || !files.some((file) => file.path === path)) throw new GitError(400, 'stash-show: path is not present in this stash');
  const third = await git(hostPath, ['ls-tree', '-r', '--name-only', '-z', `${ref}^3`, '--', path]);
  const untracked = third.code === 0 && third.out.split('\0').includes(path);
  const d = untracked
    ? await git(hostPath, ['show', `${ref}^3`, '--', path], 20_000)
    : await git(hostPath, ['diff', `${ref}^1`, ref, '--', path], 20_000);
  if (d.code !== 0) throw new GitError(500, `git stash diff failed: ${d.err}`);
  const limited = truncateDiff(d.out);
  return { ref, files, path, diff: limited.text, truncated: limited.truncated };
}

function parseNumstat(out: string): GitChange[] {
  const parts = out.split('\0');
  const files: GitChange[] = [];
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const m = parts[i].match(/^([^\t]+)\t([^\t]+)\t(.*)$/s);
    if (!m) continue;
    const oldPath = m[3] ? null : (parts[++i] ?? null);
    const path = m[3] || parts[++i] || '';
    if (!path) continue;
    const binary = m[1] === '-' || m[2] === '-';
    files.push({ path, oldPath, type: oldPath ? 'renamed' : 'modified', staged: false, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  return files;
}

export interface GitLogEntry { shortSha: string; sha: string; subject: string; author: string; date: string }

async function resolveCommit(hostPath: string, requested: unknown): Promise<string> {
  if (typeof requested !== 'string' || requested.startsWith('-')) throw new GitError(400, 'commit: invalid sha');
  const r = await git(hostPath, ['rev-parse', '--verify', `${requested}^{commit}`]);
  if (r.code !== 0 || !r.out.trim()) throw new GitError(400, `commit: sha does not resolve ${JSON.stringify(requested)}`);
  return r.out.trim();
}

export async function log(hostPath: string, opts: { limit?: unknown; before?: unknown; cursor?: unknown } = {}): Promise<{ commits: GitLogEntry[]; nextCursor: string | null }> {
  await repoRoot(hostPath);
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));
  const before = opts.before ?? opts.cursor;
  const start = before === undefined ? 'HEAD' : `${await resolveCommit(hostPath, before)}^`;
  const r = await git(hostPath, ['log', `--max-count=${limit + 1}`, '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00', start]);
  if (r.code !== 0) throw new GitError(500, `git log failed: ${r.err}`);
  const fields = r.out.split('\0');
  const parsed: GitLogEntry[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const sha = fields[i].replace(/^\n/, '');
    if (sha) parsed.push({ sha, shortSha: fields[i + 1], subject: fields[i + 2], author: fields[i + 3], date: fields[i + 4] });
  }
  const more = parsed.length > limit;
  const commits = parsed.slice(0, limit);
  return { commits, nextCursor: more ? commits.at(-1)?.sha ?? null : null };
}

export async function commitFiles(hostPath: string, requested: unknown): Promise<{ sha: string; files: GitChange[] }> {
  const sha = await resolveCommit(hostPath, requested);
  const r = await git(hostPath, ['show', '--numstat', '-z', '--format=', sha]);
  if (r.code !== 0) throw new GitError(500, `git show failed: ${r.err}`);
  return { sha, files: parseNumstat(r.out) };
}

function truncateDiff(out: string): { text: string; truncated: boolean } {
  const limit = 1_000_000;
  const byteLimited = out.slice(0, limit);
  const lines = byteLimited.split('\n');
  return { text: lines.length > 20_000 ? lines.slice(0, 20_000).join('\n') : byteLimited, truncated: out.length > limit || lines.length > 20_000 };
}

export async function commitDiff(hostPath: string, requested: unknown, path: unknown): Promise<{ sha: string; path: string; diff: string; binary: boolean; truncated: boolean }> {
  const sha = await resolveCommit(hostPath, requested);
  const files = (await commitFiles(hostPath, sha)).files;
  if (typeof path !== 'string' || !files.some((file) => file.path === path)) throw new GitError(400, 'commit-diff: path is not present in this commit');
  const r = await git(hostPath, ['show', sha, '--', path], 20_000);
  if (r.code !== 0) throw new GitError(500, `git show failed: ${r.err}`);
  const binary = /(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(r.out);
  const truncated = truncateDiff(r.out);
  return { sha, path, diff: binary ? 'Binary file — preview unavailable.' : truncated.text, binary, truncated: truncated.truncated };
}

/**
 * gh repo create <name> --private --source . --push. Private by default —
 * publishing code is an explicit escalation the UI must ask for separately.
 */
export async function createRepo(hostPath: string, name: string, opts: { public?: boolean } = {}): Promise<{ created: true; detail: string; status: GitStatus }> {
  if (!/^[A-Za-z0-9._-]+$/.test(name ?? '')) throw new GitError(400, `create-repo: invalid repo name ${JSON.stringify(name)}`);
  const s = await statusOf(hostPath);
  if (!s.repo) throw new GitError(409, 'not a git repository — init first');
  if (s.remoteUrl) throw new GitError(409, `a remote already exists (${s.remoteUrl})`);
  return new Promise((resolve, reject) => {
    execFile('gh', ['repo', 'create', name, opts.public ? '--public' : '--private', '--source', hostPath, '--push'],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new GitError(502, `gh repo create failed: ${(stderr || err.message).trim().slice(0, 500)}`));
        statusOf(hostPath).then((status) => resolve({ created: true, detail: (stdout || stderr).trim().slice(0, 500), status }), reject);
      });
  });
}

/**
 * "Open terminal here" — a real terminal beats an embedded fake one. The
 * command is configurable for testing and non-kitty setups.
 */
export async function openTerminal(hostPath: string): Promise<{ launched: string }> {
  const term = process.env.CLAUDE_STATION_TERMINAL ?? 'kitty';
  // spawn() reports ENOENT asynchronously — after the HTTP response would
  // already have claimed success. Resolve the binary first so a missing
  // terminal is a 500 with words, not a silent nothing-happened.
  try {
    execFileSync('which', [term], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    throw new GitError(500, `terminal ${JSON.stringify(term)} is not on PATH (set CLAUDE_STATION_TERMINAL to override)`);
  }
  const args = term === 'kitty' ? ['--directory', hostPath] : [hostPath];
  const child = spawn(term, args, { detached: true, stdio: 'ignore', cwd: hostPath });
  child.unref();
  return { launched: `${term} in ${hostPath}` };
}
