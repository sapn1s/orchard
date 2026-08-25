#!/usr/bin/env node
/**
 * cost-collect.mjs — FEAT-086. Where the wall clock and the tokens actually go,
 * per ticket, per lane, per phase — derived automatically from records the
 * harness already writes.
 *
 *   node scripts/cost-collect.mjs                 # collect + print the report
 *   node scripts/cost-collect.mjs --since 2d      # only lanes active in a window
 *   node scripts/cost-collect.mjs --report-only   # read the ledger, write nothing
 *   node scripts/cost-collect.mjs --json          # machine-readable roll-up
 *   node scripts/cost-collect.mjs --ticket=BUG-123   # one ticket, lane by lane
 *
 * ---------------------------------------------------------------------------
 * DECLARED AT DISPATCH VS INFERRED BY A READER (FEAT-100)
 * ---------------------------------------------------------------------------
 * Everything else in this file is DERIVED — which is why it works retroactively
 * and costs the pipeline nothing. Four facts cannot be derived honestly, because
 * they are not properties of what an agent did: which TICKET a lane works, which
 * lifecycle PHASE (finding / fixing / verifying) it is in, which ROUND of that
 * ticket this attempt is, and the dispatch CLASS §I already requires. Their
 * owner is the DISPATCHER and it knows all four before the lane starts.
 *
 * So a dispatch may put one line at the top of the charter:
 *
 *     Dispatch: ticket=BUG-123 phase=fixing round=2 class=fix
 *
 * The grammar lives once, in `cost-model.mjs`, and is shared with the writer
 * (`scripts/dispatch.mjs --ticket/--phase/--round/--class`). This adds no store
 * and no runtime work: the charter is already written and already lands in the
 * transcript this file already reads.
 *
 * ABSENT IS RECORDED AS ABSENT. A lane that declared nothing — every lane that
 * ran before this existed, and any dispatcher that forgets — reports `undeclared`
 * and is counted as such in the coverage line. The tool-derived `phases` map is
 * kept and is NOT used to fill the lifecycle phase in: it measures a different
 * axis, and substituting one for the other is the exact fabrication this closes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AUTOMATIC WITHOUT ANYONE REMEMBERING ANYTHING
 * ---------------------------------------------------------------------------
 * The charter's bar was: "if it depends on an orchestrator remembering to record
 * something, it will not survive a week." So nothing here asks anyone to record
 * anything. The capture point is the agent CLI's own transcript writer, which
 * already logs every turn's model, token usage, tool calls and timestamps as a
 * side effect of the work happening. This script is pure derivation over those
 * files, which means:
 *   - it costs the measured pipeline ZERO tokens and ZERO added latency;
 *   - it works retroactively, over work that ran before it existed;
 *   - a lane that forgets to "log" is impossible, because lanes do not log.
 *
 * The one thing that is NOT automatic is RETENTION: the agent CLI prunes its own
 * transcripts (30 days by default). So this writes an append-only ledger of
 * roll-ups to the station data dir — small, durable, and independent of the
 * transcripts it was derived from. Run it at least monthly and no history is
 * lost. `--check-retention` reports how close the oldest transcript is to that
 * edge.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LANE IS
 * ---------------------------------------------------------------------------
 * One unit of dispatched work with its own context:
 *   - `subagent`     one in-process Task agent (`subagents/agent-<id>.jsonl`)
 *   - `orchestrator` the main session's own turns (sidechain lines excluded)
 *   - `process`      a separately spawned CLI run (its own session transcript)
 * A subagent's cost is counted in ITS record only; the dispatching lane charges
 * the span to `blocked_on_lane`, never to work. Otherwise the fleet's total
 * exceeds its own wall clock.
 *
 * Read-only by construction: this process opens transcript files `r` and writes
 * exactly one file, the ledger, by append. It never touches the repo, the board,
 * a session, or a running server.
 *
 * ---------------------------------------------------------------------------
 * THE KNOWN FLOOR, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * A transcript-derived figure is a LOWER BOUND. Verified against the CLI's own
 * `total_cost_usd` on a real one-turn dispatch: the CLI reported $0.0181414;
 * every token the transcript records prices to $0.017185 by this file's model —
 * 5.3% low. The missing 901 input / 11 output tokens are an auxiliary
 * title-generation call the CLI makes and does NOT write to the session file
 * (checked line by line: the `ai-title` entry carries the title string and no
 * usage object). The bias is therefore PER SESSION, not per token: roughly one
 * small extra request per session regardless of how long the session runs. On a
 * one-turn probe that is 5%; on a multi-million-token lane it is noise. Stated
 * here so nobody re-derives it, and so nobody reports these figures as exact.
 *
 * What IS exact, checked against that same oracle to seven decimal places, is
 * the price model applied to a given set of tokens (`cost-model.mjs` costOf).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  foldUsage,
  priceBuckets,
  totalTokens,
  providerOf,
  attributePhases,
  ticketsIn,
  dispatchClassIn,
  verdictOf,
  assignRounds,
  parseDispatchDeclaration,
  stripDispatchDeclarations,
  resolveLaneAttribution,
  DECLARED_PHASES,
  DISPATCH_CLASSES,
  PHASES,
} from './lib/cost-model.mjs';

/* ----------------------------------------------------------------- locations */

