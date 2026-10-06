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
 *   2. COMPLETION — does the transcript's last turn TERMINATE? This is decided
 *      ONLY from a COMPLETE, terminal record per the transcript schema, never a
 *      partial line or a non-terminal block. We parse only up to the last newline
 *      (an unterminated trailing line is MID-WRITE — a record in flight — never
 *      terminal). A terminal record is a workflow `result` record, or an
 *      assistant turn with NO tool_use block. Its confidence is DEFINITIVE when
 *      message.stop_reason ends the turn (end_turn / stop_sequence / max_tokens /
 *      refusal) and AMBIGUOUS when stop_reason is null — because on real data a
 *      null stop_reason is BOTH a finished answer (measured 258/3547 real child
 *      transcripts, across opus/sonnet/fable) AND a mid-turn narration block
 *      whose sibling tool_use is not yet written (Claude Code persists one record
 *      per content block). The two are byte-identical, so an ambiguous terminal
 *      is trusted only after the stall horizon confirms no continuation.
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

/**
 * Read the tail of a file for the terminal record + result, but ALIGNED to a
 * record boundary. `softCap` is the preferred window (`--tail-bytes`); the window
 * is GROWN past it only as far as needed to contain the final record whole.
 *
 * Why grow it: records are newline-delimited JSONL. The last COMPLETE record sits
 * between the file's last two newlines. If the final record is larger than the
 * window, the window begins inside it, the only "line" it holds is a truncated
 * fragment, and dropping that fragment (it is not valid JSON) leaves NOTHING — a
 * genuinely finished agent then reads STALLED (FEAT-111 round-1 defect 3). So we
 * require the window to hold >=2 newlines (enough to delimit one whole record at
 * the end) before trusting it, extending by doubling until it does or we have the
 * whole file. `fullFile` is true when the window reached the start of the file.
 */
