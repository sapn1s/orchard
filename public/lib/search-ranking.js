/**
 * Session-search ranking — FEAT-189.
 *
 * WHY THIS EXISTS. Typing a ticket number (e.g. `164`) into the sidebar finder
 * used to return results ordered by recency alone, so an orchestrator's
 * dispatched worker/verify lanes — which carry ticket ids as titles and vastly
 * outnumber the human's own sessions — buried the one session the user actually
 * opened to work on that ticket. And a bare number matched as a raw substring,
 * so `164` scored a title holding `164790` the same as one holding `FEAT-164`.
 *
 * THE RANK. Lower is better. Two independent signals, relevance first:
 *   1. relevance of the TITLE match (titleMatchRank): a whole ticket token
 *      (`FEAT-164`) beats a standalone number beats a number embedded in a
 *      larger one (`164790`);
 *   2. ORIGIN as a tiebreak within equal relevance: a session the user actually
 *      opened ranks above a "lane" ("less prio", the user's words). "Lane" is the
 *      DECLARED `foldByDefault` fact the server surfaces (session-provenance's
 *      foldsFromDefaultList) — a dispatched/agent lane OR an external programmatic
 *      session Orchard never launched. It is read, never re-derived (ARCH-010),
 *      and it is the SAME fact the nav list folds on, so ranking and folding agree.
 *      Using the narrower `startedBy==='agent'` instead would rank a provenance-
 *      less sdk-cli scratch lane (startedBy falls back to 'user') as the user's
 *      own session (independent-verify r11).
 * Recency breaks any remaining tie, preserving the old newest-first feel.
 *
 * PURE and framework-free so app.js imports it AND a node test exercises it
 * against the real session store (verify-feat-189.mjs).
 */

/** The ticket-id prefixes this board uses. */
const TICKET_PREFIXES = ['feat', 'bug', 'arch', 'deploy'];

/**
 * Parse a finder query into a ticket reference when it looks like one, else
 * null. Accepts a bare number (`164`), a prefixed id (`feat-164`, `feat164`),
 * and the `#`/`ticket=` adornments a user might paste. The number is kept as a
 * string so a leading-zero comparison is never introduced.
 */
export function parseTicketQuery(text) {
  const t = String(text ?? '').trim().toLowerCase();
  let m = /^(\d{1,6})$/.exec(t);
  if (m) return { num: m[1], prefix: null };
  // ONLY the canonical dashed form (`feat-164`). Adorned/dashless variants
  // (`ticket=feat-164`, `#164`, `feat164`) are deliberately NOT ticket queries:
  // the server searches the literal query with rg while this re-derives the
  // token, so those forms cannot classify identically across the two surfaces
  // (independent-verify r14). A user searching a ticket types `164` or `FEAT-164`;
  // anything else falls through to ordinary substring search on both surfaces.
  m = /^(feat|bug|arch|deploy)-(\d{1,6})$/.exec(t);
  if (m) return { num: m[2], prefix: m[1] };
  return null;
}

/**
 * Relevance of a TITLE against a query. Lower is better:
 *   0 — the query names a ticket token present as a whole id (FEAT-164);
 *   1 — a standalone number / an exact non-ticket title match;
 *   2 — a non-ticket prefix match (title starts with the query);
 *   3 — a plain substring (the query sits inside a longer run, e.g. 164790);
 *   4 — no match at all (caller normally filters these out first).
 */
export function titleMatchRank(title, text) {
  const title_l = String(title ?? '').toLowerCase();
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return 4;
  const tq = parseTicketQuery(t);
  if (tq) {
    const prefixes = tq.prefix ? [tq.prefix] : TICKET_PREFIXES;
    // A whole ticket token: `<prefix>-164` with the number not continuing into
    // a longer number (so `FEAT-1640` does NOT match a query of `164`). The
    // leading boundary keeps `xfeat-164` from matching.
    const ticketRe = new RegExp(`(?:^|[^a-z0-9])(?:${prefixes.join('|')})-${tq.num}(?![0-9])`, 'i');
    if (ticketRe.test(title_l)) return 0;
    // The number standing on its own — not part of a longer number.
    const numRe = new RegExp(`(?<![0-9])${tq.num}(?![0-9])`);
    if (numRe.test(title_l)) return 1;
    // Present only as a fragment of a longer number (164 inside 164790).
    return title_l.includes(tq.num) ? 3 : 4;
  }
  if (title_l === t) return 0;
  if (title_l.startsWith(t)) return 2;
  return title_l.includes(t) ? 3 : 4;
}

/**
 * Comparator for session hits. Each hit carries a precomputed:
 *   rank  — titleMatchRank(title, query)  (lower better)
 *   lane  — 1 for a folded-by-default row (dispatched/agent lane OR external
 *           programmatic session), 0 for a session the user opened
 *   rk    — recency key string (ISO-ish), newer sorts first
 * Relevance dominates; lane-vs-own is the within-relevance tiebreak; recency last.
 */
export function compareSessionHits(a, b) {
  return (a.rank - b.rank)
    || (a.lane - b.lane)
    || String(b.rk ?? '').localeCompare(String(a.rk ?? ''));
}