/** Where the agent CLI keeps its transcripts. Overridable for tests/fixtures. */
function transcriptRoot() {
  return process.env.CLAUDE_TRANSCRIPT_ROOT || path.join(os.homedir(), '.claude', 'projects');
}

/** Where the ledger lives. Same resolution the app uses for its own data dir. */
function dataDir() {
  if (process.env.CLAUDE_STATION_DATA) return process.env.CLAUDE_STATION_DATA;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'claude-station');
  return path.join(os.homedir(), '.local', 'share', 'claude-station');
}

function ledgerFile() {
  return path.join(dataDir(), 'cost-ledger.jsonl');
}

/**
 * The CLI encodes a project's absolute path into a directory name by replacing
 * every non-alphanumeric run with `-`. Decoding is lossy, so instead of
 * decoding we ENCODE the project root we want and match on that prefix — which
 * also keeps any real home path out of this file's source.
 */
function encodeProjectDir(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/* --------------------------------------------------------------------- args */

function parseArgs(argv) {
  const o = {
    project: process.cwd(),
    all: false,
    since: null,
    reportOnly: false,
    json: false,
    checkRetention: false,
    top: 25,
    ticket: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = path.resolve(argv[++i]);
    else if (a === '--all-projects') o.all = true;
    else if (a === '--since') o.since = parseSince(argv[++i]);
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--json') o.json = true;
    else if (a === '--check-retention') o.checkRetention = true;
    else if (a === '--top') o.top = Number(argv[++i]) || 25;
    else if (a === '--ticket') o.ticket = String(argv[++i] ?? '').toUpperCase();
    else if (a.startsWith('--ticket=')) o.ticket = a.slice(9).toUpperCase();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function parseSince(s) {
  const m = /^(\d+)([hdw])$/.exec(String(s ?? ''));
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const mult = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
}

/* ------------------------------------------------------------ transcript I/O */

/** 128 MiB per file. Beyond that we read a prefix and SAY the record is partial. */
const MAX_BYTES = 128 * 1024 * 1024;

/**
 * Stream one JSONL transcript into entries.
 *
 * Tolerant by design: this reads files another process is actively WRITING, so
 * a truncated final line is normal, not corruption. Malformed lines are counted
 * and reported (`malformed`), never thrown on — a collector that dies on a
 * half-flushed line would fail exactly when a lane is busiest.
 */
async function readEntries(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { entries: [], malformed: 0, truncated: false, bytes: 0 };
  }
  const cap = Math.min(size, MAX_BYTES);
  const stream = fs.createReadStream(file, { start: 0, end: cap - 1, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const entries = [];
  let malformed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { entries, malformed, truncated: cap < size, bytes: cap };
}

function readMeta(dir, agentId) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- lane build */

/** The charter is the lane's first user message — the prompt it was given. */
function charterOf(entries) {
  for (const e of entries) {
    if (e?.type !== 'user') continue;
    const c = e.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n');
      if (text) return text;
    }
  }
  return '';
}

/** The last assistant text — where a verdict, if there is one, is stated. */
function finalTextOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'assistant') continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    const text = c
      .filter((b) => b?.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

function toolHistogram(entries) {
  const h = {};
  for (const e of entries) {
    if (e?.type !== 'assistant') continue;
    for (const b of e.message?.content ?? []) {
      if (b?.type === 'tool_use') h[String(b.name)] = (h[String(b.name)] ?? 0) + 1;
    }
  }
  return h;
}

/**
 * Turn one transcript's entries into a lane record.
 *
 * Every derived field is accompanied by the evidence that produced it
 * (`duplicate_usage_rows_dropped`, `accounted_ms` vs `wall_ms`, `unpriced`) so
 * the record can be audited without re-reading the transcript.
 */
function buildLane({ kind, laneId, sessionId, projectDir, entries, meta, source, malformed, truncated }) {
  const charter = charterOf(entries);
  const folded = foldUsage(entries);
  const priced = priceBuckets(folded.buckets);
  const tokens = totalTokens(folded.buckets);
  const phases = attributePhases(entries);
  const models = [...new Set(folded.buckets.map((b) => b.model))];
  const providers = [...new Set(models.map(providerOf))];

  return {
    // schema 2 (FEAT-100) adds `declared` plus the resolved/provenance fields.
    // A schema-1 record in the ledger stays readable and simply has no
    // declaration — which is the honest state of every lane that ran before the
    // dispatch boundary was asked for these four facts.
    schema: 2,
    lane_id: laneId,
    kind,
    session_id: sessionId,
    project_dir: projectDir,
    source_bytes: source.bytes,
    collected_at: new Date().toISOString(),

    agent_type: typeof meta?.agentType === 'string' ? meta.agentType : null,
    description: typeof meta?.description === 'string' ? meta.description : null,
    parent_agent_id: typeof meta?.parentAgentId === 'string' ? meta.parentAgentId : null,
    spawn_depth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null,

    // What the dispatcher DECLARED (FEAT-100) and what a reader can INFER.
    // Both are kept: the inferred fields remain the only answer available for
    // the lanes that ran before this existed, and keeping them side by side is
    // what lets a later pass measure how often the inference was wrong.
    declared: parseDispatchDeclaration(charter),
    // The inferred fields read the charter with the declaration lines REMOVED,
    // so `ticket_inferred` answers "what would a pre-FEAT-100 reader have
    // concluded" rather than echoing the declaration back as its own control.
    tickets: ticketsIn(stripDispatchDeclarations(charter)),
    dispatch_class: dispatchClassIn(stripDispatchDeclarations(charter)),
    verdict: verdictOf(finalTextOf(entries)),

    providers,
    models,
    usage: folded.buckets.map(({ first_at, last_at, ...b }) => b),
    tokens,
    cost_usd: priced.cost_usd,
    cost_priced_usd: priced.cost_priced_usd,
    unpriced: priced.unpriced,

    started_at: phases.started_at,
    ended_at: phases.ended_at,
    wall_ms: phases.wall_ms,
    accounted_ms: phases.accounted_ms,
    idle_gap_ms: phases.idle_gap_ms,
    phases: Object.fromEntries(PHASES.map((p) => [p, phases[p]])),

    turns: tokens.requests,
    tools: toolHistogram(entries),

    duplicate_usage_rows_dropped: folded.duplicatesDropped,
    malformed_lines: malformed,
    source_truncated: truncated,
  };
}

/* ------------------------------------------------------------------- collect */

async function collect(opts) {
  const root = transcriptRoot();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { lanes: [], root, dirs: [], error: `transcript root not readable: ${root}` };
  }
  if (!opts.all) {
    const want = encodeProjectDir(opts.project);
    // Clean rooms and worktrees live in sibling dirs whose encoded name starts
    // with the project's own basename — those are the SAME work and belong in
    // the same ledger, so match on the basename token rather than the full path.
    const token = encodeProjectDir(path.basename(opts.project));
    dirs = dirs.filter((d) => d === want || d.includes(token));
  }

  const lanes = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    let files;
    try {
      files = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        const file = path.join(abs, f.name);
        if (opts.since && fs.statSync(file).mtimeMs < opts.since) continue;
        const sessionId = f.name.replace(/\.jsonl$/, '');
        const src = await readEntries(file);
        const own = src.entries.filter((e) => e?.isSidechain !== true);
        if (!own.some((e) => e?.type === 'assistant')) continue;
        const hasSubagents = fs.existsSync(path.join(abs, sessionId, 'subagents'));
        lanes.push(
          buildLane({
            kind: hasSubagents ? 'orchestrator' : 'process',
            laneId: sessionId,
            sessionId,
            projectDir: dir,
            entries: own,
            meta: {},
            source: src,
            malformed: src.malformed,
            truncated: src.truncated,
          }),
        );
      } else if (f.isDirectory()) {
        const subDir = path.join(abs, f.name, 'subagents');
        if (!fs.existsSync(subDir)) continue;
        for (const name of fs.readdirSync(subDir)) {
          const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
          if (!m) continue;
          const file = path.join(subDir, name);
          if (opts.since && fs.statSync(file).mtimeMs < opts.since) continue;
          const src = await readEntries(file);
          if (!src.entries.some((e) => e?.type === 'assistant')) continue;
          lanes.push(
            buildLane({
              kind: 'subagent',
              laneId: m[1],
              sessionId: f.name,
              projectDir: dir,
              entries: src.entries,
              meta: readMeta(subDir, m[1]),
              source: src,
              malformed: src.malformed,
              truncated: src.truncated,
            }),
          );
        }
      }
    }
  }

  const rounds = assignRounds(lanes);
  for (const l of lanes) Object.assign(l, resolveLaneAttribution(l, rounds.get(l.lane_id)));
  lanes.sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
  return { lanes, root, dirs };
}

