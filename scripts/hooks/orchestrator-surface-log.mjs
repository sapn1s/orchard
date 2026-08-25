#!/usr/bin/env node
/**
 * orchestrator-surface-log.mjs — FEAT-096, experiment A-E1 ("the blindfold log").
 *
 * A `PreToolUse` hook that RECORDS what an orchestrator-profile session would
 * have been refused, and REFUSES NOTHING. It writes one JSON line per tool call
 * and exits 0 with empty output, which the harness reads as "no opinion".
 *
 * ── Log-only is the experiment, not a stepping stone ─────────────────────────
 * docs/analysis/orchestrator-design-attack-2026-08-20.md §9 puts this ahead of
 * the deny on purpose: it says what the restriction would break BEFORE it
 * breaks it, and it is the first real test of the premise. If the orchestrator
 * turns out to reach for a forbidden tool rarely, the premise is wrong and the
 * whole line of work is refuted for the price of a log. That outcome is a
 * result, not a failure of this hook.
 *
 * ── Why this hook cannot become BUG-118 ──────────────────────────────────────
 * BUG-118: a Stop hook told a hand-started session in an UNRELATED project that
 * its reply broke this project's rules. It fired on sessions the launcher never
 * started. That defect was survivable only because the hook was advisory. Three
 * properties keep this one out of the same hole:
 *   1. It never emits a decision. There is no enforce mode to flip, and the
 *      attack is explicit that the neighbouring `response-format-gate.mjs` must
 *      NOT be flipped fail-closed either.
 *   2. It is scoped to the tree it is installed in — `payload.cwd` must resolve
 *      inside this script's own repo root, or it exits silently having written
 *      nothing. A copy of this file in another project scopes itself to THAT
 *      project rather than reporting on it.
 *   3. Every failure path exits 0. An unwritable log, a malformed payload, a
 *      missing field: all silent no-ops. A hook that can break a working
 *      session to record a statistic is not worth the statistic.
 *
 * ── What the payload actually contains (measured, not assumed) ───────────────
 * Captured from a live PreToolUse hook on 2026-08-20:
 *   session_id · transcript_path · cwd · prompt_id · permission_mode · effort
 *   hook_event_name · tool_name · tool_input · tool_use_id
 * and, ON SUBAGENT CALLS ONLY, two further keys: `agent_id` and `agent_type`.
 *
 * THAT PAIR IS THE WHOLE EXPERIMENT. A subagent's tool calls fire this hook
 * too, and they carry the SAME `session_id` and the SAME `transcript_path` as
 * the main session — so session identity cannot separate the orchestrator's own
 * reaches from the shell its lanes were handed. Without `agent_id` the log
 * would count every lane's `Bash` call as an orchestrator reach and the premise
 * would appear confirmed by construction. Records are written with `agent_id`
 * verbatim (null on a main-session call) and the report separates on it.
 *
 * Deliberately NOT recorded: the full text of any tool argument. Commands and
 * paths are truncated, and a dispatch brief keeps a bounded excerpt plus
 * counted signals. The log lives outside the repo (it holds absolute paths, so
 * committing it would trip the leak gate) and is nobody's source of truth about
 * what happened — the transcript is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefSignals, isDispatchViaShell } from '../lib/orchestrator-profile.mjs';

/** Absolute cap on any stored argument fragment. */
const CMD_CHARS = 200;
const PATH_CHARS = 160;
const BRIEF_CHARS = 400;
/** Rotate rather than grow without bound; one generation kept. */
const MAX_BYTES = 25_000_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** scripts/hooks/ -> scripts/ -> repo root. */
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Log destination. Outside the repo, always. */
export function logPath() {
  const override = process.env.ORCHARD_SURFACE_LOG;
  if (override && override.trim()) return override.trim();
  const stateHome =
    (process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()) ||
    path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'claude-station', 'orchestrator-surface', 'calls.jsonl');
}

/** Is this call happening inside the tree this hook was installed in? */
export function inScope(cwd, root = REPO_ROOT) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  const resolved = path.resolve(cwd);
  return resolved === root || resolved.startsWith(root + path.sep);
}

const trunc = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/**
 * The bounded, per-tool argument digest. Enough for a person to bucket a call
 * by hand (the attack requires the bucketing be done by someone other than the
 * design's author); never the whole argument.
 */
export function digest(toolName, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (toolName) {
    case 'Bash':
      return {
        command: trunc(i.command, CMD_CHARS),
        // A profile that denies Bash also denies this project's cross-provider
        // dispatch boundary (FEAT-043 runs through the shell). Counted, so the
        // consequence shows up in the data instead of after the deny lands.
        dispatchViaShell: isDispatchViaShell(i.command),
      };
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return { path: trunc(i.file_path ?? i.notebook_path, PATH_CHARS) };
    case 'Glob':
    case 'Grep':
      return { pattern: trunc(i.pattern, PATH_CHARS), path: trunc(i.path, PATH_CHARS) };
    case 'WebFetch':
      return { url: trunc(i.url, PATH_CHARS) };
    case 'WebSearch':
      return { query: trunc(i.query, PATH_CHARS) };
    case 'Skill':
      return { skill: trunc(i.skill, PATH_CHARS) };
    case 'Agent': {
      // The escape channel. Signals computed on the FULL brief; only an excerpt stored.
      const prompt = typeof i.prompt === 'string' ? i.prompt : '';
      return {
        subagentType: trunc(i.subagent_type, 64),
        description: trunc(i.description, 120),
        background: i.run_in_background === true,
        brief: briefSignals(prompt),
        briefExcerpt: trunc(prompt, BRIEF_CHARS),
      };
    }
    case 'SendMessage': {
      // Free text to a live lane: the attack's channel 2, "explicitly preserved,
      // explicitly unbounded, and explicitly valued". Allowed by the profile and
      // still a full reasoning channel, so it is measured like a brief.
      const body = typeof i.message === 'string' ? i.message : '';
      return { brief: briefSignals(body), briefExcerpt: trunc(body, BRIEF_CHARS) };
    }
    default:
      return {};
  }
}

/** Build the record. Exported so the suite grades the real shape, not a copy of it. */
export function record(payload) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '(unknown)';
  return {
    ts: new Date().toISOString(),
    tool,
    // null on a main-session call; a string on a subagent's call. The separator.
    agentId: typeof payload.agent_id === 'string' ? payload.agent_id : null,
    agentType: typeof payload.agent_type === 'string' ? payload.agent_type : null,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    promptId: typeof payload.prompt_id === 'string' ? payload.prompt_id : null,
    permissionMode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    digest: digest(tool, payload.tool_input),
  };
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
  } catch {
    /* no file yet, or rotation raced another writer: either way, just append. */
  }
  fs.appendFileSync(file, line + '\n');
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // Not our business to complain about a payload we cannot read.
  }
  if (!payload || typeof payload !== 'object') return;
  if (!inScope(payload.cwd)) return;

  appendLine(logPath(), JSON.stringify(record(payload)));
}

// Only run the hook when executed as one; the suite imports this file.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Every path exits 0. Nothing this file can do is worth interrupting a session.
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
