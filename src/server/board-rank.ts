/**
 * FEAT-095 — order the board by what answering a ticket is WORTH, not by when
 * it was filed.
 *
 * The problem, in the user's words: *"the board currently shows 20 tickets
 * ordered i assume randomly by name or date … if i can answer one ticket and it
 * solves 100 bugs from reoccurring, clearly i should be pushed and given that as
 * extreme priority."*
 *
 * They were right about the cause. `readBoard` emits rows in `INDEX.md` FILE
 * order, and `board.mjs gen` only ever APPENDS a newly-filed ticket to the
 * bottom of that file. So the order on screen is the order tickets were created,
 * forever — and `summary.focus`, which is injected into every launched session's
 * system prompt as "the project's focus", was simply the OLDEST 👤 row. The
 * ticket that collapses eight others sat at position 35 of 35.
 *
 * ── What this ranks on, and why it is not a new field ──────────────────────
 *
 * Nothing here asks a human to maintain a priority number. Every input is a
 * field the ticket record already carries and the schema already validates:
 *
 *   `related[]`             — the reconciled relation graph (`blocks`,
 *                             `depends_on`, `recurrence_of`, …), both directions.
 *   `recurrence_evidence[]` — the prior instances an architecture ticket names.
 *   `human_action`          — `decide` / `review` / `none`: whether this ticket
 *                             is stuck ON THE USER or is work nobody waits on.
 *   `severity`              — the declared enum.
 *
 * The load-bearing quantity is `settlesOpen`: **how many OTHER STILL-OPEN
 * tickets stop needing their own answer once this one is answered.** That is the
 * "one ticket solves a hundred" the user asked for, and it is a set of ticket
 * IDs, not an opinion — which is why `why` can name them and the user can check
 * the claim by opening them.
 *
 * ── What was TESTED and rejected ───────────────────────────────────────────
 *
 * The obvious ranking — "count what this ticket transitively BLOCKS" — does not
 * work on this board, and it is worth recording so nobody rebuilds it. Measured
 * over the real 200 records: 98 `blocks` and 100 `depends_on` edges exist, but
 * among the 34 currently-open tickets the blocks-graph is almost empty — the
 * highest any open ticket scores is ONE, and ARCH-010, the ticket that motivated
 * this work, blocks nothing at all. Ranking on `blocks` alone would have put the
 * board's single highest-impact ticket in a four-way tie for first with three
 * unrelated ones.
 *
 * `see_also` is the densest relation (534 of 777 edges) and was also rejected:
 * it is its OWN inverse, so it is undirected. It can say two tickets are about
 * the same thing; it can never say that answering A settles B. Using its degree
 * would have tied ARCH-010 (4) with BUG-114 (4), which nothing settles.
 *
 * What DOES carry the signal is `recurrence_evidence[]` — the explicit,
 * directed "these are the instances I account for" list. It is why ARCH-010
 * (8 recorded instances, 4 of them still open) leads the second-placed ticket by
 * a factor of two rather than by a tie-break.
 *
 * ── Ordering is ordering: nothing is filtered ──────────────────────────────
 *
 * `rankLane` returns a PERMUTATION of what it is given. Every row the board
 * showed before still appears, and a ticket with no `orchard-ticket` record at
 * all (four on this board) degrades to its severity and keeps its place in the
 * list rather than vanishing. `verify-board-rank.mjs` asserts the permutation
 * property directly, because a ranking that quietly drops the tail is worse than
 * no ranking.
 */
import * as fs from 'node:fs';
import { extractTicketBlock } from '../../scripts/lib/ticket-schema.mjs';
import type { HumanAction, Relation, Severity } from '../../scripts/lib/ticket-schema.mjs';

/** The subset of an `orchard-ticket` record this module reads. */
export interface RankRecord {
  id: string;
  severity: Severity | null;
  humanAction: HumanAction | null;
  related: Array<{ id: string; relation: Relation }>;
  recurrenceEvidence: string[];
}

/** The ranking attached to one board row. */
export interface Rank {
  /** Higher sorts first. A pure function of the fields documented above. */
  score: number;
  /** Other STILL-OPEN ticket ids this one settles. The auditable part. */
  settlesOpen: string[];
  /** Recorded instances of the same class that are already closed. */
  priorInstances: number;
  /** A few words the user can check, or null when the row has nothing to claim. */
  why: string | null;
}

/**
 * Weights. Deliberately small integers with named meanings rather than a tuned
 * model: the point of constraint 1 ("the top of the list must be defensible") is
 * that a person can re-derive a row's position by reading it.
 *
 * `SETTLES` dominates by an order of magnitude because it is the only term that
 * answers the user's actual question. `PRIOR` is a third of it: a closed prior
 * instance is evidence the class is real and recurring, but closing it again
 * saves nobody a decision. `WAITING` encodes constraint 2 — the user's time is
 * the scarce resource, so a ticket that cannot move without them outranks work
 * an agent could pick up. Severity is the multiplier of last resort, used to
 * break ties inside a lane rather than to lead it.
 */
