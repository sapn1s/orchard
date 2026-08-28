/**
 * Project board reader for the "Needs You" rail (FEAT-018, scoped first cut).
 *
 * The board is the opt-in, per-project `docs/bugs/` directory described in
 * docs/bugs/README.md: an INDEX.md table plus one append-only ticket file per
 * issue. This module is a READ-ONLY aggregator over those files (the answer
 * append is the one write, and it is append-only — see `appendAnswer`).
 *
 * Source of truth stays on disk. A project without `docs/bugs/` simply has no
 * board — that is NOT an error, it is the honest "nothing needs you" state, so
 * `readBoard` returns an empty board with `hasBoard:false` rather than throwing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
// ONE definition of the ticket format (plan §3 / §8 step 2): board.ts was the
// fourth H1 parser and the third INDEX-row splitter.
import { indexRowCells, parseTicket, parseTitleLine } from '../../scripts/lib/ticket-schema.mjs';
// FEAT-106 — one resolver decides where a project keeps its board, whether that
// project is on the legacy `docs/bugs` layout or the consolidated `.orchard/`
// one. boardDir() below is the single door every reader here comes through
// (readBoard, the .arch findings/acks paths, the launch snapshot), so routing it
// through the resolver moves them all at once. For Orchard's own repo (no
// `.orchard/`) the resolver falls through to `docs/bugs` by construction.
import { resolveBoardDir } from '../../scripts/lib/board-path.mjs';
// FEAT-095 — the ordering rule, kept out of this file because it is a policy
// (what is a ticket worth answering?) over a parser (what does INDEX.md say?).
import { rankLane, rankRows } from './board-rank.ts';

export interface BoardItem {
  id: string;
  title: string;
  owner: string;   // the raw Owner cell (may hold 👤 / 🤖 / — )
  status: string;
  sev: string;
  /**
   * What kind of Needs-You card this is. 'ticket' = a 👤 row parsed from the
   * board's INDEX.md (the FEAT-018 source); 'decision' = a record a running
   * session RAISED at runtime (FEAT-029). The rail answer route uses this to
   * decide whether to append to a ticket file or route back to the raising
   * session. Absent === 'ticket' for older callers.
   */
  /*
   * BUG-046 adds 'stall': a running work row whose evidence stopped progressing
   * past the escalation window (stalls.ts). Advisory + read-only, computed from
   * the live running set on every board read — never persisted, so recovery
   * clears the card without residue. It carries no `question` (BUG-025
   * status-row semantics) and names no ticket file.
   */
  kind?: 'ticket' | 'decision' | 'finding' | 'stall';
  /**
   * The actual ASK. For a runtime decision (kind:'decision') this mirrors
   * `title`. For a 👤 ticket it is populated ONLY when the ticket carries an
   * explicit `## Question` section (BUG-025) — a bare 👤 ticket with no such
   * section has NO `question`, and the rail must render it as read-only board
   * status, not an answer box.
   */
  question?: string;
  /** Optional multiple-choice options (buttons), from a decision or a `## Question` block's bullets. */
  options?: string[];
  /**
   * FEAT-082 — the option KEY this ticket recommends (from the ticket's decision,
   * validated against the parsed option keys — a `Recommended:` value that matches
   * no option is dropped, never surfaced). Populated only for a needs-you item that
   * carries a decision with a valid recommendation, so the landing screen can badge
   * the recommended choice WITHOUT re-parsing the ticket markdown. Absent otherwise.
   */
  recommended?: string;
  /**
   * FEAT-082 (visual review) — true when `question` is NOT the ticket's own words
   * but a fallback to its title, because the decision heading carried no content
   * of its own (`## The decision`). A renderer that already shows the title must
   * NOT then repeat it as the question: showing "The decision" (or the title
   * twice) presents scaffolding as if it were the thing to decide. See
   * `ticketDecision` for why the question is never left empty.
   */
  questionFromTitle?: boolean;
  /**
   * FEAT-090, `answeredAwaiting` items ONLY: the user's chosen answer text and the
   * date it was recorded, lifted from the ticket's last answer entry so the launch
   * snapshot can state WHAT was decided and WHEN without a second parse. Absent on
   * every other kind of row.
   */
  answer?: string;
  answeredOn?: string;
  /** Absolute path to the ticket file, for a ticket-kind item (so a status row can link to it). */
  file?: string;
  /**
   * FEAT-047, kind:'finding' only: the finding's one-line evidence (where +
   * what), shown under the label. Findings are read-only attention rows (BUG-025
   * status-row semantics — they carry no `question`); the only affordance is a
   * dismiss (ack) recorded via `dismissConsolidationFinding`.
   */
  detail?: string;
  /**
   * FEAT-095 — where this row sorts, and WHY, both DERIVED on every read from
   * fields the ticket record already carries (`related[]`,
   * `recurrence_evidence[]`, `human_action`, `severity`). No new field, nothing
   * stored, nothing for a human to keep up to date — see board-rank.ts for the
   * weights and for the two graphs that were tried and rejected.
   *
   * `rank` is the score (higher sorts first). `rankWhy` is the checkable
   * sentence — "answering this settles 3 other open tickets: ARCH-005, …" — and
   * is ABSENT on a row that has nothing to claim, because a reason on every row
   * is a reason on none. `rankSettles` is the id list `rankWhy` summarises, so a
   * surface can link them instead of re-deriving.
   *
   * Runtime cards (kind 'decision'/'finding'/'stall') name no ticket file and
   * carry none of these; the route places them deliberately and ranking leaves
   * that placement alone.
   */
  rank?: number;
  rankWhy?: string;
  rankSettles?: string[];
  /**
   * FEAT-108 round 3 — present iff this decision card is a git-write PERMISSION
   * request (kind:'decision' raised via /git-write-request). The rail renders it
   * as a one-click Allow/Decline permission ask rather than a generic decision,
   * and approving it (answer "Allow") is what mints the runtime grant. Carries
   * the requested scope/window and the agent's reason so the user decides in
   * context. Absent on every other row.
   */
  gitWrite?: { scope: 'once' | 'duration'; minutes: number | null; reason: string } | null;
}
export interface Board {
  hasBoard: boolean;
  needsYou: BoardItem[];   // Open rows owned by 👤 — the interactive cards
  /**
   * FEAT-079 — the read-only OBSERVATIONS lane. Automated, non-actionable
   * findings (WA-consolidation FEAT-047, architecture-recurrence FEAT-056) that
   * used to be folded into `needsYou` live here instead: they are standing
   * attention, NOT asks, so they must not dilute the decision rail (WA §H — the
   * one thing the user must read: decisions, blockers, questions). Rendered as a
   * distinct, lower-priority read-only section (no response field); the one
   * affordance is Dismiss/ack. A finding is PROMOTED to `needsYou` only when it
   * carries a concrete ask (see the finding mappers' `question` seam). Optional
   * on the wire so older callers that never set it still typecheck. */
  observations?: BoardItem[];
  /**
   * FEAT-090 — the "answered, awaiting action" lane. A 👤 ticket whose Activity
   * log carries a user ANSWER entry with NOTHING dated appended after it: the
   * human is done deciding, but no agent has picked the work up yet. DERIVED, not
   * stored (BUG-041/074 doctrine — a stored flag would drift the moment an agent
   * edits the ticket outside the server): it is re-read from the log on every
   * board read. Such a ticket LEAVES `needsYou` (so the needs count keeps meaning
   * "still waiting on YOU") and lands here. The moment a dated entry is appended
   * after the answer (an agent note) OR INDEX flips the Owner to 🤖, the ticket
   * leaves this lane again. Optional on the wire so older callers still typecheck.
   */
  answeredAwaiting?: BoardItem[];
  inflight: BoardItem[];   // Open rows owned by 🤖 — read-only
  /**
   * FEAT-053 — the todo backlog: Open rows owned by NEITHER 👤 nor 🤖 (owner
   * `—`/queued). Filed for later, in flight nowhere, waiting on nobody.
   * Derived from the same INDEX.md walk as the other lists — one source, no
   * second parsing path. Read-only rows in the rail (BUG-025 semantics).
   */
  queued: BoardItem[];
  doneToday: BoardItem[];  // Done rows whose ticket file changed in the last 24h
  /**
   * FEAT-067 — the rail's status summary, DERIVED live from the (fully merged)
   * board by `boardSummary`. Attached by the board GET route AFTER every merge
   * (decisions/findings/stalls folded into needsYou) so it indexes exactly the
   * lists the rail renders. Optional: older callers / the injection path never
   * set it; it is never persisted (BUG-041/074 — an index must not go stale).
   */
  summary?: BoardSummary;
}

