/**
 * cost-model.mjs — the PURE half of FEAT-086's process-cost instrumentation.
 *
 * Everything here is a function of data already on disk. No I/O, no model calls,
 * no runtime cost to the pipeline it measures. `cost-collect.mjs` does the
 * reading; this file decides what the bytes MEAN.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THIS FILE EXISTS TO GET RIGHT
 * ---------------------------------------------------------------------------
 *
 * 1. DO NOT DOUBLE-COUNT USAGE. The CLI writes ONE transcript line per content
 *    BLOCK, and every line for the same API response repeats that response's
 *    `usage` object. Summing `usage` over assistant lines therefore counts the
 *    same tokens 2-3x. Measured on two real agent transcripts here: naive
 *    summing over-reported cache-read by 2.00x and 1.53x, and cache-write by
 *    2.28x and 2.23x — i.e. it roughly DOUBLES the bill, and it is the largest
 *    single error source in this whole file, larger than any price constant.
 *    `foldUsage()` groups by `message.id` and keeps the LAST row: the earlier
 *    rows for one message carry a PARTIAL `output_tokens` (a literal `1` while
 *    the block is still streaming), so "first wins" under-counts output ~16x.
 *    Last-wins is the only correct rule; both directions were measured.
 *
 * 2. A WRONG-PROVIDER PRICE MUST BE IMPOSSIBLE, NOT DOCUMENTED. The prior
 *    attempt (`scripts/migrate-tickets.mjs` PRICE) hardcoded one vendor's rates
 *    and read `input_tokens`, which on the anthropic path is near zero because
 *    the real input arrives as `cache_creation_input_tokens` — one lane reported
 *    $9.15 for a run that cost $45.72. So: prices are keyed by the EXACT model
 *    id string and the EXACT service tier. There is no default, no prefix match,
 *    no "close enough" tier. A model this table has never heard of yields
 *    `cost_usd: null` plus the model name in `unpriced`, and every roll-up that
 *    touches it is marked `cost_partial`. Unknown is printed as unknown.
 *
 * 3. PHASES ARE READ FROM WHAT THE AGENT DID, NOT FROM WHAT ITS CHARTER SAID.
 *    Classifying a lane by keywords in its prompt is how the standing dispatch
 *    boilerplate ("an independent clean-room verify pass is warranted") turns
 *    every lane into a verification lane. Phases here are attributed per TOOL
 *    CALL over the lane's own timeline, so "the fixer's own testing" is time
 *    that actually ran a test.
 */

/* ------------------------------------------------------------------ pricing */

/**
 * US dollars per MILLION tokens, by exact model id. Base input / base output.
 * Cache write and cache read are MULTIPLES of base input (see CACHE_MULT), which
 * is how the vendor states them — deriving them means a cache rate can never
 * drift out of step with the input rate it is defined against.
 *
 * `from`/`until` bound an introductory rate; a message is priced by ITS OWN
 * timestamp, so a window spanning a price change is priced correctly on both
 * sides instead of being flattened to today's rate.
 *
 * Only rates published for the CURRENT generation are listed. An older model id
 * is deliberately absent rather than guessed — absent means "unknown", which is
 * an honest answer; a guessed rate is a confident wrong number.
 */
export const PRICES = {
  // Opus tier
  'claude-opus-5': [{ in: 5, out: 25 }],
  'claude-opus-4-8': [{ in: 5, out: 25 }],
  'claude-opus-4-7': [{ in: 5, out: 25 }],
  'claude-opus-4-6': [{ in: 5, out: 25 }],
  'claude-opus-4-5': [{ in: 5, out: 25 }],
  // Highest tier
  'claude-fable-5': [{ in: 10, out: 50 }],
  'claude-mythos-5': [{ in: 10, out: 50 }],
  // Sonnet tier — introductory rate, then standard. Bounds are inclusive of the
  // start and EXCLUSIVE of the end, so the two rows cannot both match a moment.
  'claude-sonnet-5': [
    { in: 2, out: 10, until: '2026-09-01T00:00:00Z' },
    { in: 3, out: 15, from: '2026-09-01T00:00:00Z' },
  ],
  'claude-sonnet-4-6': [{ in: 3, out: 15 }],
  // Haiku tier — both the alias and the dated id are observed on disk.
  'claude-haiku-4-5': [{ in: 1, out: 5 }],
  'claude-haiku-4-5-20251001': [{ in: 1, out: 5 }],
};

