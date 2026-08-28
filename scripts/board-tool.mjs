#!/usr/bin/env node
/**
 * board-tool.mjs — the board as a TOOL: query it, file a ticket, update a row,
 * and commit the result. FEAT-097.
 *
 * WHY THIS EXISTS. `docs/analysis/orchestrator-surface-retroactive-2026-08-20.md`
 * counted what an orchestrator session actually reached for over three days of
 * orchestrator-role work. The refusals under a dispatch-only profile were not a
 * long tail of ad-hoc shell: 63% of refused Bash calls were board and ticket
 * content, 25% were `board:gen`/`board:check`, 20% were `git add`/`commit`, and
 * 15 of the 22 refused Writes/Edits were ticket files and `INDEX.md`. One tool
 * that does all four verbs makes that cluster VANISH rather than relocate —
 * which is why `commit` is in scope. Without it, denying the shell does not
 * restrict the orchestrator, it makes the orchestrator non-compliant with its
 * own commit discipline.
 *
 * WHY IT ALSO RETIRES A DEFECT CLASS. `INDEX.md` has been maintained all day
 * with in-place `python3 - <<'PY'` heredocs. BUG-123 (a curated Status cell
 * flattened to four characters), BUG-127, BUG-128 and BUG-133 (an index rebuilt
 * from a partial set) are all failures of that mechanism. Nothing here edits
 * `INDEX.md` by string surgery: every row change goes through `genBoard()`,
 * which is the code that knows which columns are curated and preserves them by
 * id, and the one cell that exists nowhere else (Open.Owner) is written by
 * `setBoardOwner` in src/server/tickets.ts — one writer, not two.
 *
 * REUSE, NOT REIMPLEMENTATION. This file is orchestration and a CLI. Every rule
 * it applies is owned elsewhere and imported:
 *
 *   · what a valid ticket is        → `validateTicket`   (lib/ticket-schema.mjs)
 *   · how a record is serialized    → `formatTicket`     (lib/ticket-schema.mjs)
 *   · how a ticket file is read     → `parseTicket` / `extractTicketBlock`
 *   · which sections a body has     → `deriveBodySlots`  (lib/ticket-schema.mjs)
 *   · what a legacy Status word means → `classifyLegacyStatus`
 *   · what the board rows should be → `genBoard` / `checkBoard`   (board.mjs)
 *   · listing, search, id allocation, appending, the Owner cell, the freshness
 *     gate                          → src/server/tickets.ts
 *   · what must pass before a commit → scripts/gate.mjs, by its EXIT STATUS
 *
 * The one rule that had to move so it could be shared is `deriveBodySlots`: the
 * migration composed records and now so does this, and one loop in two files is
 * how two writers come to disagree. It moved INTO the schema module and
 * `migrate-tickets.mjs` calls it there. Nothing else is duplicated; if something
 * has to be, that is a finding to report, not a copy to make.
 *
 * SAFE FROM A RESTRICTED PROFILE. The interface takes no shell command and no
 * path — ever. Arguments are a verb, ticket ids (checked against the schema's own
 * id pattern), enum values (checked against the schema's own enums), free text
 * that is only ever written into a ticket field, and a commit message. Every path
 * it touches is derived internally from the board directory; a caller cannot name
 * one, cannot escape `docs/bugs/`, and cannot stage a file outside it.
 * `--ids` is REQUIRED on `commit`, so the tool has no "commit whatever is dirty"
 * mode at all — the `git add -A` hazard that swept BUG-004's uncommitted code
 * into an unrelated commit cannot be expressed here.
 *
 * REFUSALS RETURN A REASON, NOT A DIAGNOSIS. A ticket that fails `validateTicket`
 * is not written and the violations come back as data. A commit whose gate is red
 * does not happen and the gate's own failing lines come back as data. Nothing is
 * summarised into prose for the caller to re-interpret.
 *
 * USAGE (all output is JSON on stdout; exit 0 = ok, 1 = refused/failed, 2 = usage)
 *
 *   node scripts/board-tool.mjs query   [--id=BUG-133] [--state=open,blocked]
 *                                       [--section=open|done] [--owner=you|agent|unassigned]
 *                                       [--type=bug|feature|architecture|deploy]
 *                                       [--severity=low|medium|high] [--text=…]
 *                                       [--limit=50] [--include-body]
 *   node scripts/board-tool.mjs check
 *   node scripts/board-tool.mjs reconcile
 *   node scripts/board-tool.mjs file    --json='{"type":"bug","title":…,"body":"…"}'
 *   node scripts/board-tool.mjs update  --id=BUG-133 [--work-state=…] [--severity=…]
 *                                       [--owner=…] [--human-action=…] [--current-need=…]
 *                                       [--status-line='FIXED — …']   (legacy tickets)
 *                                       [--log='what happened'] [--log-author=…] [--log-label=…]
 *                                       [--rev=<token>]
 *   node scripts/board-tool.mjs commit  --ids=BUG-133,FEAT-097 --message='…'
 *
 * The board directory is this repo's own `docs/bugs/`. `ORCHARD_BOARD_TOOL_ROOT`
 * re-points it and exists FOR THE TEST SUITE, which drives every verb against a
 * scratch copy of the real board in a scratch git repo. It is not a hole in the
 * profile property: setting an environment variable requires a shell, which is
 * the thing the profile denies, and the allowlisted invocation is a fixed argv.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  TICKET_TYPES, WORK_STATES, SEVERITIES, HUMAN_ACTIONS, OWNERS, TICKET_ID_RE,
  parseTicket, validateTicket, formatTicket, extractTicketBlock, deriveBodySlots,
  classifyLegacyStatus, statusIssue, typeFromId,
} from './lib/ticket-schema.mjs';
import { genBoard, checkBoard, decisionShapeFails, reachabilityFails } from './board.mjs';
// FEAT-106 — resolve the board dir (docs/bugs legacy / .orchard/bugs flat) for
// whatever root the tool is pointed at; ORCHARD_BOARD_TOOL_ROOT semantics are
// unchanged (it still names the host, the resolver just finds the board under it).
import { resolveBoardDir } from './lib/board-path.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/** 👤 / 🤖 — the two glyphs the Needs-You rail reads out of the Owner cell. */
const NEEDS_YOU = '\u{1F464}';
const IN_FLIGHT = '\u{1F916}';