/**
 * FEAT-067 — the structured shape of the rail's top status summary card.
 * `focus` is the single highest-priority open item (or `null` on a clear
 * board); `counts` mirrors the board's list lengths so each becomes a chip that
 * scrolls to its existing rail section.
 *
 * `deployPending` is a DERIVED board FILTER (FEAT-067 fast-follow), not a new
 * stored field: the count of OPEN rows that are shipped-but-not-out — a `DEPLOY-*`
 * ticket, or any row whose status says needs-deploy / deploy-pending /
 * not-deployed. Derived here so it stays an honest index over the same lists.
 *
 * The "live" (live running-set) and "stopped" (agent outcomes) counts are NOT
 * here — they are sourced client-side from data already fetched on the rail
 * poll (the running-set snapshot / outcomes), so the card stays one honest index
 * over live surfaces rather than a second, drift-prone snapshot. "live" is the
 * TRUE count of processes running NOW and is DISTINCT from `inflight` (board
 * rows the INDEX marks 🤖) — two different truths, never conflated.
 */
export interface BoardSummary {
  focus: { id: string; title: string } | null;
  counts: { needs: number; observations: number; answered: number; queued: number; inflight: number; doneToday: number; deployPending: number };
}

const NEEDS_YOU = '\u{1F464}'; // 👤
const IN_FLIGHT = '\u{1F916}'; // 🤖
/** FEAT-018, BUG-004, DEPLOY-003, … */
const ID_RE = /^[A-Z]+-\d+$/;

export function boardDir(hostPath: string): string {
  return resolveBoardDir(hostPath);
}

/**
 * Split one markdown table row `| a | b | c |` into trimmed cells.
 * The splitter itself is shared (plan §3 retires the three copies of it); this
 * caller reads LENIENTLY — a half-written INDEX must still list its tickets.
 */
const cellsOf = (line: string): string[] => indexRowCells(line);

/**
 * The H1 title of a ticket file, if the file exists and has one.
 *
 * BUG-122 — a PROMOTED ticket's title is a field of its leading
 * ```orchard-ticket record, not an H1, so that record is asked first (through
 * the one shared reader, never a second parse of the fence). A ticket with no
 * record block never reaches that branch and keeps the behaviour below exactly.
 *
 * `scan: true` because this reader has always accepted an H1 anywhere in the
 * file rather than only on line 1. Falls back to the old strip-the-prefix
 * behaviour when the H1 does not parse as `# <ID> — <title>`, so a ticket with
 * an odd heading still shows a title instead of none.
 */
function ticketTitle(dir: string, id: string): string | null {
  const file = ticketFile(dir, id);
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseTicket(text, { file: path.basename(file), mode: 'auto' });
    if (parsed.format === 'block') return parsed.summary.title?.trim() || null;
    const h1 = parseTitleLine(text, { scan: true });
    if (h1.ok && h1.id === id) return h1.title!.trim() || null;
    const first = text.split('\n').find((l) => l.startsWith('# '));
    if (!first) return null;
    return first.replace(/^#\s+/, '').replace(new RegExp(`^${id}\\s*[—-]\\s*`), '').trim() || null;
  } catch { return null; }
}

export interface DecisionOption {
  /** The short choice key sent back on answer (e.g. `B`, or the bullet text itself for a plain option). */
  key: string;
  /** The human-readable label rendered on the button. */
  label: string;
  /** Optional prose after the label, explaining the option. */
  description: string;
}
export interface TicketDecision {
  question: string;
  options: DecisionOption[];
  /** The key the ticket recommends, from the Status line's `Recommended: X`, or null. */
  recommended: string | null;
  /** True when `question` fell back to the ticket title (see BoardItem.questionFromTitle). */
  questionFromTitle?: boolean;
}

/**
 * A `## Decision…`-style heading. FEAT-082: match a decision heading regardless
 * of its LEADING words — the real ARCH-004 uses `## The decision`, ARCH-003 uses
 * `## Decision 1 — …`, others `## Open decision (user)`. The old `/^##\s+Decision/i`
 * required the heading to START with "Decision" and so parsed `## The decision` as
 * null, silently dropping a textbook decision. Widened to "a level-2 heading whose
 * text contains the word decision(s)". This ONLY relaxes which heading is inspected;
 * the STRICTNESS that turns a heading into a decision is unchanged and lives below
 * — ≥2 bold-lead `- **KEY — label**` OPTION_BULLETs — so ordinary prose under a
 * decision heading still never becomes fake choice buttons (the BUG-025 failure).
 */
const DECISION_HEADING_RE = /^##\s+.*\bdecisions?\b/i;
/**
 * A bold-lead option bullet: `- **KEY — label.** description`. STRICT — the key
 * is a short token (≤6 chars: `A`, `B`, `C1`, …), separated from the label by an
 * em/en-dash or hyphen, the whole `KEY — label` inside one `**…**` bold run, and
 * the description is the remainder of the bullet. Ordinary prose bullets (no
 * bold, or no `KEY —` head) do NOT match — inventing options out of prose is the
 * BUG-025 failure mode this refuses.
 */
const OPTION_BULLET_RE = /^\s*[-*]\s+\*\*\s*([A-Za-z0-9]{1,6})\s*[—–-]\s*([^*]+?)\s*\*\*\s*(.*)$/;
/**
 * `Recommended: X` (the key), read from the `- **Status:**` line (FEAT-087 puts it
 * there). This extracts a raw token ONLY — it does NOT know the ticket's options,
 * so it cannot tell a real key from an incidental word. ARCH-004's status reads
 * "Recommended: one canonical state field…", which yields the bogus key `one`. The
 * extracted key is therefore VALIDATED against the parsed option keys in
 * `ticketDecision` (FEAT-082) and dropped when it matches none, so the UI never
 * badges a recommendation that points at no option.
 */
const RECOMMENDED_RE = /\bRecommended:\s*([A-Za-z0-9]{1,6})\b/i;

/** The `- **Status:**` line's recommended key, or null. */
function recommendedKey(lines: string[]): string | null {
  for (const raw of lines) {
    const t = raw.trim();
    if (/^-?\s*\*\*Status:?\*\*/i.test(t)) {
      const m = t.match(RECOMMENDED_RE);
      if (m) return m[1];
    }
  }
  return null;
}

/** A NEW top-level bullet (no indent) — ends the previous bullet's content. */
const TOP_BULLET_RE = /^[-*]\s/;

/**
 * BUG-103: the last line index (exclusive) of the bullet that starts at `start`.
 * Markdown wraps a bullet's description across several lines; the parser must
 * read all of them or the UI shows a sentence cut mid-word. A bullet runs until
 * the next top-level bullet, a blank line followed by a non-indented line (i.e.
 * the next paragraph), or the next heading — whichever comes first. This widens
 * only how much of an ALREADY-MATCHED bullet is read; it never makes a new line
 * match, so the strict bold-lead grammar still refuses ordinary prose.
 */