/**
 * Cache multipliers, relative to base input.
 *   write 5m = 1.25x, write 1h = 2x, read = 0.1x.
 * The 5m/1h split is read from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`,
 * which the transcripts do carry — pricing every cache write at 1.25x when some
 * were 1h writes would under-report by up to 60% of the write line.
 */
export const CACHE_MULT = { write5m: 1.25, write1h: 2.0, read: 0.1 };

/**
 * Service tiers whose multiplier is KNOWN. `standard` is 1x; `batch` is half.
 * A tier not in this map (`priority`, a future `fast`) prices as UNKNOWN rather
 * than silently as standard — fast mode is 2x on Opus and would be a 100% error.
 */
export const TIER_MULT = { standard: 1, batch: 0.5 };

/** Model ids that are test scaffolding, not a model. Cost 0, never "unpriced". */
export const SYNTHETIC_MODELS = new Set(['<synthetic>']);

/**
 * Provider for a model id, by explicit allowlist of prefixes. Anything else is
 * `unknown` — and an unknown provider can never be priced, because prices are
 * keyed by exact id and no unknown-provider id is in the table.
 */
export function providerOf(model) {
  if (typeof model !== 'string' || !model) return 'unknown';
  if (SYNTHETIC_MODELS.has(model)) return 'synthetic';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^(gpt|o[1-9]|codex)/.test(model)) return 'openai';
  return 'unknown';
}

/** Pick the rate row in effect at `atMs`, or null when none is. */
export function rateFor(model, atMs) {
  const rows = PRICES[model];
  if (!rows) return null;
  const t = Number.isFinite(atMs) ? atMs : Date.now();
  for (const r of rows) {
    if (r.from && t < Date.parse(r.from)) continue;
    if (r.until && t >= Date.parse(r.until)) continue;
    return r;
  }
  return null;
}

/**
 * Cost of ONE folded usage bucket, in USD, or null when the model or tier is
 * not priceable. Never returns 0 for "unknown" — that is the whole point.
 */
export function costOf(bucket) {
  if (SYNTHETIC_MODELS.has(bucket.model)) return 0;
  const tierMult = TIER_MULT[bucket.service_tier ?? 'standard'];
  if (tierMult == null) return null;
  const rate = rateFor(bucket.model, bucket.at_ms);
  if (!rate) return null;
  const M = 1e6;
  return (
    (bucket.input * rate.in) / M +
    (bucket.output * rate.out) / M +
    (bucket.cache_write_5m * rate.in * CACHE_MULT.write5m) / M +
    (bucket.cache_write_1h * rate.in * CACHE_MULT.write1h) / M +
    (bucket.cache_read * rate.in * CACHE_MULT.read) / M
  );
}

/* ------------------------------------------------------------- usage folding */

const ZERO = () => ({ input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 0 });

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fold a lane's assistant entries into ONE bucket per (model, service_tier).
 *
 * LAST ROW WINS per `message.id` — see the header. When a message carries no
 * usable id, the entry's `requestId` is the fallback key; with neither, the
 * row is kept on its own (a lone row cannot be a duplicate of anything).
 *
 * Returns `{ buckets, duplicatesDropped, rowsSeen }` so a caller can PRINT the
 * number of duplicate rows it collapsed. A silent dedupe is indistinguishable
 * from a dedupe that did nothing.
 */
