#!/usr/bin/env node
/**
 * triage.mjs — FEAT-095: request intake triage. "Is this already known?"
 *
 * The problem: the board is the up-to-date record of what exists and what
 * state it is in, and NOTHING consulted it when a request arrived. A request
 * for detailed per-ticket cost and phase logging was about to be dispatched as
 * new work while FEAT-086 — that exact ticket, half-built — sat open on the
 * board. There is a board checker, a board generator and a recurrence watcher;
 * there was no dedupe-on-intake.
 *
 * This runs BEFORE any work is dispatched, on every request. It answers with
 * DATA, not prose, so relaying it needs no judgement:
 *
 *   { "verdict": "already_exists" | "partly_exists" | "new", ... }
 *
 * Design constraints, and why:
 *
 *  - NO SEARCH INDEX. The board is generated and append-only, so it does not
 *    rot the way a maintained index or architecture doc does (the guide set
 *    currently carries 36 stale references). The digest is rebuilt from the
 *    ticket files on every run and thrown away.
 *  - ONE TICKET READER. The digest is built through `parseTicket` from
 *    lib/ticket-schema.mjs — the single definition of the ticket format — so
 *    this does not become the third reader that disagrees with the other two
 *    (ARCH-008).
 *  - CHEAP. One `claude -p` turn, no tools, no CLAUDE.md, no session
 *    persistence, a small model. `--output-format json` reports the real cost
 *    of the run, which `--show-cost` prints per model. MEASURED over the real
 *    208-ticket board on claude-haiku-4-5: $0.028–$0.068, averaging $0.045 a
 *    run across the five requests in scripts/verify-triage.mjs. Two thirds of
 *    that is the ~7.9k-token digest: roughly half is the answering turn's cache
 *    write, and roughly a third is a second, uncached classifier call the CLI
 *    makes on every `-p` run, which no flag tested here suppresses. So the one
 *    lever that moves the number is digest size, which is why finished tickets
 *    contribute a title and nothing else.
 *
 * Usage:
 *   node scripts/triage.mjs "the user's request, verbatim"
 *   node scripts/triage.mjs --request-file req.txt [--model <id>] [--show-cost]
 *   node scripts/triage.mjs --dry-run "…"     # build the digest, call nothing
 *   node scripts/triage.mjs --file "…"        # on `new`, actually write the ticket
 *
 * stdout = the verdict JSON, one object, nothing else. stderr = progress.
 * exit 0 = a verdict was produced; 2 = the lane failed to produce one.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { parseTicket, TICKET_FILE_RE, isDoneStatus } from './lib/ticket-schema.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_DIR = path.join(REPO, 'docs/bugs');

// ── the board digest ─────────────────────────────────────────────────────────

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Legacy (pre-migration) tickets carry no `summary` field. Rather than show the
 * model a bare title for them, fall back to the first prose paragraph of the
 * body — the `## Symptom` text in practice. Six of 207 tickets today.
 */
function legacyBlurb(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (out.length) break; continue; }
    if (/^[#>|`-]/.test(line) || /^\*\*/.test(line)) { if (out.length) break; continue; }
    out.push(line);
    if (out.join(' ').length > 240) break;
  }
  return out.join(' ');
}

export function buildDigest(dir = DEFAULT_DIR, { full = false } = {}) {
  const files = fs.readdirSync(dir).filter((f) => TICKET_FILE_RE.test(f)).sort();
  const lines = [];
  const unreadable = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const p = parseTicket(text, { file: f, mode: 'auto' });
    const s = p.summary || {};
    const r = p.record || {};
    const id = s.id || f.replace(/-.*$/, '');
    if (!s.title) unreadable.push(f);
    const done = isDoneStatus(s.work_state);
    const parts = [`${id} [${s.work_state || 'unknown'}] ${clip(s.title || f, 110)}`];
    const blurb = r.summary || (p.format === 'legacy' ? legacyBlurb(r.body || text) : '');
    // Open work gets the fuller picture — an open ticket is the one a request
    // can duplicate, and `current_need` is what makes "partly exists" callable.
    // Finished work is TITLE ONLY. Titles here are written to the project's
    // writing contract ("what the person saw"), which is exactly the axis a
    // request is phrased on, and 172 of 207 tickets are finished — carrying
    // their summaries too would roughly double what every run costs. Recall on
    // finished work is verified against a real past request in
    // scripts/verify-triage.mjs rather than assumed.
    if (!done) {
      if (blurb) parts.push(clip(blurb, 240));
      if (r.current_need) parts.push(`NEED: ${clip(r.current_need, 160)}`);
    } else if (full && blurb) {
      parts.push(clip(blurb, 160));
    }
    lines.push(parts.join(' | '));
  }
  return { digest: lines.join('\n'), count: lines.length, unreadable };
}