function bulletEnd(lines: string[], start: number, limit: number): number {
  let j = start + 1;
  for (; j < limit; j++) {
    const line = lines[j];
    if (/^\s*$/.test(line)) {
      const next = lines[j + 1];
      // A blank line continues the bullet only when what follows is indented
      // under it (and is not a new top-level bullet); otherwise the bullet ends.
      if (next === undefined || !/^\s+\S/.test(next) || TOP_BULLET_RE.test(next)) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    if (TOP_BULLET_RE.test(line)) break;
  }
  return j;
}

/**
 * FEAT-082 (visual review) — the ticket's own H1 title, from the markdown we
 * already hold: `# ARCH-004 — a ticket's state lives in prose…` → the prose after
 * the id. Null when the file carries no H1. (Distinct from `ticketTitle` above,
 * which reads the file by id; here the markdown is already in hand.)
 */
function titleFromMarkdown(markdown: string): string | null {
  const h1 = markdown.split('\n').find((l) => l.startsWith('# '));
  if (!h1) return null;
  return h1.replace(/^#\s+/, '').replace(/^[A-Z]+-\d+\s*[—–-]\s*/, '').trim() || null;
}

/**
 * FEAT-082 (visual review) — a decision heading's question, with the scaffolding
 * removed and a FLOOR under it.
 *
 * Two real failures on the real board motivated this, both from taking the
 * heading verbatim:
 *   · ARCH-003's `## Decision 1 — fix it properly, or just stop the harm` leaked
 *     the internal numbering ("Decision 1 —") into the user-facing question;
 *   · ARCH-004's `## The decision` yielded the literal question "The decision" —
 *     a contentless string sitting where the thing to decide should be.
 *
 * So: strip a leading `Decision N —` prefix, then test whether anything with
 * INFORMATION survives (a heading made only of decision-scaffolding words —
 * "the decision", "open decision (user)", "decisions" — does not). When nothing
 * survives, fall back to the ticket's title and say so via `questionFromTitle`.
 *
 * Why fall back rather than return an empty question: `question` non-empty is
 * what makes a needs-you item ANSWERABLE across the whole app (see
 * `isAnswerableItem`); emptying it would silently demote a real decision to a
 * read-only status row — the exact bug just fixed. The renderer is told the
 * question is only the title (`questionFromTitle`) so it can drop the line
 * rather than print the title twice.
 */
function decisionQuestion(headingText: string, markdown: string): { question: string; questionFromTitle: boolean } {
  const stripped = headingText.replace(/^\s*decisions?\s*\d*\s*[—–:-]\s*/i, '').trim();
  // The informational skeleton: drop parentheticals ("(user)"), the word
  // decision(s) itself, and the articles/qualifiers that can only ever attach
  // to it. Whatever is left is the heading's own content.
  const skeleton = stripped
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bdecisions?\b/gi, ' ')
    .replace(/\b(the|a|an|this|that|our|my|open|needed|pending|required|outstanding|user)\b/gi, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  if (skeleton) return { question: stripped, questionFromTitle: false };
  const title = titleFromMarkdown(markdown);
  return title ? { question: title, questionFromTitle: true } : { question: stripped || headingText.trim(), questionFromTitle: false };
}

/** The index of the next `## ` heading at or after `from`, or `lines.length`. */
function nextSectionEnd(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (/^##\s+/.test(lines[i])) return i;
  return lines.length;
}

/**
 * FEAT-090 (generalises BUG-025's `ticketQuestion`): parse a ticket's decision
 * into `{ question, options, recommended }`, or null when there is none.
 *
 * Two shapes are recognised, and NOTHING else — because fabricating choice
 * buttons out of ordinary prose is the BUG-025 failure this must refuse:
 *   1. the existing `## Question` section — its prose is the question, its `-`
 *      bullets are the options (plain bullets keep their text as both key and
 *      label; a bold-lead bullet is parsed structurally). Question-only (no
 *      bullets) is still a valid decision.
 *   2. a `## Decision…` heading (ARCH-003's shape — it has NO `## Question`):
 *      the heading text is the question, and ONLY strict bold-lead
 *      `- **KEY — label.** desc` bullets under it are options. It counts as a
 *      decision only with ≥2 such options (one bold bullet is not a choice);
 *      plain prose bullets under the heading are ignored. The first Decision
 *      heading that yields ≥2 options wins.
 *
 * `recommended` comes from the `- **Status:**` line's `Recommended: X` (FEAT-087).
 *
 * BUG-122 — A THIRD SHAPE, AND WHY IT IS NOT A LOOSENING. A ticket promoted to
 * the record format carries its decision as DATA in the leading
 * ```orchard-ticket block: there is no `## Decision` heading and no
 * `- **Status:**` line left for the two prose shapes to find, so ARCH-005's four
 * options — argued, recommended, and explicitly blocking a build — reached the
 * Needs-You rail as NOTHING the moment it was promoted. Nothing failed: the rail
 * drew it as a read-only attention row, which is BUG-025's silence exactly, one
 * format later. With 191 promotions queued, that is every open question on the
 * board unasked.
 *
 * The record path is checked FIRST and the prose paths are the fallback, so a
 * mixed board is read correctly during the migration and an unpromoted ticket's
 * behaviour is untouched (it never reaches the new branch).
 *
 * It cannot fabricate options out of prose, because it reads no prose: the
 * options are a JSON array with authored `key` and `label` fields, located by
 * the ONE extractor (`extractTicketBlock`, via `parseTicket`) — no fourth
 * grammar, and nothing here decides who owns that grammar (ARCH-008 is open and
 * awaiting a human on exactly that). The prose strictness is MIRRORED rather
 * than relaxed: fewer than two usable options is not a choice, and the
 * recommendation is validated against the real keys like any other.
 *
 * NOT honoured yet, and named rather than silently flattened: `mode: "staged"`
 * splits options across `stages`, which the rail's flat option list cannot
 * express. All options are offered, which is exactly what the rail showed for
 * the same ticket before it was promoted — parity restored, not a redesign. See
 * BUG-122's handoff.
 */
function decisionFromRecord(record: Record<string, unknown>, markdown: string): TicketDecision | null {
  const d = record.decision as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const raw = Array.isArray(d.options) ? d.options : [];
  const options: DecisionOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const opt = o as Record<string, unknown>;
    const key = typeof opt.key === 'string' ? opt.key.trim() : '';
    const label = typeof opt.label === 'string' ? opt.label.trim() : '';
    if (!key || !label) continue; // an option with no key or no label is not choosable
    // The rail carries labels only; the Decide card shows this description. The
    // record splits what the prose bullet said in one sentence across three
    // authored fields, so they are re-joined in the order the prose used:
    // what it changes, what it buys, what it costs.
    const description = [opt.what_changes, opt.benefit, opt.cost]
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .join(' ').replace(/\s+/g, ' ').trim();
    options.push({ key, label: label.replace(/\.$/, ''), description });
  }
  if (options.length < 2) return null;
  const rec = typeof d.recommendation === 'string' ? d.recommendation.trim() : '';
  const hit = rec ? options.find((o) => o.key.toLowerCase() === rec.toLowerCase()) : undefined;
  const q = typeof d.question === 'string' ? d.question.trim() : '';
  // Same FLOOR as the prose path: `question` non-empty is what makes a needs-you
  // item ANSWERABLE (isAnswerableItem), so a record with no question falls back
  // to the ticket's title and SAYS it did, rather than silently demoting a real
  // decision to a read-only row.
  if (q) return { question: q, options, recommended: hit ? hit.key : null };
  const title = (typeof record.title === 'string' && record.title.trim()) || titleFromMarkdown(markdown);
  return title
    ? { question: title, options, recommended: hit ? hit.key : null, questionFromTitle: true }
    : null;
}

export function ticketDecision(markdown: string): TicketDecision | null {
  // Shape 3 (BUG-122) — the record, when there is one. `mode: 'auto'` is the one
  // shared reader; a file with no record block falls straight through to the two
  // prose shapes below, unchanged.
  const parsed = parseTicket(markdown, { mode: 'auto' });
  if (parsed.format === 'block' && parsed.record) {
    return decisionFromRecord(parsed.record as Record<string, unknown>, markdown);
  }

  const lines = markdown.split('\n');
  const rawRecommended = recommendedKey(lines);

  /**
   * FEAT-082 — validate the raw `Recommended:` token against the ACTUAL parsed
   * option keys. Returns the matching option's key (its own casing) when it
   * matches one, else null — so a status blurb like ARCH-004's "Recommended: one
   * canonical state…" yields no recommendation rather than the nonsense key `one`.
   * Case-insensitive so `Recommended: b` still resolves to option `B`.
   */
  const validRecommended = (options: DecisionOption[]): string | null => {
    if (!rawRecommended) return null;
    const hit = options.find((o) => o.key.toLowerCase() === rawRecommended.toLowerCase());
    return hit ? hit.key : null;
  };

  /**
   * Parse one bold-lead bullet. `tail` is the bullet's continuation lines
   * (BUG-103) — joined into the description with internal newlines and repeated
   * whitespace collapsed to single spaces, so it renders as one sentence.
   */
  const parseOptionBullet = (t: string, tail: string[] = []): DecisionOption | null => {
    const m = t.match(OPTION_BULLET_RE);
    if (!m) return null;
    const description = [m[3], ...tail].join(' ').replace(/\s+/g, ' ').trim();
    return { key: m[1].trim(), label: m[2].trim().replace(/\.$/, ''), description };
  };

  // Shape 1 — the `## Question` section (unchanged semantics).
  const qStart = lines.findIndex((l) => /^##\s+Question\b/i.test(l.trim()));
  if (qStart !== -1) {
    const end = nextSectionEnd(lines, qStart + 1);
    const prose: string[] = [];
    const options: DecisionOption[] = [];
    for (let j = qStart + 1; j < end; ) {
      const t = lines[j].trim();
      if (!t) { j++; continue; }
      const bullet = t.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        const stop = bulletEnd(lines, j, end);
        const opt = parseOptionBullet(t, lines.slice(j + 1, stop));
        if (opt) { options.push(opt); j = stop; continue; }
        const text = bullet[1].trim();
        options.push({ key: text, label: text, description: '' });
      } else prose.push(t);
      j++;
    }
    const question = prose.join(' ').trim();
    if (question) return { question, options, recommended: validRecommended(options) };
  }

  // Shape 2 — a `## Decision…` heading with strict bold-lead option bullets.
  for (let i = 0; i < lines.length; i++) {
    if (!DECISION_HEADING_RE.test(lines[i].trim())) continue;
    const end = nextSectionEnd(lines, i + 1);
    const options: DecisionOption[] = [];
    for (let j = i + 1; j < end; ) {
      const stop = bulletEnd(lines, j, end);
      const opt = parseOptionBullet(lines[j], lines.slice(j + 1, stop));
      if (opt) { options.push(opt); j = stop; continue; }
      j++;
    }
    if (options.length >= 2) {
      const heading = lines[i].trim().replace(/^##\s+/, '').trim();
      const { question, questionFromTitle } = decisionQuestion(heading, markdown);
      return { question, options, recommended: validRecommended(options), questionFromTitle };
    }
  }
  return null;
}

/**
 * FEAT-090 — parse the `### YYYY-MM-DD — <author>` entries of a ticket's Activity
 * log and return the LAST user ANSWER entry plus whether ANY dated entry follows
 * it. `null` when the log carries no answer entry at all.
 *
 * An answer entry is a heading whose author reads `you (answer…` or the legacy
 * `you (via Needs-You rail…` (the mark `appendAnswer` stamps). Detection is
 * ANCHORED to the heading — never a whole-file substring — so a ticket whose
 * ordinary PROSE merely mentions the mark is NOT mistaken for answered (the live
 * pre-FEAT-090 bug this replaces).
 */
const ENTRY_HEADING_RE = /^###\s+(\d{4}-\d\d-\d\d)\s+—\s+(.*)$/;
// A follow-up (`you (follow-up …)`) is ALSO an answer entry: it keeps the ticket
// in the answered-awaiting lane (owner 👤) rather than reading as "an agent acted
// after the answer" — which is what would drop it off the lane. See FOLLOWUP_STATE.
const ANSWER_AUTHOR_RE = /^you\s+\((?:answer|follow-?up|via Needs-You rail)/i;

interface AnswerEntry { date: string; author: string; line: number; answer: string; }

function answerEntries(markdown: string): { last: AnswerEntry; followed: boolean } | null {
  const lines = markdown.split('\n');
  const entries: AnswerEntry[] = [];
  const isAnswer: boolean[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(ENTRY_HEADING_RE);
    if (!m) continue;
    const author = m[2].trim();
    // The answer text: the first `- **Answer:** …` line under the heading (else
    // the first non-empty body line), until the next dated heading.
    let answer = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (ENTRY_HEADING_RE.test(lines[j].trim())) break;
      const bt = lines[j].trim();
      if (!bt) continue;
      const am = bt.match(/^[-*]\s*\*\*Answer:?\*\*\s*(.*)$/i);
      if (am) { answer = am[1].trim(); break; }
      if (!answer) answer = bt.replace(/^[-*]\s+/, '').trim();
    }
    entries.push({ date: m[1], author, line: i, answer });
    isAnswer.push(ANSWER_AUTHOR_RE.test(author));
  }
  let lastAnswerIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (isAnswer[i]) { lastAnswerIdx = i; break; } }
  if (lastAnswerIdx === -1) return null;
  return { last: entries[lastAnswerIdx], followed: lastAnswerIdx < entries.length - 1 };
}

/** Read a file's text, or '' if it cannot be read. */
function safeRead(file: string | null): string {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** The `<ID>-<slug>.md` ticket file for an id, or null when absent. */
export function ticketFile(dir: string, id: string): string | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hit = names.find((n) => n.endsWith('.md') && (n === `${id}.md` || n.startsWith(`${id}-`)));
  return hit ? path.join(dir, hit) : null;
}

/**
 * One `readdir` for a whole board read, as an id → path lookup.
 *
 * FEAT-095 needs a file path for EVERY open row (ranking reads each row's
 * record), where before only the ~20 👤 rows needed one. `ticketFile` re-scans
 * the directory on every call, so keeping it would have turned one board GET —
 * which the rail polls — into 35 readdirs of a 200-entry directory. Same
 * matching rule, read once.
 */
function ticketFileIndex(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const m = /^([A-Z]+-\d+)(?:-|\.md$)/.exec(n);
    if (m && !out.has(m[1])) out.set(m[1], path.join(dir, n));
  }
  return out;
}

/**
 * Parse `docs/bugs/INDEX.md` + ticket files into the board. No board dir → an
 * empty board with `hasBoard:false` (opt-in, never an error).
 *
 * OPEN-VS-DONE HERE IS THE INDEX'S ANSWER, NOT A CLASSIFICATION. The lane a row
 * lands in comes from which TABLE it sits in; this function never reads a
 * ticket's `- **Status:**` header and so never classifies a work state — that
 * is scripts/lib/ticket-schema.mjs's job, and `board:gen` is what puts the row
 * where it belongs (an unmappable status ⇒ Open). The failure mode this rail
 * therefore has is not a wrong guess but a SILENT DISAGREEMENT with the ticket
 * file when the INDEX is hand-edited — which `board:check` reports as STATUS
 * MISMATCH, and scripts/verify-unmappable-status.mjs holds standing.
 */
export function readBoard(hostPath: string): Board {
  const dir = boardDir(hostPath);
  const empty: Board = { hasBoard: false, needsYou: [], observations: [], answeredAwaiting: [], inflight: [], queued: [], doneToday: [] };
  let index: string;
  try {
    if (!fs.statSync(dir).isDirectory()) return empty;
    index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  } catch {
    return empty; // no docs/bugs/ or no INDEX.md — no board
  }

  const board: Board = { hasBoard: true, needsYou: [], observations: [], answeredAwaiting: [], inflight: [], queued: [], doneToday: [] };
  let section: 'open' | 'done' | null = null;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const files = ticketFileIndex(dir);

  for (const line of index.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      const t = h[1].toLowerCase();
      section = t.startsWith('open') ? 'open' : t.startsWith('done') ? 'done' : null;
      continue;
    }
    if (!section) continue;
    const cells = cellsOf(line);
    const id = cells[0];
    if (!id || !ID_RE.test(id)) continue; // header/divider/prose rows

    const title = ticketTitle(dir, id) ?? cells[1] ?? id;
    if (section === 'open') {
      const owner = cells[2] ?? '';
      const item: BoardItem = { id, title, owner, status: cells[3] ?? '', sev: cells[4] ?? '', kind: 'ticket' };
      // FEAT-095 — every OPEN row now carries its file, not just the 👤 ones:
      // ranking reads each row's record, and a queued ticket that would settle
      // four others has to be rankable to ever leave the bottom of the list.
      item.file = files.get(id) ?? undefined;
      if (owner.includes(NEEDS_YOU)) {
        const file = item.file ?? null;
        const md = safeRead(file);
        const ans = answerEntries(md);
        if (ans && !ans.followed) {
          // FEAT-090 — answered, and NOTHING dated appended after it: the human
          // is done deciding but no agent has picked it up. It LEAVES needsYou
          // (the needs count stays "still waiting on you") and lands in the
          // answered-awaiting lane, carrying the chosen answer + date. This is
          // derived on every read, so an agent note (or an Owner→🤖 flip in
          // INDEX, which routes below) retires it with no stored flag to drift.
          item.file = file ?? undefined;
          item.answer = ans.last.answer;
          item.answeredOn = ans.last.date;
          board.answeredAwaiting!.push(item);
        } else if (ans && ans.followed) {
          // Answered AND a dated entry followed (agent acted) → resolved; drop,
          // exactly as the old whole-file-mark path dropped an answered ticket.
        } else {
          // BUG-025: 👤 is board STATUS, not automatically a question. Only a
          // ticket with a `## Question` or `## Decision…` shape is answerable; a
          // bare 👤 ticket carries no `question` and the rail renders it as a
          // read-only attention row instead of an answer box.
          const d = ticketDecision(md);
          if (d) {
            item.question = d.question;
            if (d.questionFromTitle) item.questionFromTitle = true;
            if (d.options.length) item.options = d.options.map((o) => o.label);
            // FEAT-082 — carry the (validated) recommended key so the landing
            // screen can badge it without re-parsing the ticket markdown.
            if (d.recommended) item.recommended = d.recommended;
          }
          item.file = file ?? undefined;
          board.needsYou.push(item);
        }
      } else if (owner.includes(IN_FLIGHT)) board.inflight.push(item);
      // FEAT-053: an Open row owned by neither glyph is the queued backlog —
      // filed for later, nobody working it, nobody waiting on the user.
      else board.queued.push(item);
    } else {
      // Done rows carry (ID, Title, Commit). "Today" = the ticket file was
      // touched in the last 24h, so a stale Done row does not read as fresh.
      const file = ticketFile(dir, id);
      let recent = false;
      try { recent = !!file && fs.statSync(file).mtimeMs >= dayAgo; } catch { /* gone */ }
      if (recent) board.doneToday.push({ id, title, owner: '', status: 'done', sev: '' });
    }
  }

  /* ── FEAT-095 — order by what answering it is WORTH, not by when it was filed.
   *
   * Everything above emitted rows in INDEX.md's own line order, and `board:gen`
   * only ever appends a new ticket to the bottom of that file — so the board was
   * ordered by ticket AGE, permanently, and `summary.focus` (injected into every
   * launched session as the project's focus) was the OLDEST 👤 row. The ticket
   * that collapses eight open architecture decisions sat last of thirty-five.
   *
   * Derived here on every read from the records already on disk — no stored
   * order, no priority field, nothing to keep up to date. Every lane is
   * re-ordered, never filtered: `rankLane` returns a permutation, so the tail is
   * still there and still reachable. Done rows are left alone — they are history,
   * and history is chronological. */
  const laneList = [board.needsYou, board.answeredAwaiting ?? [], board.inflight, board.queued];
  const ranks = rankRows(laneList);
  for (const lane of laneList) {
    for (const it of lane) {
      const r = ranks.get(it.id);
      if (!r) continue;
      it.rank = r.score;
      if (r.why) it.rankWhy = r.why;
      if (r.settlesOpen.length) it.rankSettles = r.settlesOpen;
    }
  }
  board.needsYou = rankLane(board.needsYou, ranks);
  if (board.answeredAwaiting) board.answeredAwaiting = rankLane(board.answeredAwaiting, ranks);
  board.inflight = rankLane(board.inflight, ranks);
  board.queued = rankLane(board.queued, ranks);
  return board;
}

