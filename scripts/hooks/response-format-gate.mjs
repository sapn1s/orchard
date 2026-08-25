#!/usr/bin/env node
/**
 * FEAT-085 — Stop-hook response-format gate. **ADVISORY BY DEFAULT.**
 *
 * Wired as a Claude Code `Stop` hook in THIS project's .claude/settings.json.
 * When the model decides a turn is done, Claude Code runs this script with the
 * Stop payload on stdin. We inspect the assistant's FINAL message and grade it.
 *
 * ── TWO MODES (decided ONCE, at startup, from the environment):
 *   ADVISORY (default, env ORCHARD_STOP_HOOK_ENFORCE unset/falsey)
 *     A violation is REPORTED, never blocked: a `systemMessage` on stdout (shown
 *     to the user in the UI, consumes no turn), a line appended to a log file
 *     under the app data dir (NOT the repo), and a line on stderr. The turn is
 *     always allowed. `{"decision":"block"}` is UNREACHABLE in this mode — the
 *     enforcing emitter is never constructed (see makeViolationReporter).
 *   ENFORCE (opt-in, env ORCHARD_STOP_HOOK_ENFORCE truthy: 1/true/yes)
 *     A violation BLOCKS the stop (exit 0, {"decision":"block","reason":...} on
 *     stdout) — Claude Code feeds `reason` back as a just-in-time correction.
 *
 * ── WHY ADVISORY IS THE DEFAULT (2026-08-15): in live use the gate produced
 *   THREE false blocks on fully compliant replies and ZERO true positives. Root
 *   cause (transcript-confirmed) is a read-during-write RACE, not a grading bug:
 *   the Stop hook can read the JSONL before the final assistant text line is
 *   flushed, so it grades a PREVIOUS/mid-turn message instead. No amount of
 *   grading logic fixes that from inside the hook — so it must not cost a turn.
 *
 * ── Verified Stop-hook contract (Claude Code, docs + real transcript, 2026-08-14):
 *   stdin  : { session_id, transcript_path, cwd, hook_event_name:"Stop",
 *              stop_hook_active: boolean }
 *   stop_hook_active is TRUE when a Stop hook already blocked once this turn — we
 *   MUST allow when it is set, so the loop can never run more than one correction.
 *   transcript_path : a JSONL file; each line an event. Assistant turns are
 *     { type:"assistant", isSidechain?:bool, message:{ role:"assistant",
 *       content:[ { type:"text", text } , ... ] } }. Subagent output carries
 *     isSidechain:true and is ignored — only the MAIN thread's final text counts.
 *   BLOCK  : print {"decision":"block","reason":"..."} to stdout, exit 0.
 *   ALLOW  : print nothing, exit 0. (decision:"approve" also allows; we prefer
 *            silence so a compliant turn emits no re-prompt at all.)
 *
 * ── Load-bearing safety (a buggy Stop hook can wedge EVERY turn):
 *   0. ADVISORY by default -> blocking is impossible without the explicit opt-in.
 *   1. stop_hook_active === true            -> ALWAYS allow (one correction cap).
 *   2. FAIL OPEN: any exception, unreadable/garbage payload, missing transcript,
 *      no assistant message, or the internal watchdog -> ALLOW. Never wedge.
 *   3. Disable switch: env ORCHARD_STOP_HOOK_DISABLED (truthy) -> inert (allow).
 *   3b. LAUNCHER GATE (BUG-118): the hook is inert unless env ORCHARD_SESSION
 *      names THIS EXACT SESSION — i.e. it equals the payload's `session_id`.
 *      This file is installed into every ONBOARDED project's own
 *      .claude/settings.json, so Claude Code runs it for ANY session whose cwd
 *      is that project — including a bare `claude` the user starts by hand, in
 *      their own unrelated work. A bare presence flag could not tell those
 *      apart: a `claude` started from a terminal INSIDE an Orchard session
 *      inherits the parent's environment by ordinary process inheritance, so it
 *      satisfied `ORCHARD_SESSION=1` and got advised anyway (round-1 defect).
 *      Identity cannot be inherited: the nested session gets its own new
 *      session id, so it can never match the id its parent declared. That
 *      equality is the ONLY way to be graded — round 3 removed the launch-claim
 *      side door, which let anything that could write the data dir make this
 *      hook vouch for any session. FAIL CLOSED TOWARD SILENCE: a false advisory
 *      in someone else's turn is worse than a missed one in ours, because this
 *      format only matters for replies Orchard renders.
 *   4. Per-project opt-out: if the registry marks this project's
 *      responseDigest.enabled === false, do not block (matches FEAT-083/084).
 *
 * ── Checks (deterministic, no model call):
 *   - The final message leads with a valid ```orchard-digest fence: the PASS/FAIL
 *     decision is delegated to the SINGLE source of truth, parseDigest() from
 *     public/lib/digest.js (leading-fence only; non-empty items; each item a
 *     non-empty text + recognised kind/importance). A local mirror of the same
 *     fence regex is used ONLY to word the failure (missing / malformed / empty),
 *     never to decide pass/fail.
 *   - No emojis anywhere in the reply (explicit user requirement: plain text).
 *   - READABILITY of the PROSE (scripts/lib/readability.mjs, shared/reusable):
 *     the reply's running prose — EXCLUDING the digest, fenced code, tables and
 *     URLs — must stay under the calibrated thresholds (primary: max sentence
 *     length and subordinate-clause density; secondary context: mean sentence
 *     length, Flesch–Kincaid grade). Thresholds carry headroom above good
 *     writing; short / mostly-code / mostly-quote replies are never judged.
 *     A readability violation follows the SAME advisory/enforce path as the
 *     format checks (advisory reports, never blocks; enforce blocks).
 *   - FEAT-091 LAYER 2 — the SEMANTIC prose blocks (finding / outcome / ask /
 *     judgment / status / narration, plus the declared `orchard-uncategorized`
 *     fallback), parsed by public/lib/response-blocks.js. This layer is MEASURED,
 *     NOT POLICED: content outside a block still renders, so it never produces a
 *     hard violation. Every graded turn writes a metrics line
 *     (scripts/lib/format-metrics.mjs) recording per-category usage, each declared
 *     uncategorized block WITH ITS LABEL, and the size/position/shape-tags/excerpt
 *     of each run of loose prose — kept apart, because a vocabulary gap and a
 *     compliance gap call for opposite responses. Two advisories can be raised: a
 *     structurally broken `orchard-*` fence (content collapsed or expanded against
 *     the author's intent), and an `orchard-uncategorized` block with no label
 *     (which silently destroys the signal the block exists to produce).
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateReadability } from '../lib/readability.mjs';

/* ── ALLOW primitive ─────────────────────────────────────────────────────── */