/** Next free id for a prefix, read from the ticket files (not from INDEX). */
export function nextId(prefix, dir = DEFAULT_DIR) {
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([A-Z]+)-(\d+)/);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ── the lane ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a request-intake triage step for a software project ticket board.',
  'You are given the whole board (every ticket: id, state, title, summary, current need) and one incoming request.',
  'Decide whether the request is ALREADY on the board, PARTLY on it, or genuinely NEW.',
  '',
  'Rules:',
  '- Match on WHAT THE REQUEST WANTS, not on shared words. A request and a ticket match when doing the ticket would satisfy the request.',
  '- A request often describes an outcome in different vocabulary than the ticket that covers it. Read for intent.',
  '- "already_exists": one ticket fully covers the request. Report its id and state.',
  '- "partly_exists": a ticket covers part of it, or covers it but is unfinished. Report its id, what is already built, and the remaining gap.',
  '- Prefer "partly_exists" over "new" whenever an existing ticket would have to be touched to satisfy the request.',
  '- "new": no ticket covers it. Draft the ticket.',
  '- A request that reports a defect in an EXISTING ticket (wrong label, wrong state, misleading wording) is "partly_exists" against that ticket, not "new".',
  '- Never invent a ticket id. Only cite ids present in the board given to you.',
  '- Be terse. Every prose field is ONE sentence of at most 25 words; it is relayed verbatim to a person, not read as an essay.',
  'Answer with the JSON object only.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['already_exists', 'partly_exists', 'new'] },
    ticket: { type: ['string', 'null'], description: 'The matched ticket id, or null when verdict is new.' },
    ticket_state: { type: ['string', 'null'], description: 'The matched ticket work_state as given in the board.' },
    built: { type: ['string', 'null'], description: 'For partly_exists only: what already exists. ONE sentence, at most 25 words. Null otherwise.' },
    gap: { type: ['string', 'null'], description: 'For partly_exists only: what the request asks for that is not done. ONE sentence, at most 25 words. Null otherwise.' },
    related: { type: 'array', items: { type: 'string' }, description: 'Other ticket ids worth naming, at most three. May be empty.' },
    why: { type: 'string', description: 'Why this verdict. ONE sentence, at most 25 words.' },
    draft: {
      type: ['object', 'null'],
      description: 'For verdict new only: the ticket to file. Null otherwise.',
      properties: {
        type: { type: 'string', enum: ['bug', 'feature', 'architecture'] },
        title: { type: 'string', description: 'What the person sees or cannot do. No symbol names, no mechanism.' },
        summary: { type: 'string', description: 'Up to 60 words, plain language, what is wrong or missing.' },
        impact_if_we_wait: { type: 'string', description: 'Up to 50 words. What happens if this is left, and how bounded it is.' },
        current_need: { type: 'string', description: 'Up to 40 words. The next concrete step.' },
        severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        area: { type: 'string', description: 'Up to 6 words.' },
        success_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two to four observable statements that are true once the request is satisfied. Restate the request as things a person could check; do not invent implementation detail.',
        },
      },
      required: ['type', 'title', 'summary', 'impact_if_we_wait', 'current_need', 'severity', 'area', 'success_criteria'],
    },
  },
  required: ['verdict', 'ticket', 'why', 'related', 'draft'],
};

function runClaude({ model, system, prompt, schema, timeoutMs }) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--tools', '',              // no tool definitions in context, and no tool calls
    '--safe-mode',              // no CLAUDE.md, skills, plugins, hooks, MCP
    '--no-session-persistence', // intake runs on every request; do not fill the store
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let err = '';
    let timer = null;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, kind: 'spawn', message: e.message, out, err }));
    child.on('close', (code) => finish({ ok: code === 0, kind: code === 0 ? null : 'exit', code, out, err }));
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000);
      finish({ ok: false, kind: 'timeout', message: `no verdict within ${Math.round(timeoutMs / 1000)}s`, out, err });
    }, timeoutMs);
    child.stdin.end(prompt);
  });
}