export function foldUsage(entries) {
  const byMessage = new Map();
  let rowsSeen = 0;
  for (const e of entries) {
    if (e?.type !== 'assistant') continue;
    const m = e.message;
    const u = m?.usage;
    if (!u || typeof u !== 'object') continue;
    rowsSeen++;
    const key = m.id || e.requestId || `anon-${rowsSeen}`;
    // Last wins: earlier rows for one message carry partial output_tokens.
    byMessage.set(key, { e, m, u });
  }
  const buckets = new Map();
  for (const { e, m, u } of byMessage.values()) {
    const model = typeof m.model === 'string' ? m.model : 'unknown';
    const tier = typeof u.service_tier === 'string' ? u.service_tier : 'standard';
    // Separator is written as the ESCAPE `\x00`, never a raw NUL byte in this
    // source. A raw NUL makes the Bash `grep` shim classify the file as binary
    // and return an EMPTY result indistinguishable from "no matches" (BUG-103) --
    // which would have made this cost tooling unsearchable by the same trap it
    // exists to measure. The byte is still a fine key separator: no model id or
    // service tier can contain one.
    const k = `${model}\x00${tier}`;
    let b = buckets.get(k);
    if (!b) {
      b = { model, service_tier: tier, ...ZERO(), first_at: null, last_at: null };
      buckets.set(k, b);
    }
    b.requests++;
    b.input += num(u.input_tokens);
    b.output += num(u.output_tokens);
    b.cache_read += num(u.cache_read_input_tokens);
    const cc = u.cache_creation;
    if (cc && typeof cc === 'object') {
      b.cache_write_5m += num(cc.ephemeral_5m_input_tokens);
      b.cache_write_1h += num(cc.ephemeral_1h_input_tokens);
    } else {
      // No TTL breakdown available: attribute to 5m, the cheaper of the two, so
      // an unknown split can only ever UNDER-state cost. Flagged by the caller.
      b.cache_write_5m += num(u.cache_creation_input_tokens);
    }
    const t = Date.parse(e.timestamp ?? '');
    if (Number.isFinite(t)) {
      if (b.first_at == null || t < b.first_at) b.first_at = t;
      if (b.last_at == null || t > b.last_at) b.last_at = t;
    }
  }
  const out = [...buckets.values()].map((b) => ({ ...b, at_ms: b.last_at ?? b.first_at ?? null }));
  return { buckets: out, duplicatesDropped: rowsSeen - byMessage.size, rowsSeen };
}

/**
 * Price a set of folded buckets. `cost_usd` is null — not 0 — when ANY bucket
 * could not be priced, and `unpriced` names exactly which model/tier pairs
 * caused it, so the gap is actionable rather than mysterious.
 */