/**
 * Compose a compact, capped "Project state" section from the live board, for
 * injection into a launched session's system prompt (FEAT-021).
 *
 * The goal is that every session on a board-having project boots ALREADY AWARE
 * of where the project is — so we stop re-syncing by hand as context drifts.
 * It is generated read-only from the same `readBoard` the UI rail uses (one
 * source of truth on disk, two surfaces), and refreshed on every launch.
 *
 * A project with NO board injects NOTHING — this returns `null`, so injection
 * is opt-in exactly like the board itself (e.g. $HOME has no docs/bugs/).
 *
 * HARD length cap: this text is prepended to EVERY launch, so it competes for
 * the model's attention budget (FEAT-026 / WA §H). Both the per-list item count
 * and the total character count are capped; overflow is summarised as "+N more".
 */
export function boardStateSection(
  hostPath: string,
  opts?: { maxItems?: number; maxChars?: number },
): string | null {
  const board = readBoard(hostPath);
  if (!board.hasBoard) return null;

  const maxItems = Math.max(1, opts?.maxItems ?? 5);
  const maxChars = Math.max(200, opts?.maxChars ?? 1200);

  const short = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const bullet = (it: BoardItem) => `- ${it.id} — ${short(it.title)}`;
  const listOf = (items: BoardItem[]) => {
    const shown = items.slice(0, maxItems).map(bullet);
    if (items.length > maxItems) shown.push(`- …+${items.length - maxItems} more`);
    return shown.join('\n');
  };

  // Current focus = the single highest-priority OPEN item. A 👤 needs-you item
  // outranks in-flight work (it is blocked ON the user); in-flight outranks a
  // quiet board. This is the one line a session should orient on first.
  const focusItem = board.needsYou[0] ?? board.inflight[0] ?? null;
  const focus = focusItem
    ? `${board.needsYou[0] ? '\u{1F464}' : '\u{1F916}'} ${focusItem.id} — ${short(focusItem.title, 88)}`
    : 'board is clear — nothing open';

  // FEAT-106 — name the board where it ACTUALLY lives (docs/bugs or .orchard/bugs),
  // resolved for this project rather than hard-coded, so a migrated project's
  // snapshot points a session at the real path. Host-relative, POSIX-style.
  const boardRel = path.relative(hostPath, boardDir(hostPath)).split(path.sep).join('/') || 'docs/bugs';

  const parts: string[] = [
    '# Project state (live board snapshot)',
    '',
    `_Auto-injected at launch from ${boardRel}/ (read-only). Re-read ${boardRel}/INDEX.md for the authoritative board; answer 👤 items via the dashboard's Needs-You rail._`,
    '',
    `**Focus:** ${focus}`,
    '',
  ];

  // FEAT-090 — the answered-awaiting lane, placed IMMEDIATELY after Focus and
  // BEFORE Needs-you. Placement is load-bearing: this function truncates by
  // slicing the TAIL at maxChars, so the decided-not-dispatched instruction must
  // sit near the top or it can silently vanish on a busy board. `answeredFloor`
  // records the character length THROUGH this section so the cap below is raised
  // to guarantee it survives whole, even when the board is deliberately overfull.
  const answered = board.answeredAwaiting ?? [];
  let answeredFloor = 0;
  if (answered.length) {
    const answeredBullet = (it: BoardItem) =>
      `- ${it.id} — ${short(it.title)} → chose: ${short(it.answer ?? '(recorded)', 60)} (answered ${it.answeredOn ?? '?'})`;
    const shown = answered.slice(0, maxItems).map(answeredBullet);
    if (answered.length > maxItems) shown.push(`- …+${answered.length - maxItems} more`);
    parts.push(
      `✋ **Answered — awaiting action (${answered.length}):**`,
      'These are DECIDED but NOT dispatched. Do not start work on them silently: report each decision to the user and ask before you begin.',
      ...shown,
      '',
    );
    answeredFloor = parts.join('\n').length;
  }

  parts.push(
    `👤 **Needs you (${board.needsYou.length}):**`,
    board.needsYou.length ? listOf(board.needsYou) : '- (none)',
  );
  if (board.inflight.length) {
    parts.push('', `🤖 **In flight (${board.inflight.length}):**`, listOf(board.inflight));
  }
  if (board.doneToday.length) {
    parts.push('', `✅ **Done recently (${board.doneToday.length}):**`, listOf(board.doneToday));
  }

  // Raise the cap ONLY when the answered lane is non-empty, and only enough to
  // keep that (top-placed) section whole — the tail (needs/inflight/done) still
  // truncates normally.
  const cap = Math.max(maxChars, answeredFloor ? answeredFloor + 1 : 0);
  let text = parts.join('\n');
  if (text.length > cap) text = `${text.slice(0, cap - 1).trimEnd()}…`;
  return text;
}