const W_SETTLES = 10;
const W_PRIOR = 3;
const W_WAITING_DECIDE = 6;
const W_WAITING_REVIEW = 3;
const SEV_WEIGHT: Record<string, number> = { high: 4, medium: 2, not_recorded: 1, low: 0 };

/** `human_action` values that mean "this cannot move until the user acts". */
const DECIDE_ACTIONS = new Set<string>(['decide', 'staged_decision', 'multi_select_decision', 'answer_question']);

/**
 * Read the `orchard-ticket` record off a ticket file, via the schema module's
 * OWN block extractor — not a second regex for the same grammar (ARCH-008 is
 * open precisely because that grammar got implemented twice).
 *
 * A file with no block, an unparseable block, or a read error returns `null`.
 * That is a supported state, not a failure: four tickets on the real board have
 * no record yet, and they must still rank and still render.
 */
export function readRankRecord(file: string | null | undefined): RankRecord | null {
  if (!file) return null;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { block } = extractTicketBlock(text);
  if (block === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(block); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  if (!id) return null;
  const related: Array<{ id: string; relation: Relation }> = [];
  if (Array.isArray(r.related)) {
    for (const e of r.related) {
      if (!e || typeof e !== 'object') continue;
      const eid = (e as Record<string, unknown>).id;
      const rel = (e as Record<string, unknown>).relation;
      if (typeof eid === 'string' && typeof rel === 'string') related.push({ id: eid, relation: rel as Relation });
    }
  }
  const recurrenceEvidence = Array.isArray(r.recurrence_evidence)
    ? r.recurrence_evidence.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    id,
    severity: typeof r.severity === 'string' ? (r.severity as Severity) : null,
    humanAction: typeof r.human_action === 'string' ? (r.human_action as HumanAction) : null,
    related,
    recurrenceEvidence,
  };
}

/**
 * For every id in `openIds`, the set of OTHER OPEN ids that answering it settles,
 * and separately the count of already-recorded instances of the same class.
 *
 * SETTLEMENT is the ranking quantity, and only DIRECTED claims may contribute to
 * it — three sources, unioned, because one ticket can carry the same claim twice
 * and must not be counted twice:
 *
 *   1. its own `recurrence_evidence[]` — an architecture ticket's explicit
 *      "these are the instances I account for". This is the strongest signal on
 *      the board and the only one that scales past one or two.
 *   2. its own `blocks` edges          — "these cannot proceed until I do".
 *   3. others' `depends_on` → it       — the reconciled inverse of (2). Safe to
 *      use because `blocks`/`depends_on` is the schema's one ASYMMETRIC pair, so
 *      the back-edge restates a direction rather than inventing one.
 *
 * `recurrence_of` is deliberately NOT a settlement source, and this was a real
 * defect caught before it shipped. `RELATION_INVERSE` maps `recurrence_of` to
 * ITSELF, so the edge is symmetric: BUG-120 recording "I am a recurrence of
 * BUG-104" produces an identical edge in both directions, and crediting both
 * ends made each of the pair claim to settle the other. The measured effect on
 * the real board was that BUG-104 and BUG-120 both scored a settlement they did
 * not earn, and ARCH-006/FEAT-091 formed the same mutual pair — the graph
 * asserting, of two tickets, that answering either one settles the other. A
 * symmetric edge cannot express "answering A settles B"; it can only say the two
 * are instances of one problem. So it is counted as CLASS EVIDENCE instead,
 * where "the same problem has been filed before" is exactly what it means.
 *
 * Self-edges are dropped defensively. The schema rejects them (BUG-128) but this
 * reads whatever is on disk, and a self-edge would inflate a ticket's own score.
 *
 * Settlement is restricted to `openIds` on BOTH ends: settling a ticket that is
 * already closed saves the user nothing. A settlement claim naming a CLOSED
 * ticket is not discarded, though — it becomes class evidence, because a class
 * with three fixed instances is a class that keeps coming back.
 */
export function settlementGraph(
  records: Map<string, RankRecord | null>,
  openIds: Set<string>,
): Map<string, { settlesOpen: string[]; priorInstances: number }> {
  const out = new Map<string, { settlesOpen: string[]; priorInstances: number }>();
  const settles = new Map<string, Set<string>>();   // id → what answering it settles
  const sameClass = new Map<string, Set<string>>(); // id → tickets recorded as the same problem
  for (const id of openIds) { settles.set(id, new Set()); sameClass.set(id, new Set()); }

  for (const id of openIds) {
    const rec = records.get(id);
    if (!rec) continue;
    const s = settles.get(id)!;
    for (const x of rec.recurrenceEvidence) if (x !== id) s.add(x);
    for (const e of rec.related) {
      if (e.id === id) continue;
      if (e.relation === 'blocks') s.add(e.id);
      // Symmetric by construction — evidence the class recurs, never a claim
      // that answering this one settles the other end.
      if (e.relation === 'recurrence_of') sameClass.get(id)!.add(e.id);
    }
  }
  // The asymmetric back-edge: whoever declares it depends_on X is settled by X.
  // Symmetric relations are read in the OWNING direction above and never here.
  for (const [from, rec] of records) {
    if (!rec) continue;
    for (const e of rec.related) {
      if (e.id === from) continue;
      if (e.relation === 'depends_on' && settles.has(e.id)) settles.get(e.id)!.add(from);
      if (e.relation === 'recurrence_of' && sameClass.has(e.id)) sameClass.get(e.id)!.add(from);
    }
  }

  for (const [id, s] of settles) {
    const settlesOpen = [...s].filter((x) => openIds.has(x)).sort();
    // Class evidence = same-class edges, plus settlement claims that name a
    // ticket already closed. Union'd so one ticket appearing in both is one
    // instance, not two.
    const prior = new Set<string>(sameClass.get(id));
    for (const x of s) if (!openIds.has(x)) prior.add(x);
    prior.delete(id);
    out.set(id, { settlesOpen, priorInstances: prior.size });
  }
  return out;
}