export function priceBuckets(buckets) {
  let total = 0;
  const unpriced = [];
  for (const b of buckets) {
    const c = costOf(b);
    if (c == null) unpriced.push(`${b.model} (${b.service_tier})`);
    else total += c;
  }
  return {
    cost_usd: unpriced.length ? null : round6(total),
    cost_priced_usd: round6(total),
    unpriced,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function totalTokens(buckets) {
  const t = ZERO();
  delete t.requests;
  let requests = 0;
  for (const b of buckets) {
    t.input += b.input;
    t.output += b.output;
    t.cache_write_5m += b.cache_write_5m;
    t.cache_write_1h += b.cache_write_1h;
    t.cache_read += b.cache_read;
    requests += b.requests;
  }
  return { ...t, requests, total: t.input + t.output + t.cache_write_5m + t.cache_write_1h + t.cache_read };
}

/* ------------------------------------------------- phase classification */

/** The phases the user asked for, plus the two that only exist between lanes. */
export const PHASES = [
  'orienting',
  'investigating',
  'building',
  'testing',
  'bookkeeping',
  'blocked_on_lane',
  'conversing',
  'other',
];

/**
 * Files an agent reads to learn HOW TO WORK HERE, as opposed to files it reads
 * to learn about the problem. Reading these is `orienting` — the cost of the
 * instruction surface itself, which is exactly the number nobody could produce.
 */
const INSTRUCTION_RE =
  /(^|\/)(CLAUDE\.md|AGENTS\.md|WORKING_AGREEMENT[^/]*\.md|CONVENTIONS\.md|ROUTING\.md|RESPONSE_FORMAT\.md)$|(^|\/)docs\/prompts\//i;
/** The board's own furniture — reading it is orienting; WRITING it is bookkeeping. */
const BOARD_RE = /(^|\/)docs\/bugs\//i;

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Bash command shapes, matched by CONTAINS over the whole command, first rule
 * winning. Every pattern here was derived by sampling the 9,036 real Bash calls
 * in this project's transcripts, not by imagining what an agent types.
 *
 * Contains-matching, not first-token matching, because the real corpus is full
 * of `cd <dir> && node scripts/verify-x.mjs` and `for f in …; do node
 * scripts/verify-$f; done` — anchoring to the first token classified 45.7% of
 * all Bash calls as `other`, which is the same as not classifying them.
 *
 * Order note: bookkeeping precedes testing on purpose. `npm run gate && git
 * commit` is a commit act; the gate run that justified it is almost always its
 * own earlier call, and is caught there.
 */
const BASH_RULES = [
  [/\bgit\s+(commit|add|tag|push|revert|reset)\b|\bnpm\s+run\s+board\b|\bboard:(gen|check|provenance)\b/, 'bookkeeping'],
  [
    // The path segment is matched with a "not a shell separator" class, not
    // `[\w./-]`: real invocations interpolate variables (`verify-$f.mjs`) inside
    // a loop, and a tighter class silently drops them into `other`.
    /\b(node|npx)\s+[^\s;|&]*(verify|adversarial)[^\s;|&]*\.mjs|\bnpm\s+(run\s+)?(test|gate|typecheck)\b|\bnpm\s+run\s+verify|\bnpx?\s+tsc\b|\b(playwright|vitest|jest|qa:sweep)\b|\bindependent-verify\.mjs\b/,
    'testing',
  ],
  // Ad-hoc probes: a heredoc'd interpreter is how this fleet inspects state.
  // Some of those one-liners are really little test harnesses; they land in
  // `investigating` and that is a known, stated imprecision, not a silent one.
  [
    /\b(rg|grep|ugrep|ls|cat|find|wc|head|tail|jq|tree|stat|file|du|df|ast-grep|awk)\b|\bsed\s+-n\b|\bgit\s+(log|status|diff|show|blame|worktree|rev-parse)\b|\b(node|python3?)\s+-(e|c)?\b|\bcurl\s+-/,
    'investigating',
  ],
];

/** Strip shell scaffolding so a rule sees the command, not the prologue. */
function stripShellPrologue(cmd) {
  return String(cmd ?? '')
    .replace(/^\s*#[^\n]*\n/gm, '') // leading comment lines
    .replace(/^\s*(set\s+-[a-zA-Z]+\s*(;|&&|\n)?)+/, '') // set -e / set -o pipefail
    .replace(/^\s*(cd\s+\S+\s*(;|&&)\s*)+/, ''); // cd <dir> && …
}

/**
 * Which phase does ONE tool call belong to? Returns a phase name.
 *
 * `Task` is `blocked_on_lane` on purpose: from the DISPATCHING lane's seat, the
 * span of a Task call is time spent waiting on another lane, and the work
 * itself is accounted in that lane's own record. Counting it as work in both
 * places is how a fleet's total exceeds its wall clock.
 */
export function phaseOfToolCall(name, input) {
  const n = String(name ?? '');
  // `Agent` is this harness's dispatch tool; `Task` is the same tool under the
  // name other harnesses use. Missing `Agent` charged 465 real dispatches to
  // `other` — i.e. it hid the entire delegation cost — which is why this list is
  // matched against the observed tool histogram rather than assumed.
  if (n === 'Agent' || n === 'Task' || n === 'SendMessage' || n === 'Monitor' || n === 'TaskStop') return 'blocked_on_lane';
  if (n === 'Skill') return 'orienting';
  // Todo/plan bookkeeping tools: record-keeping about the work, not the work.
  if (n === 'TaskCreate' || n === 'TaskUpdate' || n === 'Workflow' || n === 'TodoWrite') return 'bookkeeping';

  const path = String(input?.file_path ?? input?.path ?? input?.pattern ?? input?.relative_path ?? '');
  if (WRITE_TOOLS.has(n) || /^mcp__serena__(replace|insert|rename|safe_delete)/.test(n)) {
    return BOARD_RE.test(path) ? 'bookkeeping' : 'building';
  }
  if (READ_TOOLS.has(n) || SEARCH_TOOLS.has(n) || /^mcp__serena__(find|get_symbols|get_diagnostics|read_memory|list_memories|initial_instructions)/.test(n)) {
    if (INSTRUCTION_RE.test(path) || /^mcp__serena__(initial_instructions|read_memory|list_memories)/.test(n)) return 'orienting';
    if (BOARD_RE.test(path)) return 'orienting';
    return 'investigating';
  }
  if (n === 'Bash' || n === 'BashOutput') {
    const cmd = stripShellPrologue(input?.command);
    for (const [re, phase] of BASH_RULES) if (re.test(cmd)) return phase;
    return 'other';
  }
  return 'other';
}

/**
 * Attribute a lane's WALL CLOCK across phases, from its own timeline.
 *
 * Method: walk consecutive timestamped entries. The interval between entry i
 * and i+1 is charged to the phase of the tool call that spans it — for an
 * assistant turn that issued tool calls, the phase of its first tool call;
 * for a tool_result, the phase of the call it answers. Intervals longer than
 * `idleGapMs` are NOT charged to any phase: they go to `idle_gap_ms`, because a
 * 40-minute gap between two reads is a suspended laptop or a parked lane, not
 * 40 minutes of reading. (The previous manual analysis had to hand-subtract
 * 8.4 h of machine suspend from two lanes; this does it by construction.)
 *
 * Returns phase totals in ms plus `idle_gap_ms`, `wall_ms` and `accounted_ms`,
 * so a reader can check the parts against the whole rather than trusting them.
 */
export function attributePhases(entries, opts = {}) {
  const idleGapMs = opts.idleGapMs ?? 5 * 60 * 1000;
  /*
   * ONLY REAL MESSAGE TURNS MARK TIME.
   *
   * A main-session transcript interleaves harness metadata rows — `mode`,
   * `ai-title`, `queue-operation`, `tag`, `permission-mode`, `file-history-*` —
   * that carry timestamps but describe no work. Leaving them in the timeline
   * put 25.8 of one orchestrator lane's 26.3 `other` hours there: the bucket was
   * measuring the harness's own housekeeping writes and calling it unclassified
   * agent time. Measured, then fixed, rather than assumed either way.
   */
  const rows = [];
  for (const e of entries) {
    if (e?.type !== 'user' && e?.type !== 'assistant') continue;
    const t = Date.parse(e?.timestamp ?? '');
    if (!Number.isFinite(t)) continue;
    rows.push({ t, e });
  }
  rows.sort((a, b) => a.t - b.t);

  // toolUseId -> phase, so a tool_result can be charged to its own call.
  const phaseByToolUse = new Map();
  for (const { e } of rows) {
    if (e.type !== 'assistant') continue;
    for (const b of e.message?.content ?? []) {
      if (b?.type === 'tool_use') phaseByToolUse.set(String(b.id), phaseOfToolCall(b.name, b.input));
    }
  }

  const phaseOfEntry = (e) => {
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b?.type === 'tool_use') return phaseByToolUse.get(String(b.id)) ?? 'other';
      }
      return null; // a text-only assistant turn: charged to whatever follows
    }
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') return phaseByToolUse.get(String(b.tool_use_id)) ?? 'other';
      }
    }
    return null;
  };

  const totals = Object.fromEntries(PHASES.map((p) => [p, 0]));
  let idle = 0;
  let accounted = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const dt = rows[i + 1].t - rows[i].t;
    if (dt <= 0) continue;
    if (dt > idleGapMs) {
      idle += dt;
      continue;
    }
    // Neither side issued or answered a tool call: this is a turn of plain
    // conversation — an orchestrator reading a report and writing a reply, or a
    // worker composing its final answer. That is real, chargeable time and it
    // deserves its own name rather than being swept into `other`.
    const p = phaseOfEntry(rows[i].e) ?? phaseOfEntry(rows[i + 1].e) ?? 'conversing';
    totals[p] += dt;
    accounted += dt;
  }
  const wall = rows.length >= 2 ? rows[rows.length - 1].t - rows[0].t : 0;
  return {
    ...totals,
    idle_gap_ms: idle,
    wall_ms: wall,
    accounted_ms: accounted,
    started_at: rows.length ? new Date(rows[0].t).toISOString() : null,
    ended_at: rows.length ? new Date(rows[rows.length - 1].t).toISOString() : null,
  };
}