/* -------------------------------------------------------------------- ledger */

/**
 * Append lanes to the ledger. APPEND-ONLY: a re-run of an unchanged lane writes
 * nothing, and a lane that GREW writes a new, later record. Readers take the
 * last record per `lane_id`, so history is never rewritten and a bad write is
 * always recoverable by truncating the tail.
 */
function appendLedger(lanes) {
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seen = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        seen.set(r.lane_id, r);
      } catch {
        /* a torn tail line is not a reason to lose the rest */
      }
    }
  }
  const fresh = lanes.filter((l) => {
    const prev = seen.get(l.lane_id);
    return !prev || prev.source_bytes !== l.source_bytes || prev.ended_at !== l.ended_at;
  });
  if (fresh.length) fs.appendFileSync(file, fresh.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, appended: fresh.length, total: seen.size + fresh.length };
}

function readLedger() {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return [];
  const byLane = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      byLane.set(r.lane_id, r); // last record wins
    } catch {
      /* torn tail */
    }
  }
  return [...byLane.values()];
}

/* -------------------------------------------------------------------- report */

const hrs = (ms) => (ms / 3600e3).toFixed(2);
const usd = (n) => (n == null ? '   unknown' : `$${n.toFixed(2).padStart(8)}`);

function rollUp(lanes) {
  const sum = (sel) => lanes.reduce((a, l) => a + (sel(l) || 0), 0);
  const anyUnpriced = lanes.some((l) => l.cost_usd == null);
  const phases = Object.fromEntries(PHASES.map((p) => [p, sum((l) => l.phases?.[p])]));
  /**
   * The split the user actually asked for: per ticket, per LIFECYCLE phase.
   *
   * `undeclared` is a first-class bucket, not a rounding error. Every lane that
   * ran before FEAT-100 lands in it, and so does any lane whose dispatcher did
   * not say. Printing that column is the point — it is the difference between
   * "verifying BUG-116 took 0.4 h" and "we do not know what verifying BUG-116
   * took, and here is how much of the ticket that covers".
   */
  const PHASE_BUCKETS = [...DECLARED_PHASES, 'undeclared'];
  const emptySplit = () => Object.fromEntries(PHASE_BUCKETS.map((p) => [p, { lanes: 0, wall_ms: 0, accounted_ms: 0, cost: 0, unpriced: false }]));

  const byTicket = new Map();
  for (const l of lanes) {
    const t = l.primary_ticket ?? '(no ticket named)';
    if (!byTicket.has(t)) {
      byTicket.set(t, {
        ticket: t, lanes: 0, wall_ms: 0, accounted_ms: 0, cost: 0, unpriced: false, rounds: 0, verdicts: [],
        declared_lanes: 0, phase_declared_lanes: 0, phase: emptySplit(),
      });
    }
    const g = byTicket.get(t);
    g.lanes++;
    g.wall_ms += l.wall_ms || 0;
    g.accounted_ms += l.accounted_ms || 0;
    if (l.cost_usd == null) g.unpriced = true;
    else g.cost += l.cost_usd;
    g.rounds = Math.max(g.rounds, l.round ?? 0);
    if (l.verdict) g.verdicts.push(l.verdict);
    if (l.ticket_source === 'declared') g.declared_lanes++;
    const bucket = l.lifecycle_phase ?? 'undeclared';
    if (l.lifecycle_phase) g.phase_declared_lanes++;
    const b = g.phase[bucket];
    b.lanes++;
    b.wall_ms += l.wall_ms || 0;
    b.accounted_ms += l.accounted_ms || 0;
    if (l.cost_usd == null) b.unpriced = true;
    else b.cost += l.cost_usd;
  }

  // Declaration coverage — the honesty line. A report of declared facts that
  // does not say what fraction of lanes declared anything is indistinguishable
  // from a report that quietly filled the rest in.
  const coverage = {
    lanes: lanes.length,
    ticket: lanes.filter((l) => l.ticket_source === 'declared').length,
    phase: lanes.filter((l) => l.lifecycle_phase_source === 'declared').length,
    round: lanes.filter((l) => l.round_source === 'declared').length,
    class: lanes.filter((l) => l.dispatch_class_source === 'declared').length,
    pre_feature: lanes.filter((l) => !l.declared).length,
    conflicts: lanes.filter((l) => l.declared?.conflict).length,
    complaints: lanes.flatMap((l) => [
      ...(l.declared?.rejected ?? []),
      ...(l.declared?.unknown_keys ?? []).map((k) => `unknown key ${k}`),
    ]),
  };

  // Class × phase, the WA §I audit surface ("how many `fix` dispatches turned
  // out to need `explore`?"). Only DECLARED classes are counted here: mixing an
  // inferred class into an audit of declarations is how the ±5% got in.
  const byClass = new Map();
  for (const l of lanes) {
    if (l.dispatch_class_source !== 'declared') continue;
    const k = l.dispatch_class;
    const g = byClass.get(k) ?? { class: k, lanes: 0, accounted_ms: 0, cost: 0, unpriced: false, phases: {}, verdicts: {} };
    g.lanes++;
    g.accounted_ms += l.accounted_ms || 0;
    if (l.cost_usd == null) g.unpriced = true;
    else g.cost += l.cost_usd;
    const p = l.lifecycle_phase ?? 'undeclared';
    g.phases[p] = (g.phases[p] ?? 0) + 1;
    if (l.verdict) g.verdicts[l.verdict] = (g.verdicts[l.verdict] ?? 0) + 1;
    byClass.set(k, g);
  }

  // Lifecycle phase across the whole window — the top-line answer to "how much
  // of our effort is finding, how much is fixing, how much is verifying".
  const byLifecycle = Object.fromEntries(PHASE_BUCKETS.map((p) => [p, { lanes: 0, accounted_ms: 0, wall_ms: 0, cost: 0, unpriced: false }]));
  for (const l of lanes) {
    const g = byLifecycle[l.lifecycle_phase ?? 'undeclared'];
    g.lanes++;
    g.accounted_ms += l.accounted_ms || 0;
    g.wall_ms += l.wall_ms || 0;
    if (l.cost_usd == null) g.unpriced = true;
    else g.cost += l.cost_usd;
  }
  const byModel = new Map();
  for (const l of lanes) {
    for (const b of l.usage ?? []) {
      const k = `${b.model} (${b.service_tier})`;
      const g = byModel.get(k) ?? { key: k, provider: providerOf(b.model), requests: 0, tokens: 0 };
      g.requests += b.requests;
      g.tokens += b.input + b.output + b.cache_write_5m + b.cache_write_1h + b.cache_read;
      byModel.set(k, g);
    }
  }
  const byRound = new Map();
  for (const l of lanes) {
    if (!l.round) continue;
    const g = byRound.get(l.round) ?? { round: l.round, lanes: 0, broken: 0, holds: 0, cost: 0, unpriced: false };
    g.lanes++;
    if (l.verdict === 'BROKEN') g.broken++;
    if (l.verdict === 'HOLDS') g.holds++;
    if (l.cost_usd == null) g.unpriced = true;
    else g.cost += l.cost_usd;
    byRound.set(l.round, g);
  }
  return {
    lanes: lanes.length,
    cost_usd: anyUnpriced ? null : Math.round(sum((l) => l.cost_usd) * 100) / 100,
    cost_priced_usd: Math.round(sum((l) => l.cost_priced_usd) * 100) / 100,
    unpriced_models: [...new Set(lanes.flatMap((l) => l.unpriced ?? []))],
    tokens: sum((l) => l.tokens?.total),
    wall_ms: sum((l) => l.wall_ms),
    idle_gap_ms: sum((l) => l.idle_gap_ms),
    accounted_ms: sum((l) => l.accounted_ms),
    duplicate_usage_rows_dropped: sum((l) => l.duplicate_usage_rows_dropped),
    phases,
    declared_coverage: coverage,
    byLifecycle,
    byTicket: [...byTicket.values()].sort((a, b) => b.wall_ms - a.wall_ms),
    byClass: [...byClass.values()].sort((a, b) => b.cost - a.cost),
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byRound: [...byRound.values()].sort((a, b) => a.round - b.round),
  };
}