/** Pull the verdict object out of `claude --output-format json`'s envelope. */
function extractVerdict(stdout) {
  let env;
  try { env = JSON.parse(stdout); } catch (e) { return { error: `lane stdout was not JSON: ${e.message}` }; }
  if (env && env.is_error) return { error: `lane reported an error: ${clip(env.result, 300)}`, envelope: env };
  const raw = env && (env.structured_output ?? env.result);
  if (raw == null) return { error: 'lane returned no result', envelope: env };
  if (typeof raw === 'object') return { verdict: raw, envelope: env };
  const text = String(raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { error: `lane result held no JSON object: ${clip(text, 300)}`, envelope: env };
  try { return { verdict: JSON.parse(text.slice(start, end + 1)), envelope: env }; }
  catch (e) { return { error: `lane result was not parseable JSON: ${e.message}`, envelope: env }; }
}

/**
 * The model is told to cite only ids it was given. Enforce it rather than
 * trust it — a fabricated id is the one failure that would make the
 * orchestrator relay a reference to nothing.
 */
function checkIds(verdict, known) {
  const bad = [];
  const seen = (id) => { if (id && !known.has(id)) bad.push(id); };
  seen(verdict.ticket);
  for (const r of verdict.related || []) seen(r);
  return bad;
}

const TYPE_PREFIX = { bug: 'BUG', feature: 'FEAT', architecture: 'ARCH' };

function renderTicket(id, draft, today, request) {
  const record = {
    id,
    type: draft.type,
    title: draft.title,
    summary: draft.summary,
    impact_if_we_wait: draft.impact_if_we_wait,
    current_need: draft.current_need,
    severity: SEVERITY[draft.severity] || 'not_recorded',
    area: draft.area,
    reported: today,
    reported_by: 'user',
    owner: 'unassigned',
    work_state: 'open',
    human_action: 'none',
    updated: today,
    decision: null,
    decision_history: [],
    // Success criteria are a RESTATEMENT of the request as checkable
    // statements, which intake can honestly do. `code_refs` is empty because
    // intake has read no code and running one would make it neither cheap nor
    // fresh — a guessed reference would become the first agent's starting point
    // and it would be fiction. The schema's rule is that absence is stated
    // rather than omitted, so an unknown is written as the explicit words.
    success_criteria: Array.isArray(draft.success_criteria) && draft.success_criteria.length
      ? draft.success_criteria
      : ['Not recorded'],
    code_refs: [],
    related: [],
    recurrence_evidence: [],
    verification: [],
    verification_class: 'fix',
    body_slots: {
      Diagnosis: true,
      Evidence: false,
      'Implementation notes': false,
      'Verification plan': false,
      'Migration and rollback': false,
      Risks: false,
      'Activity log': true,
    },
    source: {
      archived_path: null,
      sha256: null,
      original_title: null,
      migrated_on: null,
      migrated_by: null,
      confirmation: 'Filed directly in the record format by request-intake triage. There is no legacy original.',
      dropped: [],
    },
  };
  return [
    '```orchard-ticket',
    JSON.stringify(record, null, 2),
    '```',
    '',
    `# ${id} — ${draft.title}`,
    '',
    '## Diagnosis',
    '',
    draft.summary,
    '',
    '## Activity log (APPEND-ONLY — never edit or delete a prior entry)',
    '',
    `### ${today} — filed at intake by scripts/triage.mjs`,
    '',
    'Filed because no ticket on the board covered the request. Nothing here was',
    'investigated: the fields above are a reading of what was asked for, not of',
    'the code. `success_criteria` and `code_refs` are deliberately empty rather',
    'than guessed.',
    '',
    'The request, verbatim:',
    '',
    ...String(request || '').trim().split('\n').map((l) => `> ${l}`),
    '',
    '**Handoff.** First agent on this ticket: confirm the framing against the',
    'verbatim request above before building, and fill in the success criteria',
    'from what you find rather than from the summary.',
    '',
  ].join('\n');
}

const SEVERITY = { low: 'low', med: 'medium', medium: 'medium', high: 'high' };

function slug(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Create the ticket file with O_EXCL so a racing lane cannot silently win the id. */
function fileTicket(draft, dir, today, request) {
  const prefix = TYPE_PREFIX[draft.type] || 'FEAT';
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = nextId(prefix, dir);
    const file = path.join(dir, `${id}-${slug(draft.title)}.md`);
    try {
      const text = renderTicket(id, draft, today, request);
      // Never write a ticket the board's own reader would reject. An auto-filed
      // ticket that fails `board:check` is worse than no ticket: someone has to
      // find it and repair it by hand.
      const check = parseTicket(text, { file: `${id}.md`, mode: 'strict' });
      if (!check.ok) throw new Error(`drafted ticket does not satisfy the ticket schema:\n  ${check.errors.join('\n  ')}`);
      fs.writeFileSync(file, text, { flag: 'wx' });
      return { id, file };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not allocate a free ticket id after 20 attempts');
}

// ── cli ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { model: 'claude-haiku-4-5', dir: DEFAULT_DIR, dryRun: false, file: false, showCost: false, timeoutMs: 180000, full: false, request: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--file') o.file = true;
    else if (a === '--show-cost') o.showCost = true;
    else if (a === '--full') o.full = true;
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--dir') o.dir = path.resolve(argv[++i]);
    else if (a === '--timeout-min') o.timeoutMs = Number(argv[++i]) * 60000;
    else if (a === '--request-file') o.request = fs.readFileSync(argv[++i], 'utf8');
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (o.request == null) o.request = rest.join(' ');
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (!o.request || !o.request.trim()) {
    process.stderr.write('triage: no request given\n\nUsage: node scripts/triage.mjs "the request" [--model <id>] [--file] [--dry-run] [--show-cost]\n');
    return 2;
  }
  const { digest, count, unreadable } = buildDigest(o.dir, { full: o.full });
  if (unreadable.length) process.stderr.write(`triage: ${unreadable.length} ticket(s) parsed without a title: ${unreadable.join(', ')}\n`);
  const known = new Set(digest.split('\n').map((l) => l.split(' ')[0]));

  const prompt = [
    `BOARD (${count} tickets)`,
    digest,
    '',
    'INCOMING REQUEST',
    o.request.trim(),
  ].join('\n');

  if (o.dryRun) {
    process.stderr.write(`triage: dry run — ${count} tickets, ${prompt.length} prompt chars (~${Math.round(prompt.length / 3.7)} tokens)\n`);
    process.stdout.write(prompt);
    return 0;
  }

  process.stderr.write(`triage: ${count} tickets, model ${o.model}…\n`);
  const t0 = Date.now();
  const run = await runClaude({ model: o.model, system: SYSTEM_PROMPT, prompt, schema: SCHEMA, timeoutMs: o.timeoutMs });
  if (!run.ok) {
    process.stderr.write(`triage failed [${run.kind}] ${run.message || `exit ${run.code}`}\n${clip(run.err, 800)}\n`);
    return 2;
  }
  const got = extractVerdict(run.out);
  if (got.error) {
    process.stderr.write(`triage failed [malformed] ${got.error}\n`);
    return 2;
  }
  const verdict = got.verdict;

  const bogus = checkIds(verdict, known);
  if (bogus.length) {
    process.stderr.write(`triage failed [fabricated-id] the lane cited ${bogus.join(', ')}, which is not on the board\n`);
    return 2;
  }
  if (verdict.verdict !== 'new' && !verdict.ticket) {
    process.stderr.write(`triage failed [malformed] verdict ${verdict.verdict} named no ticket\n`);
    return 2;
  }
  if (verdict.verdict === 'new' && !verdict.draft) {
    process.stderr.write('triage failed [malformed] verdict new carried no draft ticket\n');
    return 2;
  }

  if (verdict.verdict === 'new' && o.file) {
    const today = new Date().toISOString().slice(0, 10);
    const filed = fileTicket(verdict.draft, o.dir, today, o.request);
    verdict.filed = filed.id;
    verdict.filed_path = path.relative(REPO, filed.file);
    process.stderr.write(`triage: filed ${filed.id} at ${verdict.filed_path} — run \`npm run board:gen\` and add its INDEX row\n`);
  } else if (verdict.verdict === 'new') {
    verdict.filed = null;
    verdict.would_file = nextId(TYPE_PREFIX[verdict.draft.type] || 'FEAT', o.dir);
  }

  const env = got.envelope || {};
  const cost = {
    usd: env.total_cost_usd ?? null,
    ms: Date.now() - t0,
    model: o.model,
    tickets: count,
    models: env.modelUsage
      ? Object.fromEntries(Object.entries(env.modelUsage).map(([m, u]) => [m, {
        usd: u.costUSD ?? null,
        input: u.inputTokens ?? null,
        cache_read: u.cacheReadInputTokens ?? null,
        cache_write: u.cacheCreationInputTokens ?? null,
        output: u.outputTokens ?? null,
      }]))
      : null,
    usage: env.usage
      ? {
        input: env.usage.input_tokens ?? null,
        cache_read: env.usage.cache_read_input_tokens ?? null,
        cache_write: env.usage.cache_creation_input_tokens ?? null,
        output: env.usage.output_tokens ?? null,
      }
      : null,
  };
  if (o.showCost) verdict.cost = cost;
  process.stderr.write(`triage: ${verdict.verdict}${verdict.ticket ? ` ${verdict.ticket}` : ''} — $${cost.usd == null ? '?' : cost.usd.toFixed(4)} in ${(cost.ms / 1000).toFixed(1)}s\n`);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }).catch((e) => {
    process.stderr.write(`triage failed [internal] ${e.stack || e.message}\n`);
    process.exitCode = 2;
  });
}