/**
 * FEAT-067 — the rail's status summary, as STRUCTURED data for the top-of-rail
 * card (the same "what's done / needs you / queued / in flight" synthesis that
 * `boardStateSection` above injects as prompt PROSE, here rendered as a
 * glanceable index instead of a paragraph that scrolls away in chat).
 *
 * HONESTY IS THE POINT (FEAT-067; the BUG-041/074 "observability must not lie"
 * class): this is a PURE function of the board handed in — it reads nothing off
 * disk, stores nothing, emits nothing. The board GET route recomputes it on
 * EVERY read from the fully-merged lists (decisions/findings/stalls already
 * folded into needsYou), so the card can never drift from the sections it
 * indexes. An orchestrator-emitted snapshot was rejected precisely because it
 * would freeze and lie the moment a ticket/agent/queue changed.
 *
 * `focus` follows the exact rule `boardStateSection` uses: the single
 * highest-priority OPEN item — a 👤 needs-you row (it is blocked ON the user)
 * outranks in-flight work, which outranks a quiet board (→ `null`).
 */
export function boardSummary(board: Board): BoardSummary {
  const focusItem = board.needsYou[0] ?? board.inflight[0] ?? null;
  const deployPending = [...board.needsYou, ...board.inflight, ...board.queued]
    .filter(isDeployPending).length;
  return {
    focus: focusItem ? { id: focusItem.id, title: focusItem.title } : null,
    counts: {
      needs: board.needsYou.length,
      // FEAT-079 — observations are counted SEPARATELY from `needs`: the rail's
      // "needs" chip must reflect real asks only, or the split is cosmetic.
      observations: (board.observations ?? []).length,
      // FEAT-090 — the answered-awaiting lane, counted SEPARATELY from `needs`:
      // these tickets have LEFT needsYou (the human decided), so folding them
      // back into `needs` would make the needs count lie.
      answered: (board.answeredAwaiting ?? []).length,
      queued: board.queued.length,
      inflight: board.inflight.length,
      doneToday: board.doneToday.length,
      deployPending,
    },
  };
}