function printReport(r, opts) {
  const L = [];
  L.push('');
  L.push('  WHERE THE TIME AND THE TOKENS WENT — derived, not self-reported.');
  L.push('  Dollar figures are API-EQUIVALENT ESTIMATES at published list rates.');
  L.push('  They are NOT money paid; the plan is a flat subscription.');
  L.push('');
  L.push(`  lanes ${r.lanes}   turns-worth of tokens ${(r.tokens / 1e6).toFixed(1)}M   agent-hours ${hrs(r.accounted_ms)}`);
  L.push(`  API-equivalent estimate ${usd(r.cost_usd)}${r.cost_usd == null ? `  (priced portion ${usd(r.cost_priced_usd)}; unpriced: ${r.unpriced_models.join(', ')})` : ''}`);
  L.push(`  duplicate usage rows collapsed: ${r.duplicate_usage_rows_dropped}  (summing them would roughly double every figure above)`);
  L.push(`  idle/suspend excluded from phases: ${hrs(r.idle_gap_ms)} h`);
  L.push('');
  L.push('  PHASE                       hours     share');
  const totalPhase = PHASES.reduce((a, p) => a + r.phases[p], 0) || 1;
  for (const p of PHASES) {
    L.push(`  ${p.padEnd(22)}${hrs(r.phases[p]).padStart(9)}${((r.phases[p] / totalPhase) * 100).toFixed(1).padStart(9)}%`);
  }
  L.push('');
  L.push('  MODEL (tier)                     provider    requests      tokens');
  for (const m of r.byModel.slice(0, 10)) {
    L.push(`  ${m.key.padEnd(33)}${m.provider.padEnd(12)}${String(m.requests).padStart(9)}${((m.tokens / 1e6).toFixed(1) + 'M').padStart(12)}`);
  }
  if (r.byRound.length) {
    L.push('');
    L.push('  ROUND   lanes   BROKEN   HOLDS   est. cost');
    for (const g of r.byRound) {
      L.push(`  ${String(g.round).padStart(5)}${String(g.lanes).padStart(8)}${String(g.broken).padStart(9)}${String(g.holds).padStart(8)}   ${g.unpriced ? 'unknown' : usd(g.cost)}`);
    }
  }
  L.push('');
  L.push('  TICKET            lanes  rounds     hours   est. cost   verdicts');
  for (const t of r.byTicket.slice(0, opts.top)) {
    L.push(
      `  ${t.ticket.padEnd(18)}${String(t.lanes).padStart(5)}${String(t.rounds).padStart(8)}${hrs(t.wall_ms).padStart(10)}   ${t.unpriced ? '   unknown' : usd(t.cost)}   ${t.verdicts.join(',')}`,
    );
  }
  L.push('');
  L.push(...lifecycleSection(r, opts));
  L.push('');
  L.push('  Floor: transcript-derived cost is a LOWER BOUND. The CLI makes one small');
  L.push('  auxiliary (title) request per session that it does not write to the');
  L.push('  transcript — measured at 5.3% of a one-turn probe, negligible on a long');
  L.push('  lane, because the bias is per-session and not per-token.');
  L.push('');
  return L.join('\n');
}

