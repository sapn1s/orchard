#!/usr/bin/env node
/**
 * harvest-agent.mjs — FEAT-111: let a lane harvest a background child's result
 * from GROUND TRUTH, without reading the child's whole transcript.
 *
 * Why this exists (measured, not theoretical). A fixer dispatched a background
 * verifier, its own turn ended, and the harness emitted `status=completed`
 * WHILE the child was still live. Told its verifier was "probably dead," the
 * fixer re-ran the entire ~1h suite; the child then finished with an identical
 * verdict 7.6 minutes later. Cost: 51.6 duplicated lane-minutes, two container
 * fleets against one tree. The defect was not the fixer's judgement — a lane
 * had NO sanctioned way to tell a live child from a dead one, or to read a
 * finished child's answer without ingesting its entire transcript (which would
 * blow the parent's context). So "re-run it myself" looked like the only branch.
 *
 * This gives the missing branch. Given a child agent id it reports, from two
 * INDEPENDENT ground-truth signals (never a notification):
 *
 *   1. ACTIVITY  — is the transcript file still being appended to? (two size
 *      samples across a short window, plus mtime recency). This observes the
 *      child process's effect on disk directly.
 *   2. COMPLETION — does the transcript's last turn TERMINATE? (an assistant
 *      record with stop_reason end_turn / stop_sequence, or a workflow `result`
 *      record). This is what the model actually emitted, orthogonal to (1).
 *
 * Two signals on purpose: a single ad-hoc check (a `ps` snapshot; a harness
 * notification) has produced a confidently wrong answer on this project before.
 *
 * It NEVER reads the whole transcript: the final report is extracted from a
 * bounded tail window, and it reports bytes-read vs file-size so a caller can
 * see the bound held. It fails LOUD — an absent, unreadable, or empty-result
 * child returns a non-zero status and a spoken reason, never a silent empty
 * "success" that reads as "nothing found".
 *
 * Storage model (Claude Code / SDK): a subagent's transcript lives at
 *   <config-dir>/projects/<project>/<session>/subagents/agent-<id>.jsonl
 * (workflow fold agents: .../subagents/workflows/<wf>/agent-<id>.jsonl). All
 * subagents of a session are stored FLAT there regardless of nesting depth, so
 * the agent id alone locates the file — the caller need not know the session.
 *
 * Usage:
 *   node scripts/harvest-agent.mjs <agent-id> [options]
 *     --wait-ms <n>     activity sampling window (default 1500)
 *     --tail-bytes <n>  max bytes read from the tail for the result (default 1048576)
 *     --idle-secs <n>   silence beyond which a non-terminal child is STALLED (default 240)
 *     --config-dir <p>  Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
 *     --json            emit a machine-readable JSON object instead of prose
 *
 * Exit codes (so a caller can branch in bash):
 *   0   FINISHED       — a terminal result was extracted (printed)
 *   10  RUNNING        — alive; the caller should WAIT, not re-run its work
 *   11  STALLED        — non-terminal and silent past --idle-secs; verify the
 *                        process by hand before assuming done OR dead
 *   12  FINISHED_EMPTY — terminated but produced no final text (loud, not "found nothing")
 *   3   GONE           — no transcript for that id
 *   2   usage error
 *   4   unreadable transcript (permissions / IO)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function usage(msg) {
  if (msg) process.stderr.write(`harvest-agent: ${msg}\n`);
  process.stderr.write(
    'usage: node scripts/harvest-agent.mjs <agent-id> ' +
      '[--wait-ms N] [--tail-bytes N] [--idle-secs N] [--config-dir PATH] [--json]\n'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opt = {
    id: null,
    waitMs: 1500,
    tailBytes: 1024 * 1024,
    idleSecs: 240,
    configDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (a === '--wait-ms') opt.waitMs = int(argv[++i], '--wait-ms');
    else if (a === '--tail-bytes') opt.tailBytes = int(argv[++i], '--tail-bytes');
    else if (a === '--idle-secs') opt.idleSecs = int(argv[++i], '--idle-secs');
    else if (a === '--config-dir') opt.configDir = argv[++i];
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else if (opt.id == null) opt.id = a;
    else usage(`unexpected extra argument ${a}`);
  }
  if (!opt.id) usage('missing <agent-id>');
  // Accept "agent-<id>", "<id>", or a full transcript path.
  opt.id = String(opt.id).replace(/\.jsonl$/, '').replace(/^.*\//, '').replace(/^agent-/, '');
  if (!/^[0-9a-f]+$/i.test(opt.id)) usage(`id "${opt.id}" is not a hex agent id`);
  return opt;
}

function int(v, flag) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) usage(`${flag} expects a non-negative number, got ${v}`);
  return n;
}

/** Locate agent-<id>.jsonl anywhere under <config>/projects/*​/<session>/subagents/. */
function locateTranscript(configDir, id) {
  const projectsRoot = path.join(configDir, 'projects');
  const target = `agent-${id}.jsonl`;
  let projects;
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(projectsRoot, proj.name);
    let sessions;
    try {
      sessions = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sess of sessions) {
      if (!sess.isDirectory()) continue;
      const subagents = path.join(projDir, sess.name, 'subagents');
      const direct = path.join(subagents, target);
      if (fs.existsSync(direct)) return direct;
      // workflow fold agents nest one more level under subagents/workflows/<wf>/
      const wfRoot = path.join(subagents, 'workflows');
      let wfs;
      try {
        wfs = fs.readdirSync(wfRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const wf of wfs) {
        if (!wf.isDirectory()) continue;
        const cand = path.join(wfRoot, wf.name, target);
        if (fs.existsSync(cand)) return cand;
      }
    }
  }
  return null;
}