function readTailAligned(file, size, softCap) {
  const fd = fs.openSync(file, 'r');
  try {
    let n = Math.min(softCap, size);
    for (;;) {
      const start = size - n;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, start);
      if (start === 0) {
        return { text: buf.toString('utf8'), bytesRead: n, partial: false, fullFile: true };
      }
      let nl = 0;
      for (let i = 0; i < n && nl < 2; i++) if (buf[i] === 0x0a) nl++;
      if (nl >= 2) {
        return { text: buf.toString('utf8'), bytesRead: n, partial: true, fullFile: false };
      }
      // The final record is bigger than the current window (only its trailing
      // newline is visible). Grow until we capture the record boundary before it.
      n = n >= size ? size : Math.min(size, n * 2);
    }
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

// stop_reason values that END a turn with certainty. In the real transcript
// schema the model's final content block carries one of these on `message`.
// `tool_use` is deliberately NOT here: it means the turn is awaiting a tool.
const DEFINITIVE_STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

/**
 * Decide, from the last COMPLETE record, whether the child's turn terminated, and
 * with what confidence. Returns
 *   { candidateTerminal, confidence, result, lastKind, lastStop, lastTs }
 * where confidence is:
 *   'definitive' — this record is unambiguously the end of the turn (a workflow
 *                  `result` record, or an assistant text/thinking record whose
 *                  `message.stop_reason` is a turn-ending reason);
 *   'ambiguous'  — an assistant record with NO tool_use block but
 *                  `stop_reason` null/absent. On real data this is BOTH a
 *                  genuinely finished answer (measured: 258/3547 real child
 *                  transcripts end on a text block with stop_reason null, across
 *                  opus/sonnet/fable) AND a mid-turn narration block whose sibling
 *                  tool_use has not been written yet (Claude Code persists one
 *                  record per content block). The two are byte-indistinguishable
 *                  in the transcript, so this record is trusted as terminal only
 *                  after the stall horizon (see main) confirms no continuation;
 *   null         — not a terminal shape (an assistant tool_use block, a
 *                  tool_result, or an injected user turn → mid-turn).
 */
function analyzeTail(records) {
  if (!records.length) {
    return { candidateTerminal: false, confidence: null, result: '', lastKind: 'none', lastStop: null, lastTs: null };
  }
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
      candidateTerminal: true,
      confidence: 'definitive',
      result: typeof last.result === 'string' ? last.result : JSON.stringify(last.result, null, 2),
      lastKind,
      lastStop: 'result',
      lastTs,
    };
  }
  // A standard subagent terminates with an assistant turn that made NO tool call.
  // An assistant message that DOES contain a tool_use block is mid-turn
  // (running/awaiting a tool); a trailing user/tool_result or injected user
  // message is likewise mid-turn.
  if (type === 'assistant') {
    const content = last?.message?.content;
    const hasToolUse = Array.isArray(content) && content.some((b) => b && b.type === 'tool_use');
    if (!hasToolUse) {
      const confidence = DEFINITIVE_STOPS.has(stop) ? 'definitive' : 'ambiguous';
      return { candidateTerminal: true, confidence, result: assistantText(last), lastKind, lastStop: stop, lastTs };
    }
  }
  return { candidateTerminal: false, confidence: null, result: '', lastKind, lastStop: stop, lastTs };
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
    tail = readTailAligned(file, size1, opt.tailBytes);
  } catch (e) {
    return emit(opt, { status: 'UNREADABLE', exit: 4, agentId: opt.id, transcript: file, reason: String(e && e.message) });
  }
  const startTs = firstText(parseLines(head.text, false));
  const tailRecords = parseLines(tail.text, tail.partial);
  const a = analyzeTail(tailRecords);

  // Defect 1 (FEAT-111 round-1): a transcript whose last line has no terminating
  // newline is MID-WRITE — a record is being appended right now, or the writer
  // died partway through one. Either way the last COMPLETE record is NOT the end
  // of the turn: more was coming. `parseLines` silently drops the unterminated
  // fragment, so without this guard the record BEFORE it (often a mid-turn
  // narration block) is mistaken for the final answer. Only content up to the
  // last newline is a settled record; anything after it is pending, never terminal.
  const lastNL = tail.text.lastIndexOf('\n');
  const incompleteTail = tail.text.slice(lastNL + 1).trim().length > 0;

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
    terminalConfidence: a.confidence,
    incompleteTail,
    bytes,
  };

  // ---- Classify by combining the two signals ----
  // The transcript is written concurrently by the harness, so a terminal-looking
  // tail is only trustworthy once the file is QUIESCENT. A snapshot of an
  // actively-written file may momentarily end on a complete-but-not-final
  // record; declaring FINISHED off it would be a race. So growth/recency is
  // checked BEFORE completion. `settleSecs` = the file must be untouched at
  // least this long (and not have grown across our sampling window) before a
  // DEFINITIVE terminal read is believed.
  const settleSecs = Math.max(3, opt.waitMs / 1000);
  const runningGuidance =
    'ALIVE — do not re-run its work. Waiting is correct: measured 2026-08-27, a lane that ' +
    're-ran a live child instead of waiting cost 51.6 duplicated minutes and finished only ' +
    '7.6 min sooner. Re-harvest after a suitable interval.';

  const finishEmit = () => {
    if (!a.result || !a.result.trim()) {
      return emit(opt, {
        status: 'FINISHED_EMPTY',
        exit: 12,
        ...common,
        reason: 'child terminated but produced NO final text — this is a real anomaly, not an empty match. Read the transcript by hand.',
      });
    }
    return emit(opt, { status: 'FINISHED', exit: 0, ...common, result: a.result });
  };

  // 1. Actively growing across the window -> unambiguously alive.
  if (growing) {
    return emit(opt, { status: 'RUNNING', exit: 10, ...common, guidance: runningGuidance });
  }

  // 2. A record is mid-write (unterminated last line). The last COMPLETE record
  //    is NOT the end of the turn — more was being written. Never FINISHED. If
  //    fresh, the writer is active (wait); if silent past the horizon, it died
  //    mid-record (loud STALLED).
  if (incompleteTail) {
    if (idleSec < opt.idleSecs) {
      return emit(opt, { status: 'RUNNING', exit: 10, ...common, guidance: runningGuidance });
    }
    return emit(opt, {
      status: 'STALLED',
      exit: 11,
      ...common,
      reason:
        `transcript ends mid-record (a line without its terminating newline) and no write for ${idleSec.toFixed(0)}s. ` +
        'The writer died partway through a record; the last complete record is NOT a final answer. Verify the process by hand before assuming done or dead.',
    });
  }

  // 3. Quiescent AND the last record is a DEFINITIVE terminal (a workflow result,
  //    or an assistant turn whose stop_reason ends the turn) -> genuinely FINISHED.
  if (a.candidateTerminal && a.confidence === 'definitive' && idleSec >= settleSecs) {
    return finishEmit();
  }

  // 4. Quiescent AND the last record is an AMBIGUOUS terminal (assistant, no
  //    tool_use, stop_reason null — a finished answer and a not-yet-continued
  //    narration block are byte-identical here). Trust it as final ONLY past the
  //    stall horizon: if the turn were still going, a continuation would have
  //    landed within that window. Before the horizon it reads RUNNING (wait),
  //    which is the safe bias — never a re-run.
  if (a.candidateTerminal && a.confidence === 'ambiguous' && idleSec >= opt.idleSecs) {
    return finishEmit();
  }

  // 5. Recently touched (within the stall horizon) but not a trusted terminal
  //    read: either mid-turn, or terminal-looking but too freshly written to
  //    trust. Alive -> wait and re-harvest.
  if (idleSec < opt.idleSecs) {
    return emit(opt, { status: 'RUNNING', exit: 10, ...common, guidance: runningGuidance });
  }

  // 6. Silent past the stall horizon with no trusted terminal result.
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
  if (r.lastRecord) {
    const conf = r.terminalConfidence ? ` (terminal: ${r.terminalConfidence})` : '';
    const inc = r.incompleteTail ? '  [last line MID-WRITE: unterminated record]' : '';
    L.push(`last record: ${r.lastRecord}${conf}${inc}`);
  }
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