/**
 * The lifecycle section — finding / fixing / verifying, DECLARED.
 *
 * Kept separate from the phase table above it because they are different axes
 * and conflating them is the mistake this section exists to correct. The table
 * above says what agents were doing (reading, editing, running tests). This one
 * says which step of the ticket's life the work belonged to, and it only ever
 * shows what a dispatcher said out loud.
 */
function lifecycleSection(r, opts) {
  const c = r.declared_coverage;
  const pct = (n) => (c.lanes ? ((n / c.lanes) * 100).toFixed(0) : '0');
  const L = [];
  L.push('  ── DECLARED AT DISPATCH (FEAT-100) ────────────────────────────────────');
  L.push(`  coverage: ticket ${c.ticket}/${c.lanes} (${pct(c.ticket)}%)   phase ${c.phase}/${c.lanes} (${pct(c.phase)}%)   round ${c.round}/${c.lanes} (${pct(c.round)}%)   class ${c.class}/${c.lanes} (${pct(c.class)}%)`);
  if (c.pre_feature) L.push(`  ${c.pre_feature} lane(s) predate the declaration and carry NO record of it — that is a gap, not a zero.`);
  if (c.conflicts) L.push(`  ${c.conflicts} lane(s) carried two declarations that disagreed; those fields were dropped rather than guessed.`);
  for (const complaint of [...new Set(c.complaints)].slice(0, 5)) L.push(`  rejected in a declaration: ${complaint}`);
  L.push('');
  L.push('  LIFECYCLE PHASE      lanes   agent-h   est. cost');
  for (const [p, g] of Object.entries(r.byLifecycle)) {
    L.push(`  ${p.padEnd(20)}${String(g.lanes).padStart(6)}${hrs(g.accounted_ms).padStart(10)}   ${g.unpriced ? '   unknown' : usd(g.cost)}`);
  }
  const declaredTickets = r.byTicket.filter((t) => t.phase_declared_lanes > 0);
  if (declaredTickets.length) {
    L.push('');
    L.push('  PER TICKET, BY DECLARED PHASE — agent-hours / est. cost');
    L.push('  TICKET                  finding             fixing           verifying          undeclared');
    for (const t of declaredTickets.slice(0, opts.top)) {
      const cell = (p) => {
        const g = t.phase[p];
        if (!g.lanes) return '        —      ';
        return `${hrs(g.accounted_ms).padStart(6)}h ${(g.unpriced ? 'unknown' : '$' + g.cost.toFixed(2)).padStart(8)}`;
      };
      L.push(`  ${t.ticket.padEnd(20)}${cell('finding')}   ${cell('fixing')}   ${cell('verifying')}   ${cell('undeclared')}`);
    }
  } else {
    L.push('');
    L.push('  No lane in this window declared a lifecycle phase, so there is no per-ticket');
    L.push('  finding/fixing/verifying split to show. Nothing here is estimated to fill it.');
  }
  if (r.byClass.length) {
    L.push('');
    L.push('  DISPATCH CLASS (declared only)   lanes   agent-h   est. cost   phases');
    for (const g of r.byClass) {
      const ph = Object.entries(g.phases).map(([k, v]) => `${k}:${v}`).join(' ');
      L.push(`  ${g.class.padEnd(30)}${String(g.lanes).padStart(6)}${hrs(g.accounted_ms).padStart(10)}   ${g.unpriced ? '   unknown' : usd(g.cost)}   ${ph}`);
    }
  }
  return L;
}