/* ------------------------------------------------ charter-derived attribution */

const TICKET_RE = /\b(BUG|FEAT|ARCH|TASK)-\d{3,}\b/g;

/**
 * Every ticket id named in a charter, in first-mention order with counts.
 *
 * Deliberately returns ALL of them, not just the first. The prior manual pass
 * attributed a multi-ticket lane wholly to the first ticket named and had to
 * mark five tickets "(batched)" rather than print a false per-ticket figure.
 * Recording the full list lets a later reader split or exclude; recording one
 * throws the information away at capture time, where it cannot be recovered.
 */
export function ticketsIn(text) {
  const counts = new Map();
  for (const m of String(text ?? '').matchAll(TICKET_RE)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, mentions]) => ({ id, mentions }));
}

const CLASS_WORDS = ['trivial', 'fix', 'explore', 'plan+review', 'arch', 'verify'];

/* ------------------------------------------ FEAT-100: the declared dispatch */

/**
 * THE ONE GRAMMAR — written by whoever dispatches, read by whoever reports.
 *
 * Four facts the dispatcher knows at the moment it writes a charter and that
 * nothing previously asked it for: which TICKET the lane works, which lifecycle
 * PHASE it is in, which ROUND of that ticket this attempt is, and the dispatch
 * CLASS the Working Agreement §I already requires it to choose. Every one of
 * them was previously re-derived by a reader — from ticket ids mentioned
 * anywhere in the prose, from what tools the agent happened to reach for, from a
 * lane's position in a sorted list. This file is where that stops.
 *
 * The declaration is ONE LINE at the top of the charter:
 *
 *     Dispatch: ticket=BUG-099 phase=fixing round=2 class=fix
 *
 * Chosen because it costs the dispatch path NOTHING. The charter is already
 * being written and already lands in the lane's transcript as its first user
 * message; the collector already reads that message. No new store, no new
 * write, no runtime call. A dispatcher that omits the line is not broken — the
 * fields come back null and the report says "undeclared", which is a gap. A
 * gap is a fact. A guess is not.
 *
 * `formatDispatchDeclaration` and `parseDispatchDeclaration` are deliberately
 * adjacent: the writer (`scripts/dispatch.mjs`) and the reader
 * (`scripts/cost-collect.mjs`) share this one definition, so the grammar cannot
 * drift into two subtly different versions of itself.
 */