const TODAY = () => new Date().toISOString().slice(0, 10);

/* ────────────────────────────────────────────────────────── the ticket API */

/**
 * src/server/tickets.ts, loaded lazily and by name. It is the existing owner of
 * listing, search, id allocation, the append-only writer, the freshness gate and
 * the Owner cell; this tool adds no second implementation of any of them.
 *
 * Dynamic, like board.mjs's own ride-alongs, so the failure when it is absent is
 * a sentence rather than a stack trace.
 */
let TICKETS = null;
async function ticketsApi() {
  if (TICKETS) return TICKETS;
  const mod = path.resolve(DEFAULT_ROOT, 'src', 'server', 'tickets.ts');
  if (!fs.existsSync(mod)) {
    throw new Refusal('no-ticket-api', `src/server/tickets.ts is not present at ${path.relative(DEFAULT_ROOT, mod)} — this tool is Orchard's, not a copied board tool`);
  }
  TICKETS = await import(url.pathToFileURL(mod).href);
  return TICKETS;
}

/**
 * The private-token detector, loaded lazily and by name — the SAME token list
 * the commit-time leak-gate uses (scripts/lib/leak-tokens.mjs), never a second
 * matcher. This is the authoring-time half of the defence: a ticket carrying a
 * home path, username or private project name is REFUSED before it is written,
 * so the leak never reaches a public-bound file (this board is public; a leaked
 * path is an exposure the moment it is pushed, and the recovery is a history
 * rewrite — BUG-155, BUG-156). Detection at commit already worked; what was
 * missing was a stop at the moment of writing.
 *
 * FAIL CLOSED: if the detector module is absent this REFUSES the write rather
 * than writing unscanned. board-tool.mjs runs only in Orchard's own tree, where
 * the module is always present; a missing one means a broken checkout, not a
 * reason to ship a ticket past no guard.
 */
let LEAK = null;
async function leakScanner() {
  if (LEAK) return LEAK;
  const mod = path.resolve(HERE, 'lib', 'leak-tokens.mjs');
  if (!fs.existsSync(mod)) {
    throw new Refusal('no-leak-detector', `scripts/lib/leak-tokens.mjs is not present at ${path.relative(DEFAULT_ROOT, mod)} — refusing to write a ticket that was never scanned for private tokens`);
  }
  LEAK = await import(url.pathToFileURL(mod).href);
  return LEAK;
}

/**
 * Refuse a ticket write whose content carries a private token. `fields` is a
 * list of `{ label, text }` — only the free text the caller is INTRODUCING, so
 * a pre-existing leak in an untouched body never blocks an unrelated update.
 * The offending line + token class come back as data (the gate's own shape), so
 * the author can redact — path → `~`, private project → a neutral description —
 * and retry. Legitimate discussion of a token SHAPE does not trip this: the
 * detector matches literal values, and the convention (used by leak-tokens.mjs
 * on itself) is to describe the shape or split the literal, never paste it —
 * exactly what the commit-time gate already requires, moved one step earlier.
 */
async function assertNoLeak(fields, where) {
  const { findLeaks } = await leakScanner();
  const hits = [];
  for (const { label, text } of fields) {
    if (!text) continue;
    for (const h of findLeaks(text)) {
      const at = h.lineNo > 1 ? `${label} (line ${h.lineNo})` : label;
      hits.push(`${at}: [${h.token}] ${h.line.trim().slice(0, 160)}`);
    }
  }
  if (hits.length) {
    throw new Refusal(
      'private-token-leak',
      `${where}: ${hits.length} private-token hit(s) — this board is public, so nothing was written. Redact home paths to \`~\`, name private projects neutrally, keep the facts, and retry.`,
      hits,
    );
  }
}