/**
 * One ticket, lane by lane, end to end — the drill-down behind a row above.
 * Prints the declaration verbatim next to what the collector derived, so the
 * two can be compared by eye rather than trusted.
 */
function printTicket(lanes, id) {
  const mine = lanes
    .filter((l) => l.primary_ticket === id || l.declared_tickets?.includes(id) || l.ticket_inferred === id)
    .sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
  const L = [];
  L.push('');
  L.push(`  ${id} — ${mine.length} lane(s), oldest first`);
  if (!mine.length) {
    L.push('  no lane in the ledger names this ticket.');
    return L.join('\n');
  }
  for (const l of mine) {
    const d = l.declared;
    L.push('');
    L.push(`  lane ${l.lane_id}  (${l.kind})  ${l.started_at ?? '?'} → ${l.ended_at ?? '?'}`);
    L.push(`    declared     ${d?.present ? `ticket=${(d.tickets ?? []).join(',') || '—'} phase=${d.phase ?? '—'} round=${d.round ?? '—'} class=${d.class ?? '—'}` : d ? '(nothing declared)' : '(lane predates the declaration)'}`);
    L.push(`    resolved     ticket=${l.primary_ticket ?? '—'} (${l.ticket_source ?? 'none'})  phase=${l.lifecycle_phase ?? '—'} (${l.lifecycle_phase_source ?? 'none'})  round=${l.round ?? '—'} (${l.round_source ?? 'none'})  class=${l.dispatch_class ?? '—'} (${l.dispatch_class_source ?? 'none'})`);
    L.push(`    inferred was ticket=${l.ticket_inferred ?? '—'}  round=${l.round_inferred ?? '—'}  class=${l.dispatch_class_inferred ?? '—'}`);
    L.push(`    agent-h ${hrs(l.accounted_ms)}   wall-h ${hrs(l.wall_ms)}   est. ${usd(l.cost_usd)}   turns ${l.turns}   models ${(l.models ?? []).join(', ')}   verdict ${l.verdict ?? '—'}`);
    const worked = PHASES.filter((p) => (l.phases?.[p] ?? 0) > 0).map((p) => `${p} ${hrs(l.phases[p])}h`);
    L.push(`    tool-derived (a DIFFERENT axis): ${worked.join(', ') || 'none'}`);
    if (d?.conflict) L.push('    ! two declarations disagreed — the conflicting fields were dropped, not guessed.');
    for (const rj of d?.rejected ?? []) L.push(`    ! rejected: ${rj}`);
  }
  L.push('');
  return L.join('\n');
}

