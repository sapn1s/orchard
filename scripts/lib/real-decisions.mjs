/**
 * Shared helper for the board-decision verifiers (FEAT-090, reachability,
 * FEAT-082 digest).
 *
 * WHY THIS EXISTS — docs/CONVENTIONS.md, "Testing against the real artifact
 * means asserting its INVARIANT PROPERTIES, not values that legitimate use will
 * change." These suites used to name ARCH-003 and pin `recommended === 'B'` and
 * `question === 'fix it properly…'`. Then the user answered ARCH-003 through the
 * UI and a lane overturned its premise (dropping the `Recommended:` token); three
 * suites went red though nothing was broken. A suite that reddens when the user
 * uses the product trains everyone to ignore it.
 *
 * The fix keeps the REAL prose but stops coupling to today's values:
 *   - `discoverRealDecisions` finds, at runtime, whichever real tickets currently
 *     carry a genuine decision block (≥2 bold-lead options) — so the parser is
 *     still exercised on real, paragraph-length, marked-up option prose, without
 *     naming a ticket that answering/overturning will move. It throws LOUDLY if
 *     the board has NO parseable decision at all, since that itself is worth
 *     knowing (the parser would have nothing real to verify against).
 *   - `setRecommendation` drives the `Recommended:` token on that real prose, so
 *     the "valid key survives / bogus key dropped" validation is proved in BOTH
 *     directions against real options while OWNING the one value the test asserts
 *     on — immune to the live Status line changing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const TICKET_FILE_RE = /^[A-Z]+-\d+.*\.md$/;
const STATUS_LINE_RE = /^\s*-?\s*\*\*Status:?\*\*/i;
const RECOMMENDED_TOKEN_RE = /\bRecommended:\s*[A-Za-z0-9]{1,6}\b/i;

/**
 * Every real ticket whose PROSE parses to a decision with ≥`minOptions` keyed
 * options — regardless of whether that ticket currently sits in the decide lane
 * (an answered ticket keeps its decision prose; this tests the PARSER, not the
 * lane). Returns [{ id, name, body, decision }], sorted by id for determinism.
 * Throws loudly when the board carries no such ticket.
 *
 * @param {string} bugsDir              docs/bugs directory
 * @param {(md: string) => any} ticketDecision  the parser under test
 */
export function discoverRealDecisions(bugsDir, ticketDecision, { minOptions = 2 } = {}) {
  const found = [];
  for (const name of fs.readdirSync(bugsDir)) {
    if (!TICKET_FILE_RE.test(name) || /TEMPLATE/.test(name)) continue;
    const body = fs.readFileSync(path.join(bugsDir, name), 'utf8');
    const decision = ticketDecision(body);
    if (decision && (decision.options?.length ?? 0) >= minOptions) {
      found.push({ id: name.match(/^[A-Z]+-\d+/)[0], name, body, decision });
    }
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  if (!found.length) {
    throw new Error(
      `no real ticket on the board parses to a decision with >=${minOptions} options — ` +
      'the decision parser has no real artifact to verify against (worth knowing).');
  }
  return found;
}

/**
 * Return `body` with the `- **Status:**` line's `Recommended:` token set to
 * `key` (replacing an existing token, or appending one if absent). Used to drive
 * the recommendation-validation branch on real option prose without asserting on
 * whatever the live ticket happens to recommend today.
 */
export function setRecommendation(body, key) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => STATUS_LINE_RE.test(l.trim()));
  if (i === -1) throw new Error('setRecommendation: ticket body has no **Status:** line');
  lines[i] = RECOMMENDED_TOKEN_RE.test(lines[i])
    ? lines[i].replace(RECOMMENDED_TOKEN_RE, `Recommended: ${key}`)
    : `${lines[i].replace(/\s*$/, '')} Recommended: ${key}`;
  return lines.join('\n');
}

/** A key that matches no plausible option (for the "bogus token dropped" leg). */
export const NON_OPTION_KEY = 'zqx9';