function allow() {
  // Silence = allow the stop with zero re-prompt. This is the compliant-turn path.
  process.exit(0);
}

/** Env truthiness used by every switch here: 1/true/yes (case-insensitive). */
function isTruthyEnv(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Human-readable summary of what failed, shared by both modes.
 * Takes categorized reasons so a readability-only violation is not worded as a
 * missing-digest failure (and vice-versa). Each category carries its own
 * actionable instruction; only the categories that failed are mentioned.
 */
function summarise({ formatReasons = [], readabilityReasons = [], blockReasons = [] }) {
  const parts = ['Your reply does not meet this project\'s response guidelines.'];
  if (formatReasons.length) {
    parts.push(formatReasons.join(' '));
    parts.push(
      'Lead with a valid ```orchard-digest fenced JSON block ' +
      '({"items":[{"text":"…","kind":"decision|done|in-flight|fyi",' +
      '"importance":"high|med|low"}]}) and use plain text only (no emojis).'
    );
  }
  if (blockReasons.length) {
    // FEAT-091 layer 2. Worded separately from the digest failure: the fix is a
    // fence, not a JSON envelope, and conflating them sends the author to the
    // wrong place.
    parts.push(blockReasons.join(' '));
    parts.push(
      'Close every ```orchard-* fence with a backtick run at least as long as the ' +
      'one that opened it (use 4 backticks when the block contains code), and give ' +
      'every ```orchard-uncategorized fence a short label saying what the content is.',
    );
  }
  if (readabilityReasons.length) {
    parts.push('Readability: ' + readabilityReasons.join(' '));
    parts.push(
      'Rewrite the PROSE so a busy reader can extract the decision in under ' +
      '30 seconds: short sentences, few nested clauses, concrete nouns.'
    );
  }
  return parts.join(' ');
}

/* ── Launcher gate (BUG-118) ─────────────────────────────────────────────────
 * The signal that says "Orchard started THIS session". Two halves, and both are
 * load-bearing:
 *
 *   1. THE CHANNEL is an env var, because the Stop payload carries nothing about
 *      who launched the session (verified live: session_id, transcript_path,
 *      cwd, prompt_id, permission_mode, effort, hook_event_name,
 *      stop_hook_active, last_assistant_message, background_tasks,
 *      session_crons — identical for a hand-started `claude`). Env is what
 *      reaches the hook (hook commands are children of the CLI) and what
 *      survives every way an Orchard session starts:
 *        fresh launch   — set on the SDK spawn env (claude-runtime.ts).
 *        resume / open  — resume is a NEW spawn down that same path.
 *        survivor       — the CLI that outlived a server restart is the SAME
 *                         process, still holding its spawn env; the
 *                         continuation after the drain is a resume spawn.
 *        container      — forwarded through `docker exec --env`
 *                         (ENV_PASSTHROUGH in container-manager.ts).
 *
 *   2. THE VALUE is the SESSION ID Orchard declared for that CLI (it passes
 *      `--session-id <uuid>` for a fresh launch/fork, and reuses the resumed id
 *      otherwise), not a bare `1`. A presence flag is inherited by every
 *      descendant process, which is precisely how round 1 failed: a plain
 *      `claude` typed into a terminal opened from an Orchard session inherited
 *      `ORCHARD_SESSION=1` and was advised. Identity cannot be inherited — that
 *      nested session gets its OWN new session id (observed live: parent
 *      bfd9235f…, nested fd999564…), so the equality test below can never be
 *      accidentally satisfied by a child.
 *
 * The two failure directions:
 *   TOO LOUD (round-1 defect) is now unrepresentable by construction — advising
 *     requires the payload's own session_id, which the launcher has to have
 *     named. Inheritance carries the value but not the identity.
 *   TOO QUIET is the dangerous one (nobody notices). It would need the CLI to
 *     report a session id different from the one Orchard declared. It is
 *     WATCHED, not repaired: the server compares every message's session id
 *     against its declaration and warns with both ids (#noteSessionId in
 *     claude-runtime.ts), and a session that drifts stops producing format
 *     metrics. Round 2 tried to repair it automatically with a claims file the
 *     hook honoured; that file was writable by anything running as this user,
 *     which made "the hook vouches for session X" a thing any process could
 *     ask for, so it is gone (see launchedByOrchard). Never observed live.
 *
 * NOT covered, deliberately: a foreign session Orchard merely FOLLOWS/renders
 * but did not spawn. We cannot put an env var into a process we did not start,
 * and such a session never received the response-format instruction either, so
 * grading it would be advice for a rule it was never given. Silence is correct.
 */
const ORCHARD_SESSION_ENV = 'ORCHARD_SESSION';

/**
 * Did Orchard launch the session this Stop payload is for?
 *
 * ONE test, and deliberately only one: the marker on our environment must BE
 * this payload's session id. No session_id in the payload means the turn cannot
 * be attributed at all -> not ours -> silence.
 *
 * ROUND 3 — THE SECOND ESCAPE HATCH IS GONE. Round 2 also accepted a "launch
 * claim" (`{declared, observed, ts}` in `dataDir()/launch-claims.json`), so a
 * CLI that renamed its own session could still be graded. It was defensive
 * cover for something never once observed, and it re-opened the round-1 hole:
 * an independent pass wrote a claim dated a year in the FUTURE (the age test
 * had no lower bound), pointed it at a foreign session id, and the hook advised
 * a session it had no business advising. Bounding the timestamp at both ends
 * would have closed that instance and left the CLASS wide open — the file is an
 * ordinary user-writable file, so a truthful `ts: Date.now()` from ANY process
 * running as this user buys the same thing. The hook cannot tell a claim
 * written by the server from a claim written by anyone else, so no validation
 * inside the hook can make the file trustworthy.
 *
 * What removal buys, precisely:
 *   UNREPRESENTABLE now — advising a session whose id is not the one the
 *     launcher named. There is no second path to `true` here: no file, no
 *     clock, no parse, no staleness window, no concurrent writer. The only
 *     remaining input is the env marker, which grants authority over exactly
 *     ONE session (the one it names) to whoever can set it on the CLI's own
 *     environment — not over any session, from a file on the side.
 *   GUARDED, not eliminated — the opposite direction, a genuine Orchard session
 *     the CLI renames mid-life, now goes SILENT. That is the bias this gate
 *     already declares as correct, and it is not invisible: the runtime still
 *     watches its own stream and warns loudly with both ids (`#noteSessionId`
 *     in claude-runtime.ts), the hook itself now writes an `ungraded` record
 *     naming both ids (round 4, see noteUnattributed), and the session simply
 *     stops appearing in the format metrics. Neither has ever fired in a live
 *     run.
 *
 * ROUND 4 — the same single test, but it now REPORTS its reason.
 *
 * `ours` is unchanged: the marker on our environment must BE this payload's
 * session id. What is new is that the two ways of NOT being ours are named and
 * recorded (see noteUnattributed), because they are the observable that several
 * otherwise untestable scenarios collapse into:
 *   `no-id`    — the marker is set but the payload carries no session_id at all
 *                (a CLI that stops sending one; an upgrade that changes the
 *                payload shape).
 *   `other-id` — the marker names a DIFFERENT session than the payload's. This
 *                covers both the correct silence (a hand-started nested
 *                `claude`, which inherits the value and has its own id) and the
 *                dangerous one (a genuine Orchard session whose id changed
 *                mid-life: a cleared or branched conversation, a replayed
 *                transcript, a compaction that re-keys the session). The hook
 *                cannot tell those two apart from inside — env carries the value
 *                but no proof of who else is running — so it stays SILENT toward
 *                the user (advising a stranger is round 1's defect) and leaves a
 *                RECORD instead. The launcher, which knows the id it declared,
 *                is the party that can and does warn loudly (#noteSessionId).
 *   `no-marker` — not our environment at all. Nothing to say; every unrelated
 *                session in an onboarded project takes this path, and it is the
 *                overwhelmingly common one, so it must stay free.
 */
function attribution(payload) {
  const declared = typeof process.env[ORCHARD_SESSION_ENV] === 'string'
    ? process.env[ORCHARD_SESSION_ENV].trim()
    : '';
  if (!declared) return { verdict: 'no-marker', declared: '', observed: '' };
  const sid = typeof payload?.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sid) return { verdict: 'no-id', declared, observed: '' };
  if (sid === declared) return { verdict: 'ours', declared, observed: sid };
  return { verdict: 'other-id', declared, observed: sid };
}