/**
 * The auditable sentence. Constraint 1 is that the top of the list must be
 * checkable in a few words — "answering this settles four other open tickets:
 * ARCH-004, ARCH-005, ARCH-006 +1", not a score.
 *
 * It NAMES the ids (up to three, then a count) so the claim can be falsified by
 * opening them. A row that settles nothing and repeats nothing gets `null`
 * rather than a filler phrase: a reason on every row is a reason on none.
 */
function whyLine(settlesOpen: string[], priorInstances: number): string | null {
  if (settlesOpen.length) {
    const shown = settlesOpen.slice(0, 3).join(', ');
    const rest = settlesOpen.length - Math.min(3, settlesOpen.length);
    const tail = rest > 0 ? `${shown} +${rest} more` : shown;
    const n = settlesOpen.length;
    return `answering this settles ${n} other open ticket${n === 1 ? '' : 's'}: ${tail}`;
  }
  if (priorInstances >= 2) return `${priorInstances} earlier tickets were the same problem`;
  if (priorInstances === 1) return 'this has been filed once before';
  return null;
}

/** The score for one row. Pure; every term is documented at its weight above. */
export function scoreOf(rec: RankRecord | null, sevFallback: string, settlesOpen: string[], priorInstances: number): number {
  const sevKey = rec?.severity ?? normaliseSev(sevFallback);
  const waiting = rec?.humanAction && DECIDE_ACTIONS.has(rec.humanAction)
    ? W_WAITING_DECIDE
    : rec?.humanAction === 'review' ? W_WAITING_REVIEW : 0;
  return settlesOpen.length * W_SETTLES
    + priorInstances * W_PRIOR
    + waiting
    + (SEV_WEIGHT[sevKey] ?? SEV_WEIGHT.not_recorded);
}

/**
 * The INDEX severity CELL is prose (`med`, `high`, sometimes blank) while the
 * record's is an enum. This is only reached for a row with no record, so it is a
 * degradation path, not a second source of truth.
 */
function normaliseSev(raw: string): string {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('high')) return 'high';
  if (s.startsWith('med')) return 'medium';
  if (s.startsWith('low')) return 'low';
  return 'not_recorded';
}

/** A board row, as much of it as ranking needs. */
export interface RankableRow { id: string; sev?: string; file?: string }

/**
 * Rank the lanes of a board.
 *
 * `lanes` are the ALREADY-CLASSIFIED open lanes (needs-you, answered-awaiting,
 * in-flight, queued). Everything appearing in any of them is "open" for the
 * purpose of `settlesOpen` — that is the honest reading of "another open ticket
 * this would settle", and it matches what the user can see on the board.
 *
 * Returns a rank per id. Sorting is the caller's, so a lane the route later
 * merges runtime cards into (a live session's question, a stall card) keeps its
 * own deliberate placement.
 */
export function rankRows(lanes: RankableRow[][]): Map<string, Rank> {
  const rows: RankableRow[] = ([] as RankableRow[]).concat(...lanes);
  const openIds = new Set(rows.map((r) => r.id));
  const records = new Map<string, RankRecord | null>();
  for (const r of rows) if (!records.has(r.id)) records.set(r.id, readRankRecord(r.file));
  const graph = settlementGraph(records, openIds);

  const out = new Map<string, Rank>();
  for (const r of rows) {
    const g = graph.get(r.id) ?? { settlesOpen: [], priorInstances: 0 };
    const rec = records.get(r.id) ?? null;
    out.set(r.id, {
      score: scoreOf(rec, r.sev ?? '', g.settlesOpen, g.priorInstances),
      settlesOpen: g.settlesOpen,
      priorInstances: g.priorInstances,
      why: whyLine(g.settlesOpen, g.priorInstances),
    });
  }
  return out;
}

/**
 * Sort one lane by score, descending. STABLE: rows the ranking cannot separate
 * keep the order they arrived in, so an unranked board is left exactly as it was
 * rather than being scrambled into a different arbitrary order.
 *
 * The output is a PERMUTATION of the input — same length, same ids. Constraint
 * 3: re-order, never filter.
 */
export function rankLane<T extends { id: string }>(lane: T[], ranks: Map<string, Rank>): T[] {
  return lane
    .map((row, i) => ({ row, i, s: ranks.get(row.id)?.score ?? 0 }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.row);
}