/** The lifecycle phases the user asked to see, and nothing else. */
export const DECLARED_PHASES = ['finding', 'fixing', 'verifying'];

/** The dispatch classes Working Agreement §I defines. */
export const DISPATCH_CLASSES = CLASS_WORDS;

export const DISPATCH_DECL_KEYS = ['ticket', 'phase', 'round', 'class'];

const DECL_LINE_RE = /^\s*dispatch\s*:\s*(.*)$/i;
const TICKET_ID_ONE = /^(BUG|FEAT|ARCH|TASK)-\d{3,}$/;

/** An empty declaration — every field absent, nothing claimed. */
function emptyDecl() {
  return {
    present: false,
    tickets: null,
    phase: null,
    round: null,
    class: null,
    lines_seen: 0,
    lines_in_fence: 0,
    conflict: false,
    malformed: [],
    unknown_keys: [],
    rejected: [],
  };
}

/** Parse the token list after `Dispatch:` into raw key/value pairs. */
function declTokens(rest, out) {
  const fields = {};
  for (const tok of String(rest).trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq <= 0) {
      out.malformed.push(tok);
      continue;
    }
    const k = tok.slice(0, eq).toLowerCase();
    const v = tok.slice(eq + 1);
    if (!DISPATCH_DECL_KEYS.includes(k)) {
      out.unknown_keys.push(k);
      continue;
    }
    fields[k] = v;
  }
  return fields;
}

/** Validate one raw field. Returns the value, or null with a rejection noted. */
function declValue(key, raw, out) {
  if (key === 'ticket') {
    const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    const good = ids.filter((id) => TICKET_ID_ONE.test(id));
    for (const bad of ids.filter((id) => !TICKET_ID_ONE.test(id))) {
      out.rejected.push(`ticket=${bad} (not a ticket id)`);
    }
    return good.length ? good : null;
  }
  if (key === 'phase') {
    const p = String(raw).toLowerCase();
    if (DECLARED_PHASES.includes(p)) return p;
    out.rejected.push(`phase=${raw} (not one of ${DECLARED_PHASES.join('|')})`);
    return null;
  }
  if (key === 'round') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
    out.rejected.push(`round=${raw} (not a positive integer)`);
    return null;
  }
  // class
  const c = String(raw).toLowerCase();
  if (DISPATCH_CLASSES.includes(c)) return c;
  out.rejected.push(`class=${raw} (not one of ${DISPATCH_CLASSES.join('|')})`);
  return null;
}

