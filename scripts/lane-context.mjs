#!/usr/bin/env node
/**
 * lane-context.mjs — ARCH-011's retry routing rule: MEASURE whether a worker's
 * context went stale instead of guessing at it.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION THIS IMPLEMENTS
 * ---------------------------------------------------------------------------
 * ARCH-011 asked: on a failed check, does the retry go back to the same worker
 * or to a fresh one? Three options were offered (same / fresh / route by the
 * failure reason) and the user answered with a fourth:
 *
 *   "If files themselves code didnt change since the last time the worker made
 *    the changes, then it wont be stale, otherwise if hashes changed, use fresh
 *    context"
 *
 * A worker's context is a resume from its own transcript, and that transcript
 * embeds the BYTES of every file it read. Those bytes are stale exactly when
 * the file changed underneath it — not when an interval elapsed. Time-based
 * staleness was raised in the same sentence and rejected: an interval is a
 * proxy for content change and is wrong in both directions (nobody touched it
 * in six hours = not stale; another lane rewrote it in ninety seconds = stale).
 * A hash states what the interval only estimates, at the same cost, with no
 * window to tune.
 *
 * ---------------------------------------------------------------------------
 * THE RULE — three lines, in order
 * ---------------------------------------------------------------------------
 *   1. The touched set is not knowable            -> fresh
 *   2. Any file in it hashes differently than at
 *      the lane's end                             -> fresh
 *   3. Otherwise                                  -> reuse
 *      ...except the one folded-in clause from option C: if the check that
 *      failed is one THE WORKER ITSELF REPORTED PASSING and nothing changed,
 *      that is a contradiction INSIDE its context rather than a gap in it, and
 *      re-reading cannot correct it because there is nothing new to read ->
 *      fresh. (Inverted from option C as originally written, and it costs
 *      nothing to record: the declaration and the re-run result both already
 *      exist outside the worker.)
 *
 * ---------------------------------------------------------------------------
 * THE GUARD RAIL — read this before extending anything here
 * ---------------------------------------------------------------------------
 * REUSE IS ABOUT COST, AND ABOUT NOTHING ELSE. This tool decides whether a
 * context is worth re-reading. It has NO vote on who authors the checks or who
 * runs them — those stay with someone other than the worker in BOTH branches,
 * which is the invariant ARCH-011 is named after. A worker keeping its context
 * also keeps its blind spot; what stops the blind spot from mattering is that
 * the failing check was written and re-run elsewhere, not that the worker is
 * fresh. If a future change lets a reused worker supply or grade its own check,
 * that change is wrong and nothing in this file's reasoning supports it.
 *
 * ---------------------------------------------------------------------------
 * VERBS
 * ---------------------------------------------------------------------------
 *   fingerprint --agent=<agentId> [--cwd=<repo>] [--also=<p1,p2>]
 *       Derive the touched set from the lane's own transcript and hash each
 *       file AS IT IS NOW — i.e. at the lane's end, while the bytes it reasoned
 *       about are still current. Writes one small JSON record.
 *
 *   check --agent=<agentId> [--cwd=<repo>]
 *         [--failed-check=<name>] [--worker-declared=<n1,n2>]
 *       Re-hash and route. Emits {"route":"reuse"|"fresh","reason":...}.
 *       With no stored fingerprint it falls back to git + mtime evidence since
 *       the lane's last transcript timestamp and SAYS SO — that oracle is
 *       weaker and can only over-report change, so it errs toward `fresh`.
 *
 * Output is JSON on stdout, always. Exit 0 = a verdict was produced (of either
 * kind); nonzero = no verdict could be produced, with a refusal on stdout.
 *
 * WHAT THE BASELINE IS, AND IS NOT. The comparison is against the bytes as the
 * worker last saw them — never against the commit it produced. Those differ,
 * and the difference is the common case: a commit holds only what the lane
 * WROTE while its context is stale on what it READ; many lanes commit nothing;
 * and another lane committing in between moves the commit graph without
 * necessarily changing a byte this lane relied on, which a git-range comparison
 * calls stale and a hash correctly does not.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/* ──────────────────────────────────────────────────────────── where things live */