/* ── Advisory log sink (outside the repo; best-effort, never throws) ──────── */

function advisoryLogPath() {
  return path.join(dataDir(), 'logs', 'stop-hook-advisory.log');
}

function appendAdvisoryLog(message, payload) {
  try {
    const file = advisoryLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: typeof payload?.session_id === 'string' ? payload.session_id : null,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
      transcript_path: typeof payload?.transcript_path === 'string' ? payload.transcript_path : null,
      mode: 'advisory',
      message,
    });
    fs.appendFileSync(file, line + '\n');
  } catch {
    // A log failure must never affect the turn.
  }
}

/**
 * ROUND 4 — A TURN THIS HOOK DECLINED TO GRADE LEAVES A TRACE.
 *
 * Silence is indistinguishable from compliance. That is precisely why the stale
 * round-1 copies survived three rounds: they graded nothing and looked exactly
 * like a project full of well-formatted replies. So whenever the marker is on
 * our environment (this process really was started under Orchard) and the turn
 * still could not be attributed, write one line saying so, with both ids.
 *
 * Channel choice, deliberately: the advisory LOG ONLY — not a `systemMessage`,
 * not stdout, not even stderr. The hook cannot tell a genuine drifted Orchard
 * session from a hand-started nested `claude` that merely inherited the marker,
 * and anything written to the process's own channels lands in the SECOND one's
 * face, which is the round-1 complaint all over again. So the turn stays exactly
 * as silent as before toward whoever is running, and the trace goes where it is
 * useful: our own log, outside the repo, greppable by anyone asking "why is
 * nothing being graded?". The loud, user-facing half of this belongs to the
 * launcher, which is the only party that knows the id it declared
 * (#noteSessionId in claude-runtime.ts).
 */