/** A refusal the caller should READ, not a crash. Carries a machine code. */
class Refusal extends Error {
  constructor(code, message, detail = []) {
    super(message);
    this.code = code;
    this.detail = Array.isArray(detail) ? detail : [detail];
  }
}

/* ─────────────────────────────────────────────────────────── argument shapes */

/**
 * `--flag=value` only. An argument this tool does not understand is REJECTED
 * rather than ignored — board.mjs learned that the hard way: it used to accept a
 * bare path, silently check `docs/bugs` instead, and print `OK — no drift` about
 * a board the caller never asked about.
 */
function parseArgs(argv) {
  const verb = argv[0] ?? '';
  const flags = new Map();
  const unknown = [];
  for (const a of argv.slice(1)) {
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(a);
    if (!m) { unknown.push(a); continue; }
    flags.set(m[1], m[2] === undefined ? 'true' : m[2]);
  }
  return { verb, flags, unknown };
}

function assertKnownFlags(flags, allowed, verb) {
  const bad = [...flags.keys()].filter((k) => !allowed.includes(k));
  if (bad.length) {
    throw new Refusal(
      'unknown-flag',
      `${verb}: unrecognised flag(s): ${bad.map((b) => `--${b}`).join(' ')}`,
      [`${verb} accepts: ${allowed.map((a) => `--${a}`).join(' ')}`],
    );
  }
}

/** A ticket id, or a refusal naming what one looks like. No path can be one. */
function assertId(raw, where = 'id') {
  const id = String(raw ?? '').trim().toUpperCase();
  if (!TICKET_ID_RE.test(id)) {
    throw new Refusal('bad-id', `${where} ${JSON.stringify(raw)} is not a ticket id (expected ${TICKET_ID_RE.source})`);
  }
  return id;
}

function assertEnum(value, set, where) {
  const v = String(value ?? '').trim();
  if (!set.includes(v)) {
    throw new Refusal('bad-value', `${where} is ${JSON.stringify(value)} — must be one of ${set.join(' | ')}`);
  }
  return v;
}