function checkRetention(lanes) {
  const oldest = lanes.reduce((a, l) => {
    const t = Date.parse(l.started_at ?? '');
    return Number.isFinite(t) && (a == null || t < a) ? t : a;
  }, null);
  if (oldest == null) return '  retention: no dated lanes found.';
  const days = (Date.now() - oldest) / 86400e3;
  return `  retention: oldest live transcript is ${days.toFixed(1)} days old. The agent CLI prunes at ~30 days by default — the ledger is what survives that.`;
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  let lanes;
  if (opts.reportOnly) {
    lanes = readLedger();
    if (!lanes.length) {
      console.error('no ledger yet — run without --report-only first');
      return 1;
    }
  } else {
    const res = await collect(opts);
    if (res.error) {
      console.error(res.error);
      return 1;
    }
    lanes = res.lanes;
    if (!lanes.length) {
      console.error(`no lanes found under ${res.root} for ${opts.all ? 'any project' : opts.project}`);
      return 1;
    }
    const w = appendLedger(lanes);
    if (!opts.json) console.log(`  ledger: +${w.appended} new/changed of ${lanes.length} lanes (${w.total} total records)`);
  }

  const r = rollUp(lanes);
  if (opts.json) {
    console.log(JSON.stringify({ rollup: r, lanes }, null, 2));
    return 0;
  }
  if (opts.ticket) {
    console.log(printTicket(lanes, opts.ticket));
    return 0;
  }
  console.log(printReport(r, opts));
  if (opts.checkRetention) console.log(checkRetention(lanes));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}

export { collect, buildLane, rollUp, appendLedger, readLedger, encodeProjectDir, ledgerFile };