function noteUngraded(record, payload) {
  try {
    const file = path.join(dataDir(), 'logs', 'stop-hook-advisory.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      mode: 'ungraded',
      ...record,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
    }) + '\n');
  } catch {
    // Reporting must never affect the turn.
  }
}

function noteUnattributed({ verdict, declared, observed }, payload) {
  if (verdict === 'ours' || verdict === 'no-marker') return; // nothing to report
  const why = verdict === 'no-id'
    ? 'the Stop payload carried no session_id, so the turn cannot be attributed'
    : 'the payload names a different session than the launcher declared (inherited marker, or a session id that changed mid-life)';
  noteUngraded({
    verdict,
    declared,
    observed: observed || null,
    message: `response-format gate did not grade this turn: ${why}`,
  }, payload);
}

/**
 * ROUND 4 — THE SAME RULE, APPLIED TO OUR OWN DEPENDENCIES.
 *
 * The hook travels with a closure it does not own the delivery of: the digest
 * grammar, the readability grader, the block parser. onboard copies those once
 * and never re-syncs them (they have names a target repo can plausibly own, so
 * clobbering them is not safe the way clobbering the hook is). A copy that has
 * drifted therefore fails INSIDE this file — a missing export, a changed
 * signature — and every one of those paths used to end at `allow()`, which is
 * the exact shape of failure this ticket exists to kill: the gate stops working
 * and the project looks compliant.
 *
 * It still allows the turn (never wedge), but it now says why, in the same log.
 * A `deps-*` record is the fingerprint of a repaired hook sitting on top of a
 * stale closure — the one thing the launcher's byte check cannot see.
 */