/** Read the first `bytes` of a file (for the earliest timestamp). */
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return { text: buf.toString('utf8'), bytesRead: n };
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the last `bytes` of a file (for the terminal record + result). */
function readTail(file, size, bytes) {
  const n = Math.min(bytes, size);
  const start = size - n;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, start);
    return { text: buf.toString('utf8'), bytesRead: n, partial: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse complete JSONL lines from `text`; if `dropFirst`, ignore a possibly
 *  truncated leading line (the tail window may start mid-line). */
function parseLines(text, dropFirst) {
  const raw = text.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (!line) continue;
    if (dropFirst && i === 0) continue; // window began mid-record
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a partial / non-JSON line */
    }
  }
  return out;
}

function firstText(records) {
  for (const r of records) {
    const ts = r.timestamp;
    if (ts) return ts;
  }
  return null;
}

/** Extract concatenated text from an assistant message content array. */
function assistantText(rec) {
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Decide completion from the tail records. Returns
 * { finished, result, lastKind, lastStop, lastTs }.
 */
function analyzeTail(records) {
  if (!records.length) return { finished: false, result: '', lastKind: 'none', lastStop: null, lastTs: null };
  const last = records[records.length - 1];
  const lastTs = last.timestamp || null;
  const type = last.type;
  const role = last?.message?.role;
  const stop = last?.message?.stop_reason ?? null;
  const contentKinds = Array.isArray(last?.message?.content)
    ? last.message.content.map((b) => b?.type).join('+')
    : role || type;
  const lastKind = `${type}:${contentKinds}`;

  // Workflow fold agents terminate with an explicit result record.
  if (type === 'result' && last.result !== undefined) {
    return {
      finished: true,
      result: typeof last.result === 'string' ? last.result : JSON.stringify(last.result, null, 2),
      lastKind,
      lastStop: 'result',
      lastTs,
    };
  }
  // A standard subagent terminates with an assistant turn that made NO tool
  // call — the model ended its turn with a final answer. Detect this by the
  // absence of a tool_use block, NOT by stop_reason: measured on real data,
  // claude-opus-5 children persist stop_reason:null on a perfectly finished
  // text answer, so an end_turn-only check false-STALLs them. An assistant
  // message that DOES contain a tool_use block is mid-turn (running/awaiting a
  // tool), regardless of stop_reason. A trailing user/tool_result or injected
  // user message is likewise mid-turn.
  if (type === 'assistant') {
    const content = last?.message?.content;
    const hasToolUse = Array.isArray(content) && content.some((b) => b && b.type === 'tool_use');
    if (!hasToolUse) {
      return { finished: true, result: assistantText(last), lastKind, lastStop: stop, lastTs };
    }
  }
  return { finished: false, result: '', lastKind, lastStop: stop, lastTs };
}

function sleep(ms) {
  // Bounded, synchronous nap for the activity-sampling window.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const file = locateTranscript(opt.configDir, opt.id);

  if (!file) {
    return emit(opt, {
      status: 'GONE',
      exit: 3,
      agentId: opt.id,
      reason: `no transcript found for agent ${opt.id} under ${path.join(opt.configDir, 'projects')} — the id is wrong, the child never started, or its session was pruned. This is NOT an empty result.`,
    });
  }

  let size0, mtime0;
  try {
    const st0 = fs.statSync(file);
    size0 = st0.size;
    mtime0 = st0.mtimeMs;
  } catch (e) {
    return emit(opt, { status: 'UNREADABLE', exit: 4, agentId: opt.id, transcript: file, reason: String(e && e.message) });
  }

  // ---- Signal 1: ACTIVITY (two size samples + mtime recency) ----
  sleep(opt.waitMs);
  let size1, mtime1;
  try {
    const st1 = fs.statSync(file);
    size1 = st1.size;
    mtime1 = st1.mtimeMs;
  } catch (e) {
    return emit(opt, { status: 'UNREADABLE', exit: 4, agentId: opt.id, transcript: file, reason: String(e && e.message) });
  }
  const growing = size1 > size0;
  const now = Date.now();
  const idleSec = Math.max(0, (now - Math.max(mtime0, mtime1)) / 1000);

  // ---- Signal 2: COMPLETION (bounded head + tail reads) ----
  let head, tail;
  try {
    head = readHead(file, 64 * 1024);
    tail = readTail(file, size1, opt.tailBytes);
  } catch (e) {
    return emit(opt, { status: 'UNREADABLE', exit: 4, agentId: opt.id, transcript: file, reason: String(e && e.message) });
  }
  const startTs = firstText(parseLines(head.text, false));
  const tailRecords = parseLines(tail.text, tail.partial);
  const a = analyzeTail(tailRecords);

  const lastTsMs = a.lastTs ? Date.parse(a.lastTs) : null;
  const startTsMs = startTs ? Date.parse(startTs) : null;
  const elapsedSec = startTsMs && lastTsMs ? Math.max(0, (lastTsMs - startTsMs) / 1000) : null;
  const sinceLastRecordSec = lastTsMs ? Math.max(0, (now - lastTsMs) / 1000) : null;

  // Head and tail windows overlap on a small file; count UNIQUE bytes touched so
  // the bound is reported honestly (never >100%). The bound only bites when the
  // file is larger than head+tail — then fullyCovered is false and we prove we
  // read a fraction, not the whole transcript.
  const uniqueRead = Math.min(size1, head.bytesRead + tail.bytesRead);
  const bytes = {
    fileSize: size1,
    headRead: head.bytesRead,
    tailRead: tail.bytesRead,
    uniqueRead,
    fractionRead: size1 > 0 ? +(uniqueRead / size1).toFixed(4) : 1,
    fullyCovered: uniqueRead >= size1,
  };
  const common = {
    agentId: opt.id,
    transcript: file,
    growing,
    idleSec: +idleSec.toFixed(1),
    elapsedSec: elapsedSec == null ? null : +elapsedSec.toFixed(1),
    sinceLastRecordSec: sinceLastRecordSec == null ? null : +sinceLastRecordSec.toFixed(1),
    lastRecord: a.lastKind,
    lastStop: a.lastStop,
    bytes,
  };

  // ---- Classify by combining the two signals ----
  // The transcript is written concurrently by the harness, so a terminal-looking
  // tail is only trustworthy once the file is QUIESCENT. A snapshot of an
  // actively-written file may momentarily end on a complete-but-not-final
  // record; declaring FINISHED off it would be a race. So growth/recency is
  // checked BEFORE completion. `settleSecs` = the file must be untouched at
  // least this long (and not have grown across our sampling window) before a
  // terminal read is believed.
  const settleSecs = Math.max(3, opt.waitMs / 1000);
  const runningGuidance =
    'ALIVE — do not re-run its work. Waiting is correct: measured 2026-08-27, a lane that ' +
    're-ran a live child instead of waiting cost 51.6 duplicated minutes and finished only ' +
    '7.6 min sooner. Re-harvest after a suitable interval.';

  // 1. Actively growing across the window -> unambiguously alive.
  if (growing) {
    return emit(opt, { status: 'RUNNING', exit: 10, ...common, guidance: runningGuidance });
  }

  // 2. Quiescent AND a terminal turn is recorded -> genuinely FINISHED.
  if (a.finished && idleSec >= settleSecs) {
    if (!a.result || !a.result.trim()) {
      return emit(opt, {
        status: 'FINISHED_EMPTY',
        exit: 12,
        ...common,
        reason: 'child terminated but produced NO final text — this is a real anomaly, not an empty match. Read the transcript by hand.',
      });
    }
    return emit(opt, { status: 'FINISHED', exit: 0, ...common, result: a.result });
  }

  // 3. Recently touched (within the stall horizon) but not a trusted terminal
  //    read: either mid-turn, or terminal-looking but too freshly written to
  //    trust. Alive -> wait and re-harvest.
  if (idleSec < opt.idleSecs) {
    return emit(opt, { status: 'RUNNING', exit: 10, ...common, guidance: runningGuidance });
  }

  // 4. Silent past the stall horizon with no trusted terminal result.
  return emit(opt, {
    status: 'STALLED',
    exit: 11,
    ...common,
    reason:
      `no trusted terminal result and no write for ${idleSec.toFixed(0)}s (last record ${a.lastKind}). ` +
      'The child may be blocked mid-tool or may have died. Verify the process by hand (ps / your harness) before assuming EITHER done or dead — do NOT treat this as a completed empty result.',
  });
}

function emit(opt, r) {
  if (opt.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.exit);
  }
  const L = [];
  L.push(`STATUS: ${r.status}   (agent ${r.agentId})`);
  if (r.transcript) L.push(`transcript: ${r.transcript}`);
  if (r.bytes) {
    const b = r.bytes;
    const note = b.fullyCovered
      ? 'windows cover the whole file (small transcript)'
      : 'BOUNDED — most of the transcript was never read';
    L.push(
      `read ${b.uniqueRead} of ${b.fileSize} bytes (${(b.fractionRead * 100).toFixed(1)}% — ` +
        `head ${b.headRead} + tail ${b.tailRead}); ${note}`
    );
  }
  if (r.elapsedSec != null) L.push(`elapsed: ${r.elapsedSec}s   last activity: ${r.sinceLastRecordSec}s ago   growing: ${r.growing}   idle(mtime): ${r.idleSec}s`);
  if (r.lastRecord) L.push(`last record: ${r.lastRecord}`);
  if (r.guidance) L.push(`>> ${r.guidance}`);
  if (r.reason) L.push(`reason: ${r.reason}`);
  if (r.result !== undefined) {
    L.push('---- final report (bounded) ----');
    L.push(r.result);
    L.push('---- end final report ----');
  }
  const stream = r.exit === 0 ? process.stdout : process.stderr;
  stream.write(L.join('\n') + '\n');
  process.exit(r.exit);
}

main();
