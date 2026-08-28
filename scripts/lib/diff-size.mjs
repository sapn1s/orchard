/**
 * diff-size.mjs — FEAT-107. The PURE half of "how big was the change a lane
 * produced". No I/O, no git spawning, no model calls. `cost-collect.mjs` does
 * the reading (ticket files, `git show --numstat`); this file decides how a set
 * of recorded commits is attributed to lanes and tickets, and what the honest
 * aggregate is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The collector measures tokens, wall clock, cost, phase and model tier — and
 * NOTHING about the size of the diff. So there is no way to tell whether an
 * intervention aimed at making agents write less code did anything, or to
 * separate a real effect from placebo. Added lines are a PROXY, never a score:
 * a smaller diff that fails verification twice is a loss, which is why every
 * number here is reported next to the lane's verify rounds and verdicts rather
 * than on its own (see cost-collect.mjs printDiffs).
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SHAS COME FROM — the BUG-154 convention, reused not reinvented
 * ---------------------------------------------------------------------------
 * BUG-154 established that a ticket records the commit that closed it, in its
 * Activity log, in prose: "Committed as 303f851 (files). Not pushed." The shas
 * are read out of that prose (`extractRecordedShas`), validated as real commits
 * by the caller, and their `git diff --numstat` is the source of truth. We do
 * NOT invent a second mechanism (e.g. `git log --grep=BUG-154`): the ticket
 * naming its own commit is the declared fact; a message search is a re-derivation
 * a reader would do, and re-derivation is exactly what ARCH-010 says to stop.
 *
 * ---------------------------------------------------------------------------
 * THE ATTRIBUTION RULE (stated, because a quietly-dropped number is worse than
 * no number)
 * ---------------------------------------------------------------------------
 * A commit's numstat is NEVER split across lanes — a diff is one indivisible
 * artifact. The question is "which lane's WORK is in this commit", not "who was
 * running at the instant it was authored": in this fleet a worker does NOT press
 * commit (the user commits by hand, often well after the lane ended), so a rule
 * that required the commit timestamp to fall inside the lane's window would leave
 * EVERY fix lane's diff unattributable — the instrument would be structurally
 * empty now and in any future experiment. So each recorded commit on ticket T is
 * attributed to at most one lane whose `primary_ticket === T`, in this order:
 *
 *   - `window` (strong): the commit's author time falls inside exactly one
 *     lane's [started_at, ended_at]. That lane both did the work and committed it.
 *   - `preceding` (inferred by recency): otherwise, the lane on T that had most
 *     recently been working by the commit time — the latest lane to START at or
 *     before it. This is the lane whose work the commit most plausibly captures
 *     when a human committed it afterward. Labelled, so a report never passes
 *     recency off as certainty.
 *   - UNATTRIBUTED otherwise, with a reason: `commit-precedes-lanes` (the commit
 *     is older than any collected lane on the ticket — e.g. pre-transcript
 *     history), `no-lane-for-ticket` (no collected lane names it), or
 *     `commit-has-no-date`.
 *
 * The three cases the charter names, mapped onto this rule:
 *   - "a commit may contain more than one lane's work": it is still attributed
 *     to ONE lane (the latest round whose work it captures). Earlier rounds'
 *     work folded into a squashed commit is a KNOWN over-attribution to that
 *     lane, stated, not hidden — we never fabricate a per-lane split of one diff.
 *   - "a lane may produce no commit": that lane simply has no attributed diff.
 *     It is NOT counted as a zero-line change (which would read as a "win"); it
 *     is absent from the per-class median entirely, and counted in `no_commit`.
 *   - "several commits across rounds": each commit is attributed to the latest
 *     round that had started by its time, so interleaved round/commit history
 *     maps commit-of-round-k to the round-k lane.
 *
 * Per TICKET, every recorded commit is summed regardless of lane attribution —
 * a ticket's total diff is a fact about the ticket even when we cannot say which
 * lane authored which line. `attributed` vs `unattributed` is reported per
 * ticket so the gap is visible. A sha recorded on MORE THAN ONE ticket is a
 * shared commit: it counts toward each ticket that names it (double-counting at
 * the ticket level is correct — both tickets claim it) but the fleet TOTAL dedups
 * by sha, and shared shas are listed so the overlap is auditable.
 */