function noteCannotGrade(verdict, detail, payload) {
  noteUngraded({
    verdict,
    detail: detail ? String(detail).slice(0, 300) : null,
    message: 'response-format gate could not grade this turn: its own grading dependencies did not load or behave as expected (a stale copy of the method closure in this project?)',
  }, payload);
}

/* ── Violation reporter: the ONE place a mode difference exists ──────────────
 * Built ONCE at startup. In advisory mode the enforcing closure — the only code
 * that can ever write {"decision":"block"} — is never constructed, so blocking
 * is impossible by construction rather than by a late conditional. */
function makeViolationReporter() {
  if (!isTruthyEnv(process.env.ORCHARD_STOP_HOOK_ENFORCE)) {
    /* ADVISORY: report through non-turn-consuming channels, then ALLOW. */
    return function advise(cats, payload) {
      const message = summarise(cats);
      appendAdvisoryLog(message, payload);
      try { process.stderr.write('[orchard stop-hook advisory] ' + message + '\n'); } catch { /* ignore */ }
      try {
        // `systemMessage` is displayed to the user in the UI and does NOT block
        // the stop (no `decision`, no `continue:false`). Verified against the
        // Claude Code settings/hook-output schema.
        process.stdout.write(JSON.stringify({
          systemMessage: 'Response-format advisory (not enforced): ' + message,
          suppressOutput: true,
        }));
      } catch { /* if we cannot report, still allow */ }
      return allow();
    };
  }

  /* ENFORCE (opt-in only): block the stop with a corrective reason. */
  return function enforce(cats) {
    const reason = summarise(cats) + ' Re-send the SAME answer, corrected.';
    try {
      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch {
      // If we somehow cannot emit the block, fail open rather than hang.
    }
    return allow();
  };
}

const reportViolation = makeViolationReporter();

/* Any unhandled error anywhere -> fail open. */
process.on('uncaughtException', () => allow());
process.on('unhandledRejection', () => allow());

/* Watchdog: never let the hook hang the turn. Allow well before any hook timeout. */
const watchdog = setTimeout(() => allow(), 3000);
watchdog.unref?.();

/* ── Emoji detection (plain-text-only enforcement) ───────────────────────────
 * Flags colour-presentation emoji (Emoji_Presentation), text-default pictographs
 * explicitly forced to emoji with VS16 (U+FE0F), and regional-indicator flags.
 * Deliberately does NOT flag plain typographic marks the project actually uses
 * (arrows ← → …, dashes, ™/©/® in text presentation). */
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u{1F1E6}-\u{1F1FF}]/u;