/**
 * Read the declaration out of a charter. Never guesses; never throws.
 *
 * TWO DELIBERATE STRICTNESSES, both aimed at the failure this board keeps
 * producing — a recogniser over prose that silently returns the wrong answer:
 *
 * 1. **Lines inside a fenced code block are ignored.** A charter that QUOTES the
 *    grammar (a lane sent to document it, or this very file's own tests) must
 *    not be read as declaring it. Fences are counted by lines whose first
 *    non-space run is three-or-more backticks or tildes. That boundary is
 *    simple and its limit is stated rather than chased: an indented four-space
 *    code block is NOT recognised as a fence. Point 2 is what makes that safe.
 *
 * 2. **Two declarations that disagree produce NOTHING.** Not the first, not the
 *    last — null, with `conflict: true`. Picking one would be a guess dressed as
 *    a reading, and the whole point of this feature is that a guess is worse
 *    than a gap. Identical repeats are fine and collapse to one value.
 *
 * `rejected`, `malformed` and `unknown_keys` are returned rather than dropped so
 * a typo in a declaration surfaces as a visible complaint in the report instead
 * of looking exactly like never having declared anything.
 */
export function parseDispatchDeclaration(text) {
  const out = emptyDecl();
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  const seen = [];
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const m = DECL_LINE_RE.exec(line);
    if (!m) continue;
    if (inFence) {
      out.lines_in_fence++;
      continue;
    }
    out.lines_seen++;
    const raw = declTokens(m[1], out);
    const parsed = {};
    for (const k of DISPATCH_DECL_KEYS) {
      parsed[k] = Object.prototype.hasOwnProperty.call(raw, k) ? declValue(k, raw[k], out) : null;
    }
    seen.push(parsed);
  }
  if (!seen.length) return out;
  out.present = true;
  for (const k of DISPATCH_DECL_KEYS) {
    // The declaration key is singular (`ticket=`) but the field is a LIST
    // (`tickets`), because a multi-ticket lane is normal and attributing it
    // wholly to one id is the loss the previous analysis had to mark "(batched)".
    const field = k === 'ticket' ? 'tickets' : k;
    const vals = seen.map((s) => JSON.stringify(s[k])).filter((v) => v !== 'null');
    const distinct = [...new Set(vals)];
    if (distinct.length > 1) {
      out.conflict = true;
      out[field] = null;
    } else if (distinct.length === 1) {
      out[field] = JSON.parse(distinct[0]);
    }
  }
  return out;
}

/**
 * The charter WITHOUT its declaration lines.
 *
 * The inferred fields (`ticketsIn`, `dispatchClassIn`) must be computed over
 * this, not over the raw charter — otherwise the declaration contaminates its
 * own control. Measured here: a lane declaring `ticket=BUG-902` whose prose is
 * about BUG-901 had BUG-902 as its "inferred" ticket too, because the
 * declaration line is itself a mention and comes first. The inferred column
 * exists to answer "what would a reader have concluded without this feature",
 * and that answer is worthless if the feature is inside the input.
 */
export function stripDispatchDeclarations(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !DECL_LINE_RE.test(line))
    .join('\n');
}

/**
 * The inverse: build the canonical line from known values. Used by the dispatch
 * CLI so the writer and the reader can never disagree about the syntax — the
 * CLI formats, then parses its own output back and refuses if it does not
 * round-trip, which makes an unreadable declaration impossible to emit.
 */
export function formatDispatchDeclaration({ ticket, phase, round, class: cls } = {}) {
  const parts = [];
  const t = Array.isArray(ticket) ? ticket.join(',') : ticket;
  if (t) parts.push(`ticket=${t}`);
  if (phase) parts.push(`phase=${phase}`);
  if (round != null) parts.push(`round=${round}`);
  if (cls) parts.push(`class=${cls}`);
  return parts.length ? `Dispatch: ${parts.join(' ')}` : null;
}

/**
 * The dispatch class a charter DECLARES, or null.
 *
 * Only an explicit declaration counts — `Class: verify`, `dispatch class: fix`.
 * Free-text keyword matching is refused on purpose: the standing charter
 * boilerplate contains the phrase "an independent clean-room verify pass is
 * warranted", which turns nearly every lane into a verify lane and was the
 * documented failure of the previous heuristic. A null here is honest.
 */
export function dispatchClassIn(text) {
  const m = /(?:^|\n)[^\n]{0,40}\b(?:dispatch\s+)?class\s*[:=]\s*`?([a-z+]+)`?/i.exec(String(text ?? ''));
  if (!m) return null;
  const c = m[1].toLowerCase();
  return CLASS_WORDS.includes(c) ? c : null;
}

const VERDICT_RE = /\b(HOLDS|BROKEN|INCONCLUSIVE|INVALID)\b/g;