/* ------------------------------------------------------ sha extraction */

/**
 * Every commit sha RECORDED in a ticket's prose, in first-mention order, deduped.
 *
 * Matches a hex run of 7-40 chars that is introduced by a commit/sha keyword —
 * "committed as 303f851", "commit `d302908`", "sha e9432ae6", "Committed 6b5b061".
 * The keyword requirement is deliberate: a bare hex run in prose ("see line
 * ab12cd3") must not be read as a commit. The caller still VALIDATES each
 * candidate against the real object store, so a labelled-but-wrong sha is dropped
 * with a reason rather than trusted.
 *
 * Returns lowercased shas. Case-insensitive on the keyword and the hex.
 */
const SHA_RE = /\b(?:commit(?:ted)?|sha)\b(?:\s+as)?\s*[:=]?\s*`?\b([0-9a-fA-F]{7,40})\b/gi;

export function extractRecordedShas(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(SHA_RE)) {
    const sha = m[1].toLowerCase();
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}

/* ------------------------------------------------------ numstat parsing */

/**
 * Parse the body of `git show --numstat --format=` (or `git diff --numstat`)
 * into `{ added, deleted, files, binary_files }`.
 *
 * Each data line is `<added>\t<deleted>\t<path>`. A binary file is recorded by
 * git as `-\t-\t<path>`: it has a real change but no line count, so it counts
 * toward `files` and `binary_files` and contributes 0 to added/deleted (stated,
 * not silently coerced to 0-as-if-empty). Blank lines and a leading commit-format
 * line are ignored.
 */
export function parseNumstat(text) {
  let added = 0;
  let deleted = 0;
  let files = 0;
  let binary_files = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!m) continue; // e.g. the commit sha/date header line if a format leaked in
    files++;
    if (m[1] === '-' || m[2] === '-') {
      binary_files++;
      continue;
    }
    added += Number(m[1]);
    deleted += Number(m[2]);
  }
  return { added, deleted, files, binary_files };
}

/* ------------------------------------------------------ small helpers */

export function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

const emptyTotals = () => ({ added: 0, deleted: 0, files: 0, binary_files: 0, commits: 0 });

function addInto(acc, stat) {
  acc.added += stat.added;
  acc.deleted += stat.deleted;
  acc.files += stat.files;
  acc.binary_files += stat.binary_files;
  acc.commits += 1;
}

/* ------------------------------------------------------ attribution */

/**
 * Attribute recorded commits to lanes and tickets.
 *
 * Inputs (all plain data — the caller did the git I/O):
 *   - `lanes`: [{ lane_id, primary_ticket, started_at, ended_at,
 *                 dispatch_class, dispatch_class_source, round, verdict }]
 *   - `ticketShas`: Map<ticketId, string[]>  (recorded, ALREADY validated)
 *   - `commitStats`: Map<sha, { added, deleted, files, binary_files, at_ms }>
 *
 * Returns a structure the reporter prints verbatim — see the module header for
 * the rule. Pure: mutates nothing it was given.
 */
export function attributeDiffs({ lanes = [], ticketShas = new Map(), commitStats = new Map() } = {}) {
  // Index lanes by ticket, with their window in ms, once.
  const lanesByTicket = new Map();
  const laneById = new Map();
  for (const l of lanes) {
    const rec = {
      lane_id: l.lane_id,
      primary_ticket: l.primary_ticket ?? null,
      start_ms: ms(l.started_at),
      end_ms: ms(l.ended_at),
      dispatch_class: l.dispatch_class ?? null,
      dispatch_class_source: l.dispatch_class_source ?? null,
      round: l.round ?? null,
      verdict: l.verdict ?? null,
      diff: emptyTotals(),
      commit_shas: [],
    };
    laneById.set(l.lane_id, rec);
    if (rec.primary_ticket) {
      if (!lanesByTicket.has(rec.primary_ticket)) lanesByTicket.set(rec.primary_ticket, []);
      lanesByTicket.get(rec.primary_ticket).push(rec);
    }
  }

  // Which tickets name each sha (to detect shared commits).
  const ticketsBySha = new Map();
  for (const [ticket, shas] of ticketShas) {
    for (const sha of shas) {
      if (!ticketsBySha.has(sha)) ticketsBySha.set(sha, new Set());
      ticketsBySha.get(sha).add(ticket);
    }
  }

  const perTicket = new Map();
  const unattributed = []; // { ticket, sha, reason, added, deleted, files }
  const provenance = {}; // window / preceding -> count, so recency is never sold as certainty
  const globalSeen = new Set();
  const globalTotal = emptyTotals();
  const shared = []; // { sha, tickets: [...] }

  for (const [ticket, shas] of ticketShas) {
    const t = {
      ticket,
      total: emptyTotals(),
      attributed: emptyTotals(),
      unattributed: emptyTotals(),
      commits: [],
      missing_stats: [], // recorded shas we had no numstat for (caller couldn't resolve)
    };
    perTicket.set(ticket, t);

    for (const sha of shas) {
      const stat = commitStats.get(sha);
      if (!stat) {
        t.missing_stats.push(sha);
        continue;
      }
      addInto(t.total, stat);
      if (!globalSeen.has(sha)) {
        globalSeen.add(sha);
        addInto(globalTotal, stat);
      }

      // Attribute to the lane whose work this commit represents.
      const laneCands = lanesByTicket.get(ticket) ?? [];
      const pick = pickLaneFor(laneCands, stat.at_ms);
      const rec = { sha, ...stat, attributed_to: null, provenance: null, reason: null };
      if (pick.lane) {
        addInto(pick.lane.diff, stat);
        pick.lane.commit_shas.push(sha);
        addInto(t.attributed, stat);
        rec.attributed_to = pick.lane.lane_id;
        rec.provenance = pick.provenance;
        provenance[pick.provenance] = (provenance[pick.provenance] ?? 0) + 1;
      } else {
        addInto(t.unattributed, stat);
        rec.reason = pick.reason;
        unattributed.push({ ticket, sha, reason: pick.reason, added: stat.added, deleted: stat.deleted, files: stat.files });
      }
      t.commits.push(rec);
    }
  }

  for (const [sha, tickets] of ticketsBySha) {
    if (tickets.size > 1 && commitStats.has(sha)) shared.push({ sha, tickets: [...tickets] });
  }

  // Per-class median of added lines, over lanes that received at least one
  // attributed commit. A lane with no commit is EXCLUDED (not counted as 0) —
  // "no diff" is not "a zero-line diff", and treating it as one would bias the
  // median down and read a non-event as a win.
  const byClass = new Map();
  let laneWithCommit = 0;
  for (const lane of laneById.values()) {
    if (!lane.commit_shas.length) continue;
    laneWithCommit++;
    const cls = lane.dispatch_class ?? '(unclassified)';
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(lane);
  }
  const classMedians = [...byClass.entries()].map(([cls, ls]) => ({
    dispatch_class: cls,
    lanes: ls.length,
    median_added: median(ls.map((l) => l.diff.added)),
    median_deleted: median(ls.map((l) => l.diff.deleted)),
    median_files: median(ls.map((l) => l.diff.files)),
    total_added: ls.reduce((a, l) => a + l.diff.added, 0),
    verdicts: tallyVerdicts(ls),
    declared_fraction: ls.filter((l) => l.dispatch_class_source === 'declared').length + '/' + ls.length,
  })).sort((a, b) => b.lanes - a.lanes);

  return {
    lanes: [...laneById.values()],
    perTicket: [...perTicket.values()],
    unattributed,
    shared,
    provenance,
    globalTotal,
    classMedians,
    counts: {
      lanes: laneById.size,
      lanes_with_commit: laneWithCommit,
      lanes_no_commit: laneById.size - laneWithCommit,
      tickets_with_shas: perTicket.size,
      // A commit shared across N tickets is N ticket->commit LINKS. Attribution
      // is per link, so link counts are the consistent denominator; `unique_commits`
      // is the deduped fleet count and differs by exactly the shared overlap.
      unique_commits: globalSeen.size,
      links_total: (provenance.window ?? 0) + (provenance.preceding ?? 0) + unattributed.length,
      links_attributed_window: provenance.window ?? 0,
      links_attributed_preceding: provenance.preceding ?? 0,
      links_unattributed: unattributed.length,
      shared_commits: shared.length,
    },
  };
}

/**
 * Pick the lane whose WORK a commit represents. See the module header for the
 * rule. Returns `{ lane, provenance }` on a hit, `{ lane: null, reason }` when a
 * commit cannot be tied to any collected lane on the ticket.
 */
function pickLaneFor(candidates, at_ms) {
  if (at_ms == null) return { lane: null, reason: 'commit-has-no-date' };
  if (!candidates.length) return { lane: null, reason: 'no-lane-for-ticket' };
  const inWindow = candidates.filter(
    (l) => l.start_ms != null && l.end_ms != null && at_ms >= l.start_ms && at_ms <= l.end_ms,
  );
  if (inWindow.length === 1) return { lane: inWindow[0], provenance: 'window' };
  // Either no window contains it (human committed later) or several do
  // (concurrent lanes). In both cases fall to recency: the lane that had most
  // recently begun working by the commit time.
  const started = candidates.filter((l) => l.start_ms != null && l.start_ms <= at_ms);
  if (!started.length) return { lane: null, reason: 'commit-precedes-lanes' };
  started.sort(
    (a, b) => (b.end_ms ?? b.start_ms) - (a.end_ms ?? a.start_ms) || String(a.lane_id).localeCompare(String(b.lane_id)),
  );
  return { lane: started[0], provenance: 'preceding' };
}

function tallyVerdicts(lanes) {
  const t = {};
  for (const l of lanes) if (l.verdict) t[l.verdict] = (t[l.verdict] ?? 0) + 1;
  return t;
}

/**
 * The last N fix-class lanes that produced an attributed commit, newest first.
 *
 * "fix-class" = the RESOLVED dispatch class is `fix` (declared or inferred; the
 * source is carried through so a report can say which). "closed / produced work"
 * is read as "has at least one attributed commit" — a fix lane that committed
 * nothing has no diff to baseline. This is the artifact a future experiment
 * compares its own diff sizes against, so it is returned as data, not printed.
 */
export function fixClassBaseline(attributed, n = 20) {
  const fix = attributed.lanes
    .filter((l) => l.dispatch_class === 'fix' && l.commit_shas.length > 0)
    .sort((a, b) => (b.end_ms ?? 0) - (a.end_ms ?? 0))
    .slice(0, n);
  return {
    n: fix.length,
    requested: n,
    lanes: fix.map((l) => ({
      lane_id: l.lane_id,
      ticket: l.primary_ticket,
      round: l.round,
      class_source: l.dispatch_class_source,
      added: l.diff.added,
      deleted: l.diff.deleted,
      files: l.diff.files,
      commits: l.diff.commits,
      verdict: l.verdict,
    })),
    median_added: median(fix.map((l) => l.diff.added)),
    median_deleted: median(fix.map((l) => l.diff.deleted)),
    median_files: median(fix.map((l) => l.diff.files)),
    total_added: fix.reduce((a, l) => a + l.diff.added, 0),
    verdicts: tallyVerdicts(fix),
  };
}