/* ── Failure-wording mirror of digest.js's leading fence (messaging only) ──── */
const DIGEST_FENCE = /^\s*```+[ \t]*orchard-digest[ \t]*\r?\n([\s\S]*?)\r?\n```+[ \t]*(?:\r?\n|$)/i;

/* ── dataDir() mirror (lightweight; avoids importing the TS server graph) ──── */
function dataDir() {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

function registryPath() {
  return path.join(dataDir(), 'registry.json');
}

/**
 * Is the structured digest disabled for the project rooted at `cwd`?
 * Best-effort: any read/parse problem -> treat as NOT disabled (app default is
 * enabled) and continue with the checks. Never throws.
 */
function digestDisabledForProject(cwd) {
  try {
    if (!cwd) return false;
    const target = path.resolve(cwd);
    const raw = fs.readFileSync(registryPath(), 'utf8');
    const reg = JSON.parse(raw);
    const projects = Array.isArray(reg?.projects) ? reg.projects : [];
    for (const p of projects) {
      if (!p || typeof p.hostPath !== 'string') continue;
      if (path.resolve(p.hostPath) === target) {
        return p?.settings?.responseDigest?.enabled === false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Concatenated text of every `text` block in one assistant event's content. */
function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

const isMainAssistant = (ev) =>
  ev && ev.type === 'assistant' && ev.isSidechain !== true && Array.isArray(ev?.message?.content);

/**
 * Full text of the LAST MAIN-thread assistant *logical message* (all its text,
 * in order), or ''.
 *
 * Load-bearing detail (root cause of the FEAT-085 live false block): Claude Code
 * persists ONE logical assistant turn — sharing a single `message.id` — as
 * MULTIPLE JSONL lines: a thinking-block line, then one or more text-block lines.
 * Grading only the LAST such line sees just the trailing prose and misses a
 * digest that leads an EARLIER line of the same message -> a false "missing
 * digest" block. So we concatenate the text of every JSONL line that shares the
 * final message's id, in file order, and grade the whole message. A leading
 * digest anywhere at the start of the logical message is therefore always seen.
 *
 * Without a stable id (older / id-less transcripts) we grade only the single
 * last line — unchanged from the original behaviour, and biased toward allow.
 */
function lastAssistantText(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');

  // Find the last MAIN-thread assistant JSONL line.
  let lastIdx = -1;
  let lastEv = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isMainAssistant(ev)) continue;
    lastIdx = i; lastEv = ev; break;
  }
  if (lastIdx === -1) return '';

  const id = lastEv?.message?.id;
  const parts = [blockText(lastEv.message.content)];

  // Merge the earlier JSONL lines of the SAME logical message (same id), so a
  // split thinking/text/text turn is graded as one message. Only when the id is
  // a non-empty string — otherwise we cannot prove two lines are the same turn.
  if (typeof id === 'string' && id !== '') {
    for (let i = lastIdx - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue; // tolerate blank lines inside/around the group
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // tolerate a corrupt neighbour
      if (!isMainAssistant(ev) || ev?.message?.id !== id) break; // group boundary
      parts.push(blockText(ev.message.content));
    }
    parts.reverse();
  }

  // May be '' for a tool-only / thinking-only final turn -> nothing to check -> allow.
  return parts.join('');
}

/** Read all of stdin as a string. Never rejects; empty on any trouble. */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    } catch {
      resolve('');
    }
  });
}