/**
 * FEAT-067 fast-follow — the deploy-pending DERIVED filter. A board row is
 * "deploy pending" when it is shipped-in-code but not yet OUT: a `DEPLOY-*`
 * ticket (the id convention this repo mints for a deploy step, DEPLOY-003/…), or
 * any row whose status cell says needs-deploy / deploy-pending / not-deployed /
 * undeployed. It is a filter over the ALREADY-PARSED board — no new field, no
 * second read of disk — so the count can never drift from the rows it counts.
 * Only OPEN rows are considered (a Done `DEPLOY-*` row is a deploy that HAPPENED).
 */
const DEPLOY_ID_RE = /^DEPLOY-\d+$/i;
const DEPLOY_STATUS_RE =
  /\b(needs?[\s-]?deploy|deploy[\s-]?(?:pending|needed|required)|pending[\s-]?deploy|await\w*[\s-]?deploy|not[\s-]?deployed|un-?deployed)\b/i;
export function isDeployPending(it: BoardItem): boolean {
  return DEPLOY_ID_RE.test(it.id) || DEPLOY_STATUS_RE.test(it.status ?? '');
}

/* ═══════════════════════ FEAT-090 — the single answer composer ═══════════════
 *
 * ONE place composes the dated, attributed, machine-readable Activity-log entry
 * a user reply writes — used by BOTH the ticket-view route (tickets.answerTicket)
 * and the legacy Needs-You rail route (appendAnswer below). Two surfaces, one
 * grammar, so the answered-lane parser (answerEntries) and the ticket-detail
 * parser (ticketAnswerState) never have to know which surface wrote a reply.
 *
 * A reply is not always a DECISION. Three kinds, and OWNERSHIP is explicit in
 * the entry so nobody has to infer it:
 *   - decision      → the human decided; the ticket is answered, awaiting an
 *                     agent to act (owner stays 👤, derived into answeredAwaiting).
 *   - question      → the human asked the agent something back; ownership flips
 *                     to the AGENT (the route sets Owner 🤖) — not ready for work.
 *   - counter       → the human proposed something different; same agent-owned,
 *                     waiting-on-a-reply posture as a question.
 */
export type ReplyKind = 'decision' | 'question' | 'counter';

const REPLY_WORD: Record<ReplyKind, string> = {
  decision: 'answer',
  question: 'question',
  counter: 'counter-proposal',
};
const REPLY_STATE: Record<ReplyKind, string> = {
  decision: 'answered — awaiting agent action (not dispatched)',
  question: 'waiting on agent — you asked a question (ownership: agent, not ready for work)',
  counter: 'waiting on agent — you countered (ownership: agent, not ready for work)',
};
/**
 * FEAT-090 follow-up — a decision is often followed by a clarification, a caveat
 * or a change of mind. That is a NEW append (the answer log is append-only — the
 * original is never edited), and it RE-FLAGS the ticket as awaiting agent action:
 * the user adding context after the fact is exactly when a dispatched agent must
 * see it before acting. So a follow-up keeps owner 👤 and the answered-awaiting
 * lane, just like the original decision — its State says so in its own words.
 */
const FOLLOWUP_STATE = 'answered — awaiting agent action (context added after deciding, not dispatched)';

export interface AnswerEntryInput {
  kind: ReplyKind;
  /** The decision question echoed into the record, when there was one. */
  question?: string | null;
  /** The option the user picked, when a decision offered options. */
  chose?: { key: string; label: string } | null;
  /** Free-text: a Note when an option was chosen, else the Answer itself. */
  note?: string;
  /** Where the reply was written: 'ticket view' | 'Needs-You rail'. */
  via: string;
  /**
   * FEAT-090 — a note added AFTER the decision was already recorded. Marked as a
   * `you (follow-up …)` entry with a follow-up State, but still an ANSWER entry
   * (owner 👤, answered-awaiting). Only meaningful on a `decision` reply.
   */
  followup?: boolean;
}