/** Mirrors src/lib/paths.ts dataDir() exactly, so an isolated run really is isolated. */
function dataDir() {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

const storeDir = () => path.join(dataDir(), 'lane-context');
const storePath = (agentId) => path.join(storeDir(), `${agentId}.json`);

/** The CLI's transcript root. Same env knob the CLI itself honours. */
function claudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() ? path.resolve(env) : path.join(os.homedir(), '.claude');
}

/** The CLI encodes a project directory by replacing every non-alphanumeric run with '-'. */
function encodeProjectDir(dir) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Locate `<projects>/<encoded>/<sessionId>/subagents/agent-<id>.jsonl`.
 * The session id is not required from the caller: agent ids are unique within a
 * project, so the subagent directories are scanned. Returns null when absent —
 * an absent transcript is a real answer (rule 1), not an error.
 */
function findAgentTranscript(cwd, agentId) {
  const projRoot = path.join(claudeHome(), 'projects', encodeProjectDir(cwd));
  let sessions = [];
  try {
    sessions = fs.readdirSync(projRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  const leaf = agentId.startsWith('agent-') ? `${agentId}.jsonl` : `agent-${agentId}.jsonl`;
  for (const s of sessions) {
    const p = path.join(projRoot, s.name, 'subagents', leaf);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Is the lane FINISHED? This matters more than it looks.
 *
 * The CLI appends to a lane transcript while the lane runs, so a fingerprint
 * taken mid-flight sees a TRUNCATED touched set — and a truncated touched set
 * is the one failure mode of this whole rule that is dangerous in the unsafe
 * direction: fewer files to compare means fewer chances to notice a change,
 * which turns a genuinely stale lane into a `reuse`. A race is a timing, not a
 * shape, so a complete-looking transcript proves nothing on its own.
 *
 * The completion signal lives in the PARENT session, not in the lane: the
 * parent records a `tool_result` for the lane's `toolUseId` (the same signal
 * src/server/subagents.ts derives status from). `meta.json` beside the lane
 * transcript carries that id. Returns true / false / null (no meta, unknowable).
 */
function laneComplete(transcriptPath) {
  const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');
  let toolUseId = null;
  try { toolUseId = JSON.parse(fs.readFileSync(metaPath, 'utf8')).toolUseId ?? null; } catch { return null; }
  if (!toolUseId) return null;
  // <project>/<sessionId>/subagents/agent-x.jsonl  ->  <project>/<sessionId>.jsonl
  const sessionDir = path.dirname(path.dirname(transcriptPath));
  const parent = `${sessionDir}.jsonl`;
  let text;
  try { text = fs.readFileSync(parent, 'utf8'); } catch { return null; }
  // The id appears in the parent's own `tool_use` block too — that is present
  // from the moment the lane is LAUNCHED, so a substring match would report
  // every running lane as finished. Only a `tool_result` carrying it counts.
  for (const line of text.split('\n')) {
    if (!line.includes(toolUseId)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = (o.message && o.message.content) || [];
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'tool_result' && b.tool_use_id === toolUseId) return true;
    }
  }
  return false;
}

/* ─────────────────────────────────────────────────── deriving the touched set */

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Paths named as arguments to the lane's own Bash commands.
 *
 * WHY THIS EXISTS, measured rather than assumed: over the 599 real worker
 * transcripts on this machine, 357 of the 431 lanes that wrote through a file
 * tool ALSO ran a write-shaped Bash command (`sed -i`, a heredoc, a redirect, a
 * board tool). So the file-tool set alone understates what a lane knows about.
 *
 * Deliberately conservative: a token only counts if it looks like a path, the
 * file EXISTS, and it is INSIDE the repo. Anything found this way is tagged
 * `bash_arg` in the record, so a reader can always tell a certain touch from an
 * inferred one. Writes outside version control (scratch dirs, caches) are
 * outside this rule and are not silently folded in.
 */
function bashPaths(cmd, cwd) {
  const out = new Set();
  const tokens = String(cmd).split(/[\s;|&()'"`=<>]+/);
  for (const t of tokens) {
    if (!t || t.length < 3 || !/[./]/.test(t)) continue;
    if (t.startsWith('-')) continue;
    const abs = path.resolve(cwd, t);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out.add(path.relative(cwd, abs));
  }
  return out;
}

/**
 * Read a lane transcript into {touched: Map<relpath, source>, lastTs, entries}.
 * `source` is 'file_tool' (certain: the lane read or wrote it through a tool
 * whose input names the path) or 'bash_arg' (inferred, see bashPaths).
 */
function readLane(transcriptPath, cwd) {
  const touched = new Map();
  let lastTs = null;
  let entries = 0;
  const text = fs.readFileSync(transcriptPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // a partially written last line is not a parse failure of the lane
    entries++;
    if (typeof o.timestamp === 'string') lastTs = o.timestamp;
    if (o.type !== 'assistant') continue;
    const content = (o.message && o.message.content) || [];
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
      const input = b.input || {};
      if (FILE_TOOLS.has(b.name)) {
        const fp = input.file_path;
        if (typeof fp !== 'string' || !fp) continue;
        const abs = path.resolve(cwd, fp);
        if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
        touched.set(path.relative(cwd, abs), 'file_tool');
      } else if (b.name === 'Bash' && typeof input.command === 'string') {
        for (const rel of bashPaths(input.command, cwd)) {
          if (!touched.has(rel)) touched.set(rel, 'bash_arg');
        }
      }
    }
  }
  return { touched, lastTs, entries };
}

/** sha256 of a file, or null when it does not exist (a deletion is a change, not an error). */
function hashFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────── verbs */

function verbFingerprint(flags) {
  const cwd = path.resolve(flags.get('cwd') || process.cwd());
  const agentId = flags.get('agent');
  if (!agentId) return refuse('missing-arg', 'fingerprint: --agent=<agentId> is required');

  const tp = findAgentTranscript(cwd, agentId);
  if (!tp) {
    return refuse(
      'no-transcript',
      `fingerprint: no lane transcript for ${agentId} under ${path.join(claudeHome(), 'projects', encodeProjectDir(cwd))}`,
      ['A lane with no transcript has no knowable touched set, so `check` will route it to a fresh worker (rule 1).'],
    );
  }

  // A fingerprint of a RUNNING lane is the one wrong answer this rule can give
  // in the unsafe direction — a partial touched set routes a stale lane to
  // `reuse`. Refuse rather than record something that looks complete.
  const complete = laneComplete(tp);
  if (complete === false && !flags.has('allow-running')) {
    return refuse('lane-not-complete', `fingerprint: ${agentId} has no tool_result in its parent session, so it may still be running and its transcript still growing`, [
      'A fingerprint taken mid-flight records a TRUNCATED touched set, and a short touched set routes a stale lane to reuse.',
      'Fingerprint at the lane\'s end. Pass --allow-running=1 only if you have another reason to believe it has stopped.',
    ]);
  }

  const { touched, lastTs, entries } = readLane(tp, cwd);
  for (const extra of csv(flags.get('also'))) {
    const rel = path.relative(cwd, path.resolve(cwd, extra));
    if (!touched.has(rel)) touched.set(rel, 'declared');
  }

  const files = [];
  for (const [rel, source] of [...touched].sort()) {
    const abs = path.join(cwd, rel);
    files.push({ path: rel, source, sha256: hashFile(abs) });
  }

  const record = {
    agent_id: agentId,
    cwd,
    transcript: tp,
    lane_last_timestamp: lastTs,
    transcript_entries: entries,
    lane_complete: complete,
    fingerprinted_at: new Date().toISOString(),
    files,
  };
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(storePath(agentId), JSON.stringify(record, null, 2) + '\n');

  return {
    ok: true,
    verb: 'fingerprint',
    agent_id: agentId,
    stored: storePath(agentId),
    file_count: files.length,
    by_source: countBy(files, (f) => f.source),
    missing_at_fingerprint: files.filter((f) => f.sha256 === null).map((f) => f.path),
    lane_last_timestamp: lastTs,
    lane_complete: complete,
  };
}

function verbCheck(flags) {
  const cwd = path.resolve(flags.get('cwd') || process.cwd());
  const agentId = flags.get('agent');
  if (!agentId) return refuse('missing-arg', 'check: --agent=<agentId> is required');

  const failedCheck = flags.get('failed-check') || null;
  const declared = new Set(csv(flags.get('worker-declared')));

  /** The C fold-in, applied only where the hash has already said "unchanged". */
  const contradiction = failedCheck !== null && declared.has(failedCheck);

  const sp = storePath(agentId);
  let record = null;
  if (fs.existsSync(sp)) {
    try { record = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { record = null; }
  }

  if (record) return checkAgainstFingerprint(record, cwd, { failedCheck, contradiction });
  return checkFallback(cwd, agentId, { failedCheck, contradiction });
}

function checkAgainstFingerprint(record, cwd, { failedCheck, contradiction }) {
  const base = {
    ok: true,
    verb: 'check',
    agent_id: record.agent_id,
    oracle: 'content-hash',
    failed_check: failedCheck,
  };

  // Rule 1 — an empty touched set is UNMEASURABLE, never "unchanged". Measured:
  // 87 of 599 real lanes record no file-tool call, and 85 of those 87 ran Bash.
  if (!record.files.length) {
    return {
      ...base,
      route: 'fresh',
      reason: 'touched-set-unknowable',
      explain: 'The lane recorded no file it touched. That is an absence of evidence, not evidence of no change, so the retry does not reuse a context nothing can vouch for.',
      changed: [],
    };
  }

  const changed = [];
  const unchanged = [];
  for (const f of record.files) {
    const now = hashFile(path.join(cwd, f.path));
    if (now === f.sha256) unchanged.push(f.path);
    else changed.push({ path: f.path, source: f.source, was: f.sha256, now, kind: now === null ? 'deleted' : f.sha256 === null ? 'created' : 'modified' });
  }

  // Rule 2 — any byte moved under the lane and its context is no longer true.
  if (changed.length) {
    return {
      ...base,
      route: 'fresh',
      reason: 'touched-files-changed',
      explain: `${changed.length} of ${record.files.length} file(s) the lane reasoned about no longer hash as they did at its end, so the bytes embedded in its context are wrong.`,
      changed,
      unchanged_count: unchanged.length,
    };
  }

  // Rule 3's exception — option C, folded in, inverted.
  if (contradiction) {
    return {
      ...base,
      route: 'fresh',
      reason: 'contradicts-own-declaration',
      explain: `Nothing the lane touched has changed, yet "${failedCheck}" — a check the lane itself reported passing — fails on re-run. With no new bytes to read, that is a contradiction inside its context rather than a gap in it, and resuming would re-anchor on the wrong belief.`,
      changed: [],
      unchanged_count: unchanged.length,
    };
  }

  // Rule 3 — reuse. Cost only. The checks stay authored and re-run elsewhere.
  return {
    ...base,
    route: 'reuse',
    reason: 'touched-files-unchanged',
    explain: `All ${unchanged.length} file(s) the lane reasoned about hash exactly as they did at its end, so its context is still true and re-deriving it would be paid for nothing. Reuse is a cost decision only: the failing check was authored and re-run by someone other than this worker, and that does not change.`,
    changed: [],
    unchanged_count: unchanged.length,
  };
}

/**
 * No fingerprint was taken. Fall back to git + mtime evidence since the lane's
 * last transcript timestamp, and SAY SO. This oracle is strictly weaker: a
 * commit that restores identical bytes, or a `touch`, both read as change. It
 * can therefore only OVER-report change, which errs toward a fresh worker —
 * the safe direction — and it is never presented as a hash comparison.
 */
function checkFallback(cwd, agentId, { failedCheck, contradiction }) {
  const base = {
    ok: true,
    verb: 'check',
    agent_id: agentId,
    oracle: 'git+mtime-fallback',
    oracle_caveat: 'No fingerprint was taken at the lane\'s end, so this compares evidence of change rather than content. It can report change where the bytes are identical (a reverting commit, a bare touch), never the reverse — so it errs toward a fresh worker.',
    failed_check: failedCheck,
  };

  const tp = findAgentTranscript(cwd, agentId);
  if (!tp) {
    return {
      ...base,
      route: 'fresh',
      reason: 'no-lane-transcript',
      explain: `No transcript for ${agentId}, so neither the touched set nor its state can be established.`,
      changed: [],
    };
  }
  const { touched, lastTs } = readLane(tp, cwd);
  if (!touched.size) {
    return { ...base, route: 'fresh', reason: 'touched-set-unknowable', explain: 'The lane recorded no file it touched.', changed: [], lane_last_timestamp: lastTs };
  }
  if (!lastTs) {
    return { ...base, route: 'fresh', reason: 'no-lane-timestamp', explain: 'The lane transcript carries no timestamp, so there is no moment to compare since.', changed: [], };
  }

  const since = new Date(lastTs);
  const rels = [...touched.keys()];
  const changed = [];

  const git = spawnSync('git', ['log', `--since=${since.toISOString()}`, '--pretty=format:%H', '--name-only', '--', ...rels], { cwd, encoding: 'utf8' });
  if (git.status === 0) {
    for (const line of git.stdout.split('\n')) {
      const t = line.trim();
      if (t && touched.has(t)) changed.push({ path: t, source: touched.get(t), kind: 'committed-since' });
    }
  }
  for (const rel of rels) {
    try {
      const st = fs.statSync(path.join(cwd, rel));
      if (st.mtime > since && !changed.some((c) => c.path === rel)) {
        changed.push({ path: rel, source: touched.get(rel), kind: 'mtime-after-lane-end' });
      }
    } catch {
      changed.push({ path: rel, source: touched.get(rel), kind: 'deleted' });
    }
  }

  if (changed.length) {
    return { ...base, route: 'fresh', reason: 'touched-files-changed', explain: `${changed.length} of ${rels.length} file(s) show evidence of change since the lane ended.`, changed, lane_last_timestamp: lastTs };
  }
  if (contradiction) {
    return { ...base, route: 'fresh', reason: 'contradicts-own-declaration', explain: `Nothing the lane touched shows evidence of change, yet "${failedCheck}" — a check the lane itself reported passing — fails on re-run.`, changed: [], lane_last_timestamp: lastTs };
  }
  return { ...base, route: 'reuse', reason: 'touched-files-unchanged', explain: `No file the lane touched shows evidence of change since it ended (${rels.length} checked).`, changed: [], unchanged_count: rels.length, lane_last_timestamp: lastTs };
}

/* ─────────────────────────────────────────────────────────────────────── cli */

function csv(v) {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function countBy(arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}
class Refusal extends Error {
  constructor(payload) { super(payload.refusal.message); this.payload = payload; }
}
function refuse(code, message, detail = []) {
  throw new Refusal({ ok: false, refusal: { code, message, detail } });
}

const VERBS = { fingerprint: verbFingerprint, check: verbCheck };
const KNOWN = ['agent', 'cwd', 'also', 'failed-check', 'worker-declared', 'allow-running'];

function main(argv) {
  const verb = argv[0];
  if (!VERBS[verb]) {
    return { ok: false, refusal: { code: 'unknown-verb', message: `unknown verb ${JSON.stringify(verb ?? '')}`, detail: [`verbs: ${Object.keys(VERBS).join(' | ')}`] } };
  }
  const flags = new Map();
  const bad = [];
  for (const a of argv.slice(1)) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(a);
    if (!m) { bad.push(a); continue; }
    if (!KNOWN.includes(m[1])) { bad.push(a); continue; }
    flags.set(m[1], m[2]);
  }
  if (bad.length) {
    return { ok: false, refusal: { code: 'bad-flags', message: `${verb}: arguments must be --flag=value from a known set; got ${bad.map((b) => JSON.stringify(b)).join(' ')}`, detail: [`known: ${KNOWN.map((k) => `--${k}`).join(' ')}`] } };
  }
  try {
    return VERBS[verb](flags);
  } catch (err) {
    if (err instanceof Refusal) return err.payload;
    throw err;
  }
}

const out = main(process.argv.slice(2));
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(out.ok ? 0 : 1);