/* ── main ────────────────────────────────────────────────────────────────── */
async function main() {
  // BUG-118 — LAUNCHER GATE. Cheapest half first: no marker at all -> not ours,
  // nothing read, nothing said. (An onboarded project's settings.json makes
  // Claude Code run this hook for every session rooted there, ours or not.)
  if (!process.env[ORCHARD_SESSION_ENV]?.trim()) return allow();

  // Disable switch — cheapest possible inert path. (Kept as-is: any value
  // other than ''/'0'/'false' disables, matching the documented behaviour.)
  const off = process.env.ORCHARD_STOP_HOOK_DISABLED;
  if (off && off !== '0' && off.toLowerCase() !== 'false') return allow();

  const stdin = await readStdin();
  if (!stdin.trim()) return allow(); // garbage/empty payload -> fail open

  let payload;
  try { payload = JSON.parse(stdin); } catch { return allow(); }
  if (!payload || typeof payload !== 'object') return allow();

  // BUG-118 round 2 — the other half of the gate, and the one a child process
  // cannot fake: the marker must NAME this session. A nested hand-started
  // `claude` inherits the marker's value but has its own session id, so it
  // stops here with zero output. Ahead of every grading step, so a stranger's
  // turn costs nothing beyond reading its own payload.
  const attributed = attribution(payload);
  if (attributed.verdict !== 'ours') {
    // ROUND 4: not ours -> still silent toward the user, but no longer silent
    // toward US. See noteUnattributed for why the record is a log line and not
    // a systemMessage.
    noteUnattributed(attributed, payload);
    return allow();
  }

  // Loop safety: if a Stop hook already blocked this turn, never block again.
  if (payload.stop_hook_active === true) return allow();

  // Per-project opt-out (FEAT-083/084 parity).
  if (digestDisabledForProject(payload.cwd)) return allow();

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') return allow();
  if (!fs.existsSync(transcriptPath)) return allow(); // missing transcript -> fail open

  let text;
  try { text = lastAssistantText(transcriptPath); } catch { return allow(); }
  if (!text || !text.trim()) return allow(); // nothing to check -> fail open

  // Authoritative digest pass/fail: the SINGLE source of truth in digest.js.
  let parseDigest;
  try {
    ({ parseDigest } = await import('../../public/lib/digest.js'));
  } catch (err) {
    // Fail open, never wedge — but no longer in silence (round 4).
    noteCannotGrade('deps-digest-unloadable', err?.message, payload);
    return allow();
  }
  if (typeof parseDigest !== 'function') {
    // A digest.js that loaded but does not export what this hook needs: a stale
    // copy of the closure under a current hook. Silent until round 4.
    noteCannotGrade('deps-digest-incompatible', `parseDigest is ${typeof parseDigest}`, payload);
    return allow();
  }

  const formatReasons = [];
  const blockReasons = [];

  let digest;
  try {
    digest = parseDigest(text);
  } catch (err) {
    noteCannotGrade('deps-digest-threw', err?.message, payload);
    return allow();
  }
  if (!digest) {
    // Classify WHY for a specific corrective (messaging only; mirror of the fence).
    const m = DIGEST_FENCE.exec(text);
    if (!m) {
      formatReasons.push('Missing the leading ```orchard-digest block.');
    } else {
      let json = null;
      try { json = JSON.parse(m[1]); } catch { /* malformed */ }
      if (json === null) formatReasons.push('The orchard-digest block is present but its JSON is malformed.');
      else formatReasons.push('The orchard-digest block has no usable items (need at least one item with non-empty text and a recognised kind/importance).');
    }
  }

  if (EMOJI_RE.test(text)) {
    formatReasons.push('The reply contains emojis; use plain text only.');
  }

  /* FEAT-091 — layer 2: parse the prose blocks and RECORD metrics for EVERY
   * graded turn (not only violating ones — without the compliant turns there is
   * no denominator and "fallback is rising" cannot be answered).
   *
   * Measured, not policed: prose that lands outside every block still renders,
   * so it never produces a hard violation. What the record has to separate is the
   * two DIFFERENT signals it carries — a declared `orchard-uncategorized` block
   * (the vocabulary is missing a name; read its label) versus prose left loose
   * (the author did not categorise at all). Adding them together would hide both.
   *
   * Wrapped whole. Parsing or the disk must never change the verdict; the module
   * is imported lazily and dynamically so a target that lacks it (an older
   * onboarded copy) simply records nothing. */
  try {
    const { parseResponseBlocks } = await import('../../public/lib/response-blocks.js');
    const parsed = parseResponseBlocks(text);
    try {
      const { recordTurn } = await import('../lib/format-metrics.mjs');
      recordTurn(parsed, { session_id: payload.session_id, cwd: payload.cwd, dataDir: dataDir() });
    } catch { /* metrics are best-effort */ }
    // The ONE structural thing worth telling the author: an unterminated or
    // unknown `orchard-*` fence means content they meant to collapse is now
    // showing (or vice versa). Advisory, like everything else here.
    if (parsed.malformed.length) {
      blockReasons.push(
        `Response-block problem (content was still shown, nothing was lost): ${parsed.malformed.join(', ')}.`,
      );
    }
    // An UNLABELLED `orchard-uncategorized` is the one fallback shape that is
    // actually a defect. The block itself is legitimate — the design says content
    // that fits nothing goes there — but without the author's own words for what
    // it was, the count can never become a new category, which is the entire
    // reason the escape hatch exists. Advisory, never blocking.
    const unlabelled = (parsed.declaredUncategorized ?? []).filter((d) => !d.label).length;
    if (unlabelled) {
      blockReasons.push(
        `${unlabelled} orchard-uncategorized block(s) carried no label, so the metrics cannot say what kind of thing landed there.`,
      );
    }
  } catch (err) {
    // Layer 2 must never affect the turn — but a closure that cannot parse
    // blocks is a measurement silently going to zero, so it is recorded.
    noteCannotGrade('deps-blocks-unavailable', err?.message, payload);
  }

  // Readability check on the PROSE (digest/code/tables/urls excluded inside the
  // module). Additive: it follows the SAME advisory/enforce path as the format
  // checks. Biased hard toward allowing — short/mostly-code/quote replies are
  // reported tooShort and never trip. Any error here must not wedge the turn.
  let readabilityReasons = [];
  try {
    const ev = evaluateReadability(text);
    if (!ev.tooShort && ev.violations.length > 0) {
      readabilityReasons = ev.violations.map((v) => v.message);
    }
  } catch (err) {
    // Readability must never affect the turn — but a grader that throws is a
    // check that has stopped running, which is not the same as a clean reply.
    noteCannotGrade('deps-readability-threw', err?.message, payload);
  }

  if (formatReasons.length === 0 && readabilityReasons.length === 0 && blockReasons.length === 0) {
    return allow(); // compliant -> silence, no advisory noise
  }
  return reportViolation({ formatReasons, readabilityReasons, blockReasons }, payload);
}

main().catch(() => allow());