/** `- **Label:** first` with 2-space-indented continuation lines (append-only safe). */
function bulletLines(label: string, text: string): string[] {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
  const [first, ...rest] = clean.split('\n');
  return [`- **${label}:** ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ''))];
}

/**
 * Compose ONE Activity-log entry for a user reply. Append-only shape:
 *   ### <date> — you (<word> · via <surface>)
 *   - **Question:** …        (present when the decision carried a question)
 *   - **Chose:** B — label   (present when an option was picked)
 *   - **Note:** …            (present with a chosen option + free text)
 *   - **Answer:** …          (free-text-only reply — no option chosen)
 *   - **State:** …           (owner + readiness, per kind)
 * Returns the entry with a leading + trailing newline, ready to append at EOF.
 */
export function composeAnswerEntry(input: AnswerEntryInput): string {
  const date = new Date().toISOString().slice(0, 10);
  // A follow-up is a decision-kind reply flagged as after-the-fact context; it
  // gets its own author word and State but is otherwise an ordinary answer entry.
  const followup = input.kind === 'decision' && input.followup === true;
  const word = followup ? 'follow-up' : (REPLY_WORD[input.kind] ?? 'answer');
  const via = String(input.via ?? 'ticket view').trim() || 'ticket view';
  const q = String(input.question ?? '').trim();
  const chose = followup ? null : (input.chose && input.chose.key ? input.chose : null);
  const note = String(input.note ?? '').trim();

  const lines: string[] = [`### ${date} — you (${word} · via ${via})`];
  if (q && !followup) lines.push(`- **Question:** ${q}`);
  if (chose) {
    lines.push(`- **Chose:** ${chose.key} — ${chose.label}`.trimEnd());
    if (note) lines.push(...bulletLines('Note', note));
  } else if (note) {
    lines.push(...bulletLines('Answer', note));
  }
  lines.push(`- **State:** ${followup ? FOLLOWUP_STATE : (REPLY_STATE[input.kind] ?? REPLY_STATE.decision)}`);
  return `\n${lines.join('\n')}\n`;
}

/**
 * FEAT-090 — the ticket-detail parser: the LAST user reply entry, whatever kind,
 * so the ticket view can render a server-CONFIRMED chosen state (question.js's
 * renderChosen discipline) WITHOUT the client re-parsing markdown. `null` when
 * no `you (…)` reply entry exists. `awaiting` is true only for a DECISION reply
 * with nothing dated appended after it — the exact answeredAwaiting condition.
 */
/** A dated note the user appended AFTER the anchor answer (append-only context). */
export interface TicketAnswerFollowup {
  on: string;
  note: string;
}
export interface TicketAnswerState {
  on: string;
  kind: ReplyKind;
  chose: { key: string; label: string } | null;
  note: string;
  awaiting: boolean;
  /**
   * FEAT-090 — follow-up notes the user added after answering, oldest-first. Each
   * is its OWN dated `you (follow-up …)` entry; the anchor answer above is never
   * rewritten. Empty when there are none.
   */
  followups: TicketAnswerFollowup[];
}
// FEAT-090 / BUG-104 — the `- **Chose:** <keys> — <labels>` line, read back for
// the answered card's echo. `composeAnswerEntry` writes the key group and the
// label group separated by a SPACE-FLANKED em/en dash (` — `); a MULTI answer
// composes several option keys with ` + ` on the left and their labels with ` + `
// on the right (`1 + 2 + 4 — first + second + fourth`). The reader must return
// whatever the writer wrote, for EVERY decision mode — a single key, a ` + `-joined
// list, or a staged single — so the key capture is the WHOLE left group up to that
// separator, not a lone `[A-Za-z0-9]{1,6}` token. The old token capture matched
// only the FIRST key of a composed answer and then hit ` + ` where it wanted the
// dash, so the whole line failed to match and `answer.chose` came back null — the
// write path and the read path disagreeing about the same line (BUG-104).
//
// Splitting on the first space-flanked em/en dash is unambiguous BY CONSTRUCTION
// for the keys this system mints: option keys are ≤6-char tokens joined with ` + `
// (which contains no em/en dash), and a bare hyphen is deliberately NOT a separator
// here (`\s+[—–]`, not `[—–-]`), so a key like `C-1` survives whole rather than
// mis-splitting on its own hyphen. The one residual is GUARDED, not unrepresentable:
// an option key that itself embedded a space-flanked em/en dash would mis-split —
// no key the schema admits does (they are short tokens, and the ` + ` join and the
// `+`-split recommendation parser both assume no `+`/dash inside a key).
const CHOSE_LINE_RE = /^[-*]\s*\*\*Chose:?\*\*\s*(.+?)\s+[—–]\s*(.*)$/i;
const NOTE_LINE_RE = /^[-*]\s*\*\*(?:Note|Answer):?\*\*\s*(.*)$/i;
const YOU_AUTHOR_RE = /^you\s+\(/i;
const FOLLOWUP_AUTHOR_RE = /^you\s+\(follow-?up/i;

/** The `{chose, note}` carried in one entry's body lines `(start, end)`. */
function entryBody(lines: string[], start: number, end: number): { chose: { key: string; label: string } | null; note: string } {
  let chose: { key: string; label: string } | null = null;
  let note = '';
  for (let j = start + 1; j < end; j++) {
    const t = lines[j].trim();
    const cm = t.match(CHOSE_LINE_RE);
    if (cm) { chose = { key: cm[1].trim(), label: cm[2].trim() }; continue; }
    const nm = t.match(NOTE_LINE_RE);
    if (nm && !note) { note = nm[1].trim(); continue; }
  }
  return { chose, note };
}

export function ticketAnswerState(markdown: string): TicketAnswerState | null {
  const lines = markdown.split('\n');
  const entries: { date: string; author: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(ENTRY_HEADING_RE);
    if (m) entries.push({ date: m[1], author: m[2].trim(), line: i });
  }
  const you = entries.map((e, k) => ({ e, k })).filter((x) => YOU_AUTHOR_RE.test(x.e.author));
  if (!you.length) return null;

  // The ANCHOR is the last NON-follow-up user reply — the decision/question/counter
  // actually made. Follow-ups are context appended after it; they must NEVER
  // overwrite what was decided (the original chose/note stays the record).
  let anchor = you[you.length - 1];
  for (let p = you.length - 1; p >= 0; p--) {
    if (!FOLLOWUP_AUTHOR_RE.test(you[p].e.author)) { anchor = you[p]; break; }
  }
  const kind: ReplyKind = /^you\s+\(question/i.test(anchor.e.author) ? 'question'
    : /^you\s+\(counter/i.test(anchor.e.author) ? 'counter' : 'decision';
  const anchorEnd = anchor.k + 1 < entries.length ? entries[anchor.k + 1].line : lines.length;
  const { chose, note } = entryBody(lines, anchor.e.line, anchorEnd);

  // Every `you (follow-up …)` entry AFTER the anchor, oldest-first.
  const followups: TicketAnswerFollowup[] = [];
  for (const { e, k } of you) {
    if (k <= anchor.k || !FOLLOWUP_AUTHOR_RE.test(e.author)) continue;
    const fEnd = k + 1 < entries.length ? entries[k + 1].line : lines.length;
    followups.push({ on: e.date, note: entryBody(lines, e.line, fEnd).note });
  }

  // Awaiting: a decision with NO agent (non-user) dated entry after the LAST user
  // reply. A follow-up is a user entry, so it keeps the ticket awaiting — only an
  // agent's dated entry after everything means an agent has since acted.
  const lastYouK = you[you.length - 1].k;
  const agentActed = lastYouK < entries.length - 1;
  return { on: anchor.e.date, kind, chose, note, awaiting: kind === 'decision' && !agentActed, followups };
}

/**
 * Append the user's answer to a ticket's Activity log as a dated entry. This is
 * strictly APPEND-ONLY (docs/bugs/README.md): the prior file content is never
 * read-and-rewritten, only added to at EOF, so no earlier entry can be lost.
 * Returns the ticket file path on success; throws if the ticket does not exist.
 *
 * The legacy Needs-You rail path — a free-text (or option-label) DECISION answer.
 * Shares the ONE composer with the ticket-view route so both surfaces write the
 * same append-only, machine-readable grammar.
 */
export function appendAnswer(hostPath: string, id: string, answer: string): string {
  if (!ID_RE.test(id)) throw new Error(`not a ticket id: ${JSON.stringify(id)}`);
  const dir = boardDir(hostPath);
  const file = ticketFile(dir, id);
  if (!file) throw new Error(`no ticket ${id} under ${dir}`);
  const entry = composeAnswerEntry({ kind: 'decision', note: answer, via: 'Needs-You rail' });
  fs.appendFileSync(file, entry);
  return file;
}

/* ══════════════════════ FEAT-090 — the answered-awaiting briefing ════════════
 *
 * The launch snapshot (boardStateSection) already carries the answered lane for
 * a session that boots fresh. But a session that is ALREADY OPEN when the user
 * answers a ticket never re-reads that snapshot — so the decision would sit on
 * the board unseen until the next launch ("remember to tell me"). This states
 * each answered-awaiting ticket to an open session ONCE, riding the user's next
 * message. It must NEVER start a turn on its own — the caller only invokes it
 * while composing a turn the user is already sending.
 *
 * Dedup is per (ticketId, answerDate): the caller owns the seen-set (an in-memory
 * Set on the session), so a fresh answer to the same ticket (new date) is a new
 * announcement, but the same answer is never repeated. Empty lane → null (a
 * healthy session is never spammed — same contract as takeBriefing).
 */
function answerKey(it: BoardItem): string {
  return `${it.id}@${it.answeredOn ?? ''}`;
}
/** The answered-awaiting keys as they stand now — used to SEED a session's seen-set at launch. */
export function answeredAwaitingKeys(hostPath: string): string[] {
  return (readBoard(hostPath).answeredAwaiting ?? []).map(answerKey);
}
export function boardAnswerBriefing(hostPath: string, seen: Set<string>): string | null {
  let board: Board;
  try { board = readBoard(hostPath); } catch { return null; }
  const fresh = (board.answeredAwaiting ?? []).filter((it) => !seen.has(answerKey(it)));
  if (!fresh.length) return null;
  for (const it of fresh) seen.add(answerKey(it));
  const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const lines = fresh.map(
    (it) => `  - ${it.id} — ${short(it.title)} → chose: ${short(it.answer ?? '(recorded)', 60)} (answered ${it.answeredOn ?? '?'})`,
  );
  return [
    `[station] The user just recorded a decision on the board — DECIDED but NOT dispatched, awaiting your go:`,
    ...lines,
    `[station] This is a server-recorded fact from the ticket board, not a request. Report each decision back and ask before you begin — do not start work on it silently.`,
  ].join('\n');
}

/* ═══════════════ FEAT-047 — WA consolidation needs-human findings ═══════════
 *
 * `wa-consolidate.mjs` (boot pass + post-capture mini-pass, FEAT-019) persists
 * its needs-human findings — contradictions, routing-stale, rules-without-why —
 * to $METHODOLOGY_DIR/.station/needs-human.json, OVERWRITTEN every pass. These
 * are literally "needs you" items, so the rail surfaces them for the
 * methodology's HOME project (claude-station — the tooling and the docs/prompts
 * mirror live there; every other project's rail stays free of them). They are
 * read-only attention rows (BUG-025: no question → no answer box); the one
 * affordance is DISMISS, which acks {id → the finding's date} in
 * needs-human-acks.json beside the findings. Because a finding that merely
 * PERSISTS across passes keeps its carried-forward date, a dismissal holds
 * until the finding disappears (clean pass) and later REAPPEARS with a newer
 * date. A missing/unreadable findings file is the honest "no findings" state,
 * never an error — same opt-in contract as the board itself.
 */

interface PersistedFinding {
  id: string;
  type: string;
  summary: string;
  date: string;
  /**
   * FEAT-079 PROMOTION SEAM — the concrete decision/ask a finding carries, if
   * any. A bare recurrence/consolidation finding has NONE and stays a read-only
   * Observation (WA §H). The moment a finding-writer (arch-watch.mjs /
   * wa-consolidate.mjs) attaches a non-empty `ask` — e.g. "file ARCH-### for
   * this class, or keep patching?" — the mapper below sets `question`, and the
   * board route routes that row into `needsYou` as a real ask. Today no writer
   * emits `ask`, so every finding is an Observation; this is the documented path
   * to promote one without touching the routing.
   */
  ask?: string;
}

/**
 * FEAT-079 — a finding BoardItem is a real ASK (belongs on `needsYou`) only when
 * it carries a non-empty `question` (set by the mappers from the persisted
 * `ask`). Otherwise it is a read-only Observation. The one predicate both the
 * board route and the tests partition on, so the rule lives in one place.
 */
export function findingIsAsk(it: BoardItem): boolean {
  return typeof it.question === 'string' && it.question.trim() !== '';
}

const FINDING_LABELS: Record<string, string> = {
  'routing-stale': 'routing table stale',
  'contradiction': 'contradictory rules',
  'rule-without-why': 'rule without a stated why',
  'near-duplicate-sections': 'near-duplicate sections',
  'project-specific-section': 'project-specific section',
};

export function needsHumanFile(methodologyDir: string): string {
  return path.join(methodologyDir, '.station', 'needs-human.json');
}
function acksFile(methodologyDir: string): string {
  return path.join(methodologyDir, '.station', 'needs-human-acks.json');
}

function readFindingsRaw(methodologyDir: string): PersistedFinding[] {
  try {
    const j = JSON.parse(fs.readFileSync(needsHumanFile(methodologyDir), 'utf8'));
    if (!Array.isArray(j?.findings)) return [];
    return j.findings.filter(
      (f: unknown): f is PersistedFinding =>
        !!f && typeof (f as PersistedFinding).id === 'string' && typeof (f as PersistedFinding).date === 'string',
    );
  } catch {
    return []; // no findings file — nothing needs the user; not an error
  }
}
function readAcks(methodologyDir: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(acksFile(methodologyDir), 'utf8'));
    return j && typeof j === 'object' ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The un-acked findings as read-only rail rows (kind:'finding', no `question`). */
export function consolidationFindings(methodologyDir: string): BoardItem[] {
  const acks = readAcks(methodologyDir);
  return readFindingsRaw(methodologyDir)
    .filter((f) => acks[f.id] !== f.date) // ack'd at this date → dismissed until a newer pass re-raises it
    .map((f) => ({
      id: f.id,
      title: `WA consolidation: ${FINDING_LABELS[f.type] ?? f.type}`,
      owner: '\u{1F464}',
      status: 'finding',
      sev: '',
      kind: 'finding' as const,
      detail: typeof f.summary === 'string' ? f.summary : '',
      // FEAT-079 promotion seam: a finding that carries a concrete `ask` becomes
      // an answerable needsYou row; a bare finding has no `question` → Observation.
      ...(typeof f.ask === 'string' && f.ask.trim() ? { question: f.ask.trim() } : {}),
    }));
}

/* ═══════════════ FEAT-056 — per-PROJECT architecture-recurrence findings ════
 *
 * `scripts/arch-watch.mjs` (ridden by the consolidation loop, and runnable in
 * any onboarded project as `npm run arch:watch`) clusters a project's own
 * tickets by declared subsystem and raises a needs-human finding when one
 * subsystem has been patched past the recurrence threshold — the mechanical half
 * of WA §N ("a symptom fixed 2–3× means the design is wrong").
 *
 * Scoping, deliberately different from FEAT-047's WA findings: those are about
 * the shared methodology and belong ONLY on the methodology-home project's rail.
 * These are about THIS project's own board, so they live beside it
 * (`docs/bugs/.arch/findings.json`, derived + git-ignored) and surface on THAT
 * project's rail — a cluster found in project B must never appear on
 * claude-station's. Same read-only + dismissible mechanics as FEAT-047; a
 * missing file is the honest "nothing recurring", never an error.
 */
function archFindingsFile(hostPath: string): string {
  return path.join(boardDir(hostPath), '.arch', 'findings.json');
}
function archAcksFile(hostPath: string): string {
  return path.join(boardDir(hostPath), '.arch', 'acks.json');
}
function readJsonOr<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function readArchRaw(hostPath: string): PersistedFinding[] {
  const j = readJsonOr<{ findings?: unknown }>(archFindingsFile(hostPath), {});
  if (!Array.isArray(j?.findings)) return [];
  return (j.findings as PersistedFinding[]).filter(
    (f) => !!f && typeof f.id === 'string' && typeof f.date === 'string',
  );
}

/** Un-acked architecture-recurrence findings for a project, as rail rows. */
export function archRecurrenceFindings(hostPath: string): BoardItem[] {
  const acks = readJsonOr<Record<string, string>>(archAcksFile(hostPath), {});
  return readArchRaw(hostPath)
    .filter((f) => acks[f.id] !== f.date)
    .map((f) => ({
      id: f.id,
      title: 'Architecture review: subsystem patched repeatedly',
      owner: '\u{1F464}',
      status: 'finding',
      sev: '',
      kind: 'finding' as const,
      detail: typeof f.summary === 'string' ? f.summary : '',
      // FEAT-079 promotion seam (see consolidationFindings): a bare recurrence
      // COUNT has no `ask` → Observation; attach one to promote it to a needsYou
      // decision ("file ARCH-### for this class, or keep patching?").
      ...(typeof f.ask === 'string' && f.ask.trim() ? { question: f.ask.trim() } : {}),
    }));
}

/** True for ids minted by arch-watch — used to route a dismissal to the project. */
export function isArchFindingId(id: string): boolean {
  return /^arch-recurrence-/.test(id);
}

/**
 * Dismiss an architecture-recurrence finding for a project. Acks {id → the
 * finding's current date}: because arch-watch's id hashes the cluster's MEMBER
 * SET, the dismissal holds while the cluster is unchanged and the finding
 * re-raises itself under a new id the moment a NEW ticket joins the cluster —
 * which is exactly when the question is worth asking again.
 */
export function dismissArchFinding(hostPath: string, id: string): void {
  const finding = readArchRaw(hostPath).find((f) => f.id === id);
  if (!finding) throw new Error(`no architecture finding ${JSON.stringify(id)} on file for this project`);
  const acks = readJsonOr<Record<string, string>>(archAcksFile(hostPath), {});
  acks[id] = finding.date;
  fs.mkdirSync(path.dirname(archAcksFile(hostPath)), { recursive: true });
  fs.writeFileSync(archAcksFile(hostPath), `${JSON.stringify(acks, null, 2)}\n`);
}

/**
 * Record a dismissal for a finding id: ack maps the id to the finding's CURRENT
 * date, so the row stays gone while the finding persists (its date is carried
 * forward pass-to-pass) and returns only if a LATER pass re-detects it fresh.
 * Throws on an unknown id — dismissing a finding that is not on file is a bug.
 */
export function dismissConsolidationFinding(methodologyDir: string, id: string): void {
  const finding = readFindingsRaw(methodologyDir).find((f) => f.id === id);
  if (!finding) throw new Error(`no consolidation finding ${JSON.stringify(id)} on file`);
  const acks = readAcks(methodologyDir);
  acks[id] = finding.date;
  fs.mkdirSync(path.dirname(acksFile(methodologyDir)), { recursive: true });
  fs.writeFileSync(acksFile(methodologyDir), `${JSON.stringify(acks, null, 2)}\n`);
}