function csv(raw) {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/* ─────────────────────────────────────────────────────────────────── reading */

function boardDirOf(root) {
  return resolveBoardDir(root);
}

/** Repo-relative, always. An absolute home path in output is a leak-gate hit. */
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/** The Owner CELL (a glyph) as the record's own vocabulary. '' ⇒ no Open row. */
function ownerOfCell(cell) {
  const c = String(cell ?? '');
  if (c.includes(NEEDS_YOU)) return 'you';
  if (c.includes(IN_FLIGHT)) return 'agent';
  return c.trim() ? 'unassigned' : null;
}

/** The stable public shape of one ticket. Fields, not prose. */
function publicTicket(root, t) {
  return {
    id: t.id,
    type: typeFromId(t.id),
    title: t.title,
    section: t.section,
    work_state: t.workState,
    done: t.section === 'done',
    owner: ownerOfCell(t.owner),
    severity: t.sev || null,
    area: t.area || null,
    status: t.status,
    board_status: t.boardStatus,
    updated: t.lastActivity,
    file: rel(root, t.file),
    rev: t.rev,
    // The loud channel rides along, exactly as it does for every other consumer:
    // a ticket whose state could not be read must never be reported as if it was.
    status_error: t.statusError,
    status_warning: t.statusWarning,
  };
}

/* ───────────────────────────────────────────────────────────────────── query */

const QUERY_FLAGS = ['id', 'ids', 'state', 'section', 'owner', 'type', 'severity', 'text', 'limit', 'include-body'];

async function verbQuery(root, flags) {
  assertKnownFlags(flags, QUERY_FLAGS, 'query');
  const { listTickets, searchTickets, readTicket } = await ticketsApi();

  const text = flags.get('text');
  const base = text ? searchTickets(root, text).hits : listTickets(root).tickets;

  const ids = [...csv(flags.get('id') ?? ''), ...csv(flags.get('ids') ?? '')].map((i) => assertId(i));
  const states = csv(flags.get('state') ?? '').map((s) => assertEnum(s, WORK_STATES, '--state'));
  const section = flags.has('section') ? assertEnum(flags.get('section'), ['open', 'done'], '--section') : null;
  const owner = flags.has('owner') ? assertEnum(flags.get('owner'), OWNERS, '--owner') : null;
  const type = flags.has('type') ? assertEnum(flags.get('type'), TICKET_TYPES, '--type') : null;
  const severity = flags.has('severity') ? assertEnum(flags.get('severity'), ['low', 'medium', 'high', 'med'], '--severity') : null;

  let hits = base.filter((t) => {
    if (ids.length && !ids.includes(t.id)) return false;
    if (states.length && !states.includes(t.workState)) return false;
    if (section && t.section !== section) return false;
    if (owner && ownerOfCell(t.owner) !== owner) return false;
    if (type && typeFromId(t.id) !== type) return false;
    // The board writes `med`, the record writes `medium`; compare on the prefix
    // rather than teaching this file a third severity vocabulary.
    if (severity && !String(t.sev || '').toLowerCase().startsWith(severity.slice(0, 3))) return false;
    return true;
  });

  const total = hits.length;
  const limit = flags.has('limit') ? Math.max(1, Math.min(500, Number(flags.get('limit')) || 50)) : 50;
  hits = hits.slice(0, limit);

  const includeBody = flags.get('include-body') === 'true';
  const tickets = hits.map((t) => {
    const out = publicTicket(root, t);
    if (text) {
      out.match_count = t.matchCount;
      out.matched_in = Object.entries(t.where).filter(([, v]) => v).map(([k]) => k);
      out.matches = t.matches;
    }
    if (includeBody) {
      const detail = readTicket(root, t.id);
      const parsed = parseTicket(detail.markdown, { file: path.basename(detail.file), mode: 'auto' });
      out.format = parsed.format;
      out.record = parsed.format === 'block' ? parsed.record : null;
      out.markdown = detail.markdown;
    }
    return out;
  });

  return { verb: 'query', total, returned: tickets.length, truncated: total > tickets.length, tickets };
}

/* ──────────────────────────────────────────────────────────── check/reconcile */

/**
 * The board's health, as `npm run board:check` computes it: the drift check PLUS
 * both ride-alongs. Running only `checkBoard` here would let this tool call a
 * board clean that the project's own command calls broken — and then commit it.
 * (`docs:fresh` is deliberately left out: it is advisory about guide docs, not
 * about the board, and it never fails board:check's own exit either.)
 */
/**
 * @param {{ warns?: 'full' | 'summary' }} [opts]
 *   `summary` returns a COUNT instead of the list. Used by `file` and `update`,
 *   whose answer is "did my write land". The board currently carries ~87
 *   standing advisory warnings, none of which are about the ticket just
 *   written; printing all of them pushed the one line the caller needs —
 *   `"ok": true` — off the top of the output, and a result nobody can find is
 *   a result nobody reads. FAILS are never summarised: they are few, they are
 *   blocking, and they are the reason to look.
 */
async function boardReport(root, opts = {}) {
  const dir = boardDirOf(root);
  const r = checkBoard(dir);
  const fails = [...r.fails, ...(await reachabilityFails(dir)), ...(await decisionShapeFails(dir))];
  const base = { ticket_count: r.ticketCount, clean: fails.length === 0, fails };
  if (opts.warns === 'summary') {
    return {
      ...base,
      warn_count: r.warns.length,
      warns_note: r.warns.length
        ? `${r.warns.length} standing advisory warning(s) on the board, not necessarily about this ticket — run \`npm run board:tool check\` to read them`
        : null,
    };
  }
  return { ...base, warns: r.warns };
}

async function verbCheck(root, flags) {
  assertKnownFlags(flags, [], 'check');
  return { verb: 'check', board: await boardReport(root) };
}

async function verbReconcile(root, flags) {
  assertKnownFlags(flags, [], 'reconcile');
  const dir = boardDirOf(root);
  const before = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  genBoard(dir);
  const after = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  return { verb: 'reconcile', index_changed: before !== after, board: await boardReport(root) };
}

/* ──────────────────────────────────────────────────────────────────── filing */

const FILE_FLAGS = ['json'];

/**
 * The keys this tool fills in when the caller does not, and the reason each one
 * is safe to fill: it is mechanical (an id, today's date), or it is the explicit
 * empty (the schema's rule is that absence is stated, never omitted).
 *
 * NOTHING ELSE IS DEFAULTED. A missing `severity`, `summary`, `impact_if_we_wait`
 * or `current_need` is refused by `validateTicket` with its own words. Guessing a
 * severity would be inventing a claim, and the whole point of the schema is that
 * the record says what somebody actually asserted.
 */
function fillDefaults(record, { id, body }) {
  const out = { ...record };
  const defaulted = [];
  const put = (k, v) => { if (out[k] === undefined) { out[k] = v; defaulted.push(k); } };
  out.id = id;
  put('type', typeFromId(id));
  put('reported', TODAY());
  put('updated', TODAY());
  put('reported_by', 'agent');
  put('owner', 'unassigned');
  put('work_state', 'open');
  put('human_action', 'none');
  put('decision', null);
  put('decision_history', []);
  put('code_refs', []);
  put('related', []);
  put('recurrence_evidence', []);
  put('verification', []);
  // Derived from the body by the schema's own rule, never asserted by a caller —
  // so `body_slots` cannot claim an Activity log the file does not have.
  out.body_slots = deriveBodySlots(body);
  const src = out.source && typeof out.source === 'object' && !Array.isArray(out.source) ? out.source : {};
  out.source = {
    archived_path: src.archived_path ?? null,
    sha256: src.sha256 ?? null,
    original_title: src.original_title ?? null,
    migrated_on: src.migrated_on ?? null,
    migrated_by: src.migrated_by ?? null,
    confirmation: src.confirmation ?? 'Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.',
    dropped: Array.isArray(src.dropped) ? src.dropped : [],
  };
  delete out.body;
  return { record: out, defaulted };
}

/**
 * The body a filed ticket gets. The caller's markdown is kept verbatim; the H1
 * and an Activity log are added only when they are absent, because a ticket
 * without an append-only log is not a ticket on this board (docs/bugs/README.md)
 * and a placeholder entry in one is a lie waiting to be inherited.
 */
function composeBody(id, title, raw, author) {
  const given = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const parts = [];
  if (!/^#\s/.test(given)) parts.push(`# ${id} — ${title}`);
  if (given) parts.push(given);
  let body = `\n${parts.join('\n\n')}\n`;
  if (!/^## Activity log\b/m.test(body)) {
    body += '\n## Activity log (APPEND-ONLY — never edit or delete a prior entry)\n\n'
      + `### ${TODAY()} — ${author}\n`
      + '- **Filed:** through the board tool; the record was validated before it was written.\n';
  }
  return body;
}

async function verbFile(root, flags) {
  assertKnownFlags(flags, FILE_FLAGS, 'file');
  if (!flags.has('json')) throw new Refusal('missing-arg', 'file: --json=<the ticket record, as JSON> is required');
  let input;
  try {
    input = JSON.parse(flags.get('json'));
  } catch (err) {
    throw new Refusal('bad-json', `file: --json is not valid JSON — ${err.message}`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Refusal('bad-json', 'file: --json must be a JSON object (the ticket record)');
  }

  const { nextTicketId, slugify, currentRev } = await ticketsApi();
  const type = input.type ?? (input.id ? typeFromId(input.id) : null);
  if (!TICKET_TYPES.includes(type)) {
    throw new Refusal('bad-value', `file: "type" is ${JSON.stringify(input.type)} — must be one of ${TICKET_TYPES.join(' | ')}`);
  }
  const prefix = { bug: 'BUG', feature: 'FEAT', architecture: 'ARCH', deploy: 'DEPLOY' }[type];
  // The id is ALLOCATED, never accepted: two agents filing at once must not be
  // able to agree on a number, and a caller-chosen id is how BUG-133/BUG-134
  // collided in the first place.
  const id = nextTicketId(root, prefix);
  const title = String(input.title ?? '').trim();

  const body = composeBody(id, title || id, input.body, input.reported_by ?? 'agent');
  const { record, defaulted } = fillDefaults(input, { id, body });

  const dir = boardDirOf(root);
  const file = path.join(dir, `${id}-${slugify(title || id)}.md`);
  const base = path.basename(file);

  // THE REFUSAL. Validated BEFORE anything is written, against the one validator,
  // and the violations are returned as data — not a diagnosis to interpret.
  const v = validateTicket(record, { file: base });
  if (!v.ok) {
    throw new Refusal('invalid-ticket', `file: the record fails validateTicket (${v.violations.length} violation(s)) — nothing was written`, v.violations);
  }
  if (fs.existsSync(file)) throw new Refusal('exists', `file: refusing to overwrite ${rel(root, file)}`);

  // THE LEAK REFUSAL. Scan the FULLY-rendered ticket (every byte headed for this
  // public-bound file) against the shared leak-gate token list, before the write.
  const content = formatTicket(record, body);
  await assertNoLeak([{ label: `${base} content`, text: content }], `file ${id}`);
  fs.writeFileSync(file, content, { flag: 'wx' });

  // The row is PLACED by the board tool, which is the code that knows which
  // columns are curated. No string surgery on INDEX.md happens anywhere here.
  genBoard(dir);
  const board = await boardReport(root, { warns: 'summary' });
  const row = indexRowOf(root, id);
  return {
    verb: 'file', id, file: rel(root, file), rev: currentRev(file),
    defaulted, index_row: row, board,
  };
}

/** The ticket's current Open/Done row, verbatim, so a caller can see what landed. */
function indexRowOf(root, id) {
  const text = fs.readFileSync(path.join(boardDirOf(root), 'INDEX.md'), 'utf8');
  const hit = text.split('\n').find((l) => l.trimStart().startsWith(`| ${id} |`));
  return hit ?? null;
}

/* ────────────────────────────────────────────────────────────────── updating */

const UPDATE_FLAGS = [
  'id', 'work-state', 'status-line', 'severity', 'owner', 'human-action',
  'current-need', 'log', 'log-author', 'log-label', 'rev',
];

/** Record fields this tool will set, and the enum each is checked against. */
const RECORD_SETTERS = {
  'work-state': { key: 'work_state', enum: WORK_STATES },
  severity: { key: 'severity', enum: SEVERITIES },
  'human-action': { key: 'human_action', enum: HUMAN_ACTIONS },
  'current-need': { key: 'current_need', enum: null },
  owner: { key: 'owner', enum: OWNERS },
};

async function verbUpdate(root, flags) {
  assertKnownFlags(flags, UPDATE_FLAGS, 'update');
  const api = await ticketsApi();
  const { readTicket, appendNote, setBoardOwner, assertFresh, currentRev, TicketError } = api;
  const id = assertId(flags.get('id'), '--id');

  const touched = [];
  const detail = readTicket(root, id); // throws TicketError(404) if there is none
  const file = detail.file;
  const base = path.basename(file);
  // Optimistic concurrency for the CALLER: if they read the ticket and it moved
  // underneath them, the whole update is refused before any part of it lands.
  if (flags.has('rev')) assertFresh(file, flags.get('rev'));

  // THE LEAK REFUSAL. Only the free text this update INTRODUCES is scanned — a
  // pre-existing leak in the untouched body must not block an unrelated update
  // (and is caught by the commit-time gate regardless). Enum fields cannot leak.
  await assertNoLeak([
    { label: '--log', text: flags.get('log') },
    { label: '--status-line', text: flags.get('status-line') },
    { label: '--current-need', text: flags.get('current-need') },
  ], `update ${id}`);

  const wantsRecordChange = [...Object.keys(RECORD_SETTERS)].some((f) => flags.has(f) && f !== 'owner');
  const parsed = parseTicket(detail.markdown, { file: base, mode: 'auto' });

  let record = null;
  let violations = null;

  if (parsed.format === 'block') {
    if (wantsRecordChange || flags.has('owner')) {
      record = { ...parsed.record };
      for (const [flag, spec] of Object.entries(RECORD_SETTERS)) {
        if (!flags.has(flag)) continue;
        const raw = flags.get(flag);
        record[spec.key] = spec.enum ? assertEnum(raw, spec.enum, `--${flag}`) : String(raw);
      }
      record.updated = TODAY();
      const v = validateTicket(record, { file: base });
      if (!v.ok) {
        throw new Refusal(
          'invalid-ticket',
          `update: ${id} would fail validateTicket after this change (${v.violations.length} violation(s)) — nothing was written`,
          v.violations,
        );
      }
      violations = [];
      // The BODY is carried across byte-for-byte: only the leading record block is
      // re-serialized. An append-only log cannot be touched by an update, by
      // construction rather than by care.
      const { body } = extractTicketBlock(detail.markdown);
      const next = formatTicket(record, body);
      const revNow = currentRev(file);
      assertFresh(file, revNow); // as late as physically possible
      fs.writeFileSync(file, next);
      touched.push('record');
    }
    if (flags.has('status-line')) {
      throw new Refusal('not-applicable', `update: ${id} carries a ticket record — set its state with --work-state; --status-line is for a legacy prose ticket`);
    }
  } else {
    // LEGACY (prose) ticket. Its `- **Status:**` line is a human's curated
    // sentence — BUG-123 is what happens when a tool paraphrases one — so this
    // tool will not compose one. The caller supplies the whole line, and the
    // schema's own classifier checks it says what they claim it says.
    if (wantsRecordChange && !flags.has('status-line')) {
      throw new Refusal(
        'legacy-ticket',
        `update: ${id} is a legacy prose ticket with no record to set fields on`,
        [
          'Its state lives in a curated `- **Status:**` sentence, and this tool does not paraphrase one (BUG-123).',
          'Pass the whole replacement line as --status-line=\'FIXED — what actually changed.\', optionally with',
          '--work-state=<state> to assert what that line means; the leading word is classified and must agree.',
        ],
      );
    }
    if (flags.has('status-line')) {
      const line = String(flags.get('status-line')).replace(/\r?\n/g, ' ').trim();
      const cls = classifyLegacyStatus(line);
      if (!cls.matched) {
        // The sentence the schema already writes for exactly this condition,
        // including the list of words a human types. Not a second wording.
        throw new Refusal('unclassifiable-status', `update: ${id} — the supplied status line was not written`, [statusIssue(base, true, cls)]);
      }
      if (flags.has('work-state')) {
        const want = assertEnum(flags.get('work-state'), WORK_STATES, '--work-state');
        if (cls.workState !== want) {
          throw new Refusal('status-disagrees', `update: --work-state=${want} but the supplied status line classifies as ${cls.workState} — nothing was written`);
        }
      }
      const before = fs.readFileSync(file, 'utf8');
      if (!/^- \*\*Status:\*\*.*$/m.test(before)) {
        throw new Refusal('no-status-line', `update: ${id} has no "- **Status:**" line to replace`);
      }
      const next = before.replace(/^- \*\*Status:\*\*.*$/m, `- **Status:** ${line}`);
      const revNow = currentRev(file);
      assertFresh(file, revNow);
      fs.writeFileSync(file, next);
      touched.push('status-line');
    }
    if (flags.has('severity') || flags.has('human-action') || flags.has('current-need')) {
      throw new Refusal('legacy-ticket', `update: ${id} is a legacy prose ticket — only --status-line, --owner and --log apply to it`);
    }
  }

  // The append-only log, through the ONE appender (freshness-gated, appendFileSync
  // at EOF — a prior entry cannot be rewritten even by a concurrent writer).
  let appended = null;
  if (flags.has('log')) {
    const r = appendNote(root, id, flags.get('log'), currentRev(file), {
      author: flags.get('log-author') || 'board tool',
      label: flags.get('log-label') || 'Note',
    });
    appended = r.appended;
    touched.push('log');
  }

  // The curated Owner cell — the one column that exists nowhere but INDEX.md,
  // written by tickets.ts's single writer and handed straight back to genBoard.
  let ownerCell = null;
  if (flags.has('owner')) {
    const want = assertEnum(flags.get('owner'), OWNERS, '--owner');
    try {
      ownerCell = setBoardOwner(root, id, want).owner;
      touched.push('owner');
    } catch (err) {
      if (err instanceof TicketError) throw new Refusal('no-open-row', `update: ${err.message}`);
      throw err;
    }
  }

  if (!touched.length) {
    throw new Refusal('nothing-to-do', `update: ${id} — no field was given. Pass at least one of ${UPDATE_FLAGS.filter((f) => f !== 'id' && f !== 'rev').map((f) => `--${f}`).join(' ')}`);
  }

  genBoard(boardDirOf(root));
  return {
    verb: 'update', id, file: rel(root, file), rev: currentRev(file),
    format: parsed.format, touched, appended, owner_cell: ownerCell,
    violations, index_row: indexRowOf(root, id), board: await boardReport(root, { warns: 'summary' }),
  };
}

/* ─────────────────────────────────────────────────────────────── committing */

const COMMIT_FLAGS = ['ids', 'message'];

/**
 * `stdout` is RAW, deliberately. `git status --porcelain` puts the two status
 * columns in the first two characters, so a leading space is DATA: trimming the
 * output turned ` M docs/bugs/X.md` into `M docs/bugs/X.md`, and the fixed-width
 * slice below then reported the file as `ocs/bugs/X.md`. Callers that want a
 * single token trim that token, not the stream.
 */
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

/**
 * The gate, by its EXIT STATUS (BUG-102). `npm run gate` IS scripts/gate.mjs;
 * it is spawned directly and `status` is read off the child — there is no shell,
 * so there is no pipeline whose last command could mask a failure. This is the
 * clause that makes the whole tool honest: a red gate returns the gate's own
 * failing lines and no commit happens.
 */
function runGate(root) {
  const gate = path.join(root, 'scripts', 'gate.mjs');
  if (!fs.existsSync(gate)) {
    return { ran: false, ok: false, status: null, output: `no gate at ${rel(root, gate)} — refusing to commit without one` };
  }
  const r = spawnSync(process.execPath, [gate], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ran: true, ok: r.status === 0, status: r.status, output: ((r.stdout || '') + (r.stderr || '')).trim() };
}

async function verbCommit(root, flags) {
  assertKnownFlags(flags, COMMIT_FLAGS, 'commit');
  const message = String(flags.get('message') ?? '').trim();
  if (!message) throw new Refusal('missing-arg', 'commit: --message=<what this change is> is required');
  const idsRaw = csv(flags.get('ids') ?? '');
  if (!idsRaw.length) {
    throw new Refusal('missing-arg', 'commit: --ids=<the tickets this commit is about> is required', [
      'There is deliberately no "commit whatever is dirty" mode. An explicit file list is the rule',
      '(WA §J), and a blanket stage once swept BUG-004\'s uncommitted code into an unrelated commit.',
    ]);
  }
  const ids = idsRaw.map((i) => assertId(i, '--ids'));

  const { readTicket } = await ticketsApi();
  const dir = boardDirOf(root);

  // 1. The board owns its own rows: reconcile BEFORE checking, so the row this
  //    commit carries is the derived one rather than whatever was left behind.
  genBoard(dir);
  const board = await boardReport(root);
  if (!board.clean) {
    throw new Refusal('board-drift', `commit: the board has ${board.fails.length} drift problem(s) — refusing to commit a broken board`, board.fails);
  }

  // 2. The paths. Derived from the ids, never accepted from the caller, and
  //    asserted to sit inside docs/bugs/ before anything is staged.
  const wanted = [path.join(dir, 'INDEX.md')];
  for (const id of ids) wanted.push(readTicket(root, id).file);
  for (const p of wanted) {
    if (!path.resolve(p).startsWith(path.resolve(dir) + path.sep)) {
      throw new Refusal('path-escape', `commit: ${rel(root, p)} is outside the board directory — refusing`);
    }
  }

  const status = git(root, ['status', '--porcelain', '--', dir]);
  if (status.status !== 0) throw new Refusal('git-failed', `commit: git status failed — ${status.stderr}`);
  const dirty = new Set(
    status.stdout.split('\n').filter((l) => l.length > 3)
      // `XY <path>` — the path starts at column 3. A rename reads `R  old -> new`;
      // only the destination is a path this tool could have written.
      .map((l) => l.slice(3).replace(/^.* -> /, '').trim().replace(/^"|"$/g, ''))
      .map((p) => path.resolve(root, p)),
  );
  const staged = wanted.filter((p) => dirty.has(path.resolve(p))).map((p) => rel(root, p));
  const leftBehind = [...dirty].filter((p) => !wanted.some((w) => path.resolve(w) === p)).map((p) => rel(root, p));
  if (!staged.length) {
    throw new Refusal('nothing-to-commit', 'commit: none of the named tickets (or INDEX.md) has an uncommitted change', [
      leftBehind.length ? `Other uncommitted board paths, left alone: ${leftBehind.join(', ')}` : 'The board directory is clean.',
    ]);
  }

  // 3. The gate. Exit status, read directly.
  const gate = runGate(root);
  if (!gate.ok) {
    throw new Refusal('gate-failed', `commit: the gate exited ${gate.status} — nothing was committed`, gate.output.split('\n'));
  }

  // 4. Stage the EXPLICIT list — never `-A`, never `.`. A newly filed ticket is
  //    untracked, and `git commit --only` refuses a pathspec git has never seen
  //    ("did not match any file(s) known to git"), so the add is what makes a new
  //    ticket committable at all. It names every path individually, so a
  //    concurrent lane's dirty files cannot ride along.
  const add = git(root, ['add', '--', ...staged]);
  if (add.status !== 0) throw new Refusal('git-failed', `commit: git add exited ${add.status}`, [add.stderr]);
  // `--only` with the same explicit list: whatever else happens to be in the
  // index is left in it, not committed.
  const c = git(root, ['commit', '--only', '-m', message, '--', ...staged]);
  if (c.status !== 0) {
    throw new Refusal('git-failed', `commit: git commit exited ${c.status}`, [c.stdout.trim(), c.stderr].filter(Boolean));
  }
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();

  return {
    verb: 'commit', commit: sha, message, staged,
    left_uncommitted: leftBehind,
    gate: { passed: true, status: gate.status },
    board,
  };
}

/* ────────────────────────────────────────────────────────────────────── CLI */

const VERBS = {
  query: verbQuery,
  check: verbCheck,
  reconcile: verbReconcile,
  file: verbFile,
  update: verbUpdate,
  commit: verbCommit,
};

/**
 * The programmatic entry point. Returns `{ ok, ... }` and NEVER throws for a
 * refusal — a caller in a restricted profile has no stderr to read, so the
 * reason has to be in the value.
 */
export async function boardTool(argv, opts = {}) {
  const root = path.resolve(opts.root || process.env.ORCHARD_BOARD_TOOL_ROOT || DEFAULT_ROOT);
  const { verb, flags, unknown } = parseArgs(argv);
  if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) {
    return {
      ok: false,
      refusal: {
        code: 'unknown-verb',
        message: verb ? `unknown verb ${JSON.stringify(verb)}` : 'no verb given',
        detail: [`verbs: ${Object.keys(VERBS).join(' | ')}`],
      },
    };
  }
  if (unknown.length) {
    return {
      ok: false,
      refusal: {
        code: 'bad-argument',
        message: `${verb}: arguments must be --flag=value; got ${unknown.map((u) => JSON.stringify(u)).join(' ')}`,
        detail: ['This tool takes no positional arguments, no paths and no shell commands.'],
      },
    };
  }
  try {
    const out = await VERBS[verb](root, flags);
    return { ok: true, ...out };
  } catch (err) {
    if (err instanceof Refusal) {
      return { ok: false, verb, refusal: { code: err.code, message: err.message, detail: err.detail } };
    }
    // A TicketError carries its own status (404 no such ticket, 409 the file moved
    // under us). It is a refusal too, and its message is already the reason.
    if (err && typeof err.status === 'number' && typeof err.message === 'string') {
      return { ok: false, verb, refusal: { code: `ticket-${err.status}`, message: err.message, detail: err.rev ? [`current rev: ${err.rev}`] : [] } };
    }
    return { ok: false, verb, refusal: { code: 'error', message: String(err?.message ?? err), detail: [] } };
  }
}

async function main() {
  const out = await boardTool(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : (out.refusal?.code === 'unknown-verb' || out.refusal?.code === 'bad-argument' ? 2 : 1));
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

export { Refusal, ownerOfCell, composeBody, fillDefaults };