/**
 * The verdict a lane REPORTED, read from its final assistant text.
 *
 * Scans only the tail of the lane's own output: a verdict word quoted from the
 * charter earlier in the run is not this lane's verdict. Returns null when no
 * verdict word appears — most lanes are not verification lanes and should say
 * nothing rather than be assigned one.
 */
export function verdictOf(finalText) {
  const t = String(finalText ?? '').slice(-4000);
  const hits = [...t.matchAll(VERDICT_RE)].map((m) => m[1]);
  if (!hits.length) return null;
  // BROKEN outranks HOLDS: a report that names both is reporting a failure.
  for (const v of ['BROKEN', 'INVALID', 'INCONCLUSIVE', 'HOLDS']) if (hits.includes(v)) return v;
  return null;
}

/**
 * Assign a ROUND NUMBER to each lane, per ticket, by start time.
 *
 * Round is not a property of a lane — it is a property of a lane's POSITION in
 * its ticket's history, so it can only be computed once every lane is known.
 * Mutates nothing: returns a Map of lane id -> { ticket, round } entries.
 *
 * This is the INFERRED round, kept for lanes that ran before FEAT-100 and for
 * lanes whose dispatcher declared nothing. A declared round always wins over it
 * (see `resolveLaneAttribution` in cost-collect.mjs) — position in a sorted list
 * is a proxy for "which attempt is this", and the dispatcher holds the fact
 * itself. Grouping keys on the DECLARED ticket when there is one, so a declared
 * multi-ticket lane is not silently re-grouped under a prose mention.
 */
export function assignRounds(lanes) {
  const byTicket = new Map();
  for (const l of lanes) {
    const primary = l.declared?.tickets?.[0] ?? l.tickets?.[0]?.id;
    if (!primary) continue;
    if (!byTicket.has(primary)) byTicket.set(primary, []);
    byTicket.get(primary).push(l);
  }
  const out = new Map();
  for (const [ticket, group] of byTicket) {
    group.sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
    group.forEach((l, i) => out.set(l.lane_id, { ticket, round: i + 1 }));
  }
  return out;
}

/**
 * Merge what the dispatcher DECLARED with what a reader could INFER, and say
 * which of the two every answer came from.
 *
 * Three rules, and the third is the whole feature:
 *   - declared wins, always. The dispatcher owned the fact.
 *   - inferred fills in only where nothing was declared, and is LABELLED
 *     `inferred` so no report can pass it off as a statement of fact.
 *   - PHASE has no inference at all. The collector's existing `phases` map is a
 *     different axis — orienting/investigating/building/testing describes what
 *     an agent DID, not which lifecycle step the work was in. A verify lane that
 *     spends its run reading and grepping scores as `investigating`, which is
 *     true and is not the same claim as "this lane was verifying BUG-116".
 *     Deriving one from the other would be exactly the fabrication this feature
 *     exists to remove, so an undeclared phase stays null forever.
 *
 * Pure: returns the fields, mutates nothing.
 */
export function resolveLaneAttribution(lane, inferredRound) {
  const d = lane.declared ?? emptyDecl();
  const declaredTicket = d.tickets?.[0] ?? null;
  // Strictly the PROSE inference. `inferredRound.ticket` is not usable here: it
  // groups on the declared ticket when there is one, so reading it back would
  // report the declaration as if it were an independent inference.
  const inferredTicket = lane.tickets?.[0]?.id ?? null;
  const primary = declaredTicket ?? inferredTicket;
  const round = d.round ?? inferredRound?.round ?? null;
  const cls = d.class ?? lane.dispatch_class ?? null;
  return {
    primary_ticket: primary,
    ticket_source: declaredTicket ? 'declared' : inferredTicket ? 'inferred' : null,
    declared_tickets: d.tickets ?? null,
    round,
    round_source: d.round != null ? 'declared' : inferredRound?.round != null ? 'inferred' : null,
    dispatch_class: cls,
    dispatch_class_source: d.class ? 'declared' : lane.dispatch_class ? 'inferred' : null,
    // The inference is KEPT beside the declaration rather than overwritten, so
    // "how often did the old heuristic disagree with the fact?" is answerable
    // from the ledger alone instead of needing the transcripts back.
    ticket_inferred: inferredTicket,
    round_inferred: inferredRound?.round ?? null,
    dispatch_class_inferred: lane.dispatch_class ?? null,
    lifecycle_phase: d.phase ?? null,
    lifecycle_phase_source: d.phase ? 'declared' : null,
  };
}
