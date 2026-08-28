#!/usr/bin/env node
/**
 * leak-tokens.mjs — the ONE private-token list, shared (FEAT/BUG for the
 * ticket-write leak-guard).
 *
 * This module holds nothing but the token definitions and a `findLeaks(text)`
 * helper over them. It was extracted VERBATIM out of scripts/leak-gate.mjs so
 * there is exactly ONE matcher: the commit-time gate (leak-gate.mjs) and the
 * authoring-time guard (board-tool.mjs `file`/`update`) both import THIS list.
 * Two detectors that disagree would be a worse bug than the one being fixed, so
 * there is only ever this one.
 *
 * SELF-IMMUNITY. Every literal private string is deliberately split
 * ('saa'+'sis') so this file does not trip its own gate when it ships in the
 * public mirror — exactly as leak-gate.mjs did before the split-out. That same
 * convention is how a ticket legitimately DISCUSSES a token shape without
 * leaking it: describe the shape or split the literal; never paste the value.
 * The guard's predicate is identical to the gate's, so anything the guard
 * refuses the gate would also have refused, and anything that passes the guard
 * passes the gate — the guard adds no new false-positive surface, it only moves
 * the same decision earlier (to the moment of writing).
 */

export const TOKENS = [
  { name: 'private project A (bot)',      re: new RegExp('saa' + 'sis', 'i') },
  { name: 'private project B (uploader)', re: new RegExp('img' + 'ixie', 'i') },
  { name: 'private project C',            re: new RegExp('map' + '_of_' + 'world', 'i') },
  { name: 'private project D',            re: new RegExp('job' + '_intel', 'i') },
  { name: 'private project E',            re: new RegExp('reddit' + '_marketing', 'i') },
  { name: 'private project F',            re: new RegExp('trump' + '[_-]muketika', 'i') },
  { name: 'private project G',            re: new RegExp('gpu-' + 'research-lab', 'i') },
  { name: 'private project H (win)',      re: new RegExp('shadow' + '[-_ ]studio', 'i') },
  // I–P (FEAT-104): the class the gate was blind to — private project names that
  // survived at HEAD in ticket prose because no token ever covered them. Each is
  // aliased in the docs as `external-project-<letter>`; the alias note below is
  // the only mapping key, and the real name deliberately appears NOWHERE in the
  // repo (this gate now enforces that). O/P are matched on their distinctive
  // stem so the short forms used in prose are caught too, not just the full name.
  { name: 'private project I (-> external-project-I)', re: new RegExp('workspace' + '-to-text', 'i') },
  { name: 'private project J (-> external-project-J)', re: new RegExp('discord' + '-mcp-bot', 'i') },
  { name: 'private project K (-> external-project-K)', re: new RegExp('\\b' + 'ani' + 'wait\\b', 'i') },
  { name: 'private project L (-> external-project-L)', re: new RegExp('chatbots' + '-tg', 'i') },
  { name: 'private project M (-> external-project-M)', re: new RegExp('crypto' + '_gem', 'i') },
  { name: 'private project N (-> external-project-N)', re: new RegExp('docs' + '-llm', 'i') },
  { name: 'private project O (-> external-project-O)', re: new RegExp('docker' + '_template', 'i') },
  { name: 'private project P (-> external-project-P)', re: new RegExp('remote' + '_wrapper', 'i') },
  // Q (FEAT-049, second pass): found by a DIFFERENT method than remembering a
  // name — enumerating every directory that actually exists under this
  // machine's project roots and grepping the tree for each one. It had survived
  // in an archived ticket's breadth-sweep notes since 2026-08-04.
  { name: 'private project Q (-> external-project-Q)', re: new RegExp('bug' + '-bounty', 'i') },
  // A CLASS THE PROJECT-NAME TOKENS DO NOT COVER (FEAT-049, second pass): words
  // lifted verbatim out of the user's own session transcripts. A verifier that
  // greps a REAL rollout needs a real needle, and the needle it hardcoded was a
  // client's name and their product line. The names below are that incident;
  // the general defence is the rule, not the list — a verifier must DERIVE its
  // needle from the artifact it discovered, never carry one in its source.
  { name: 'client name (transcript content)',   re: new RegExp('kna' + 'uf', 'i') },
  { name: 'client product (transcript content)', re: new RegExp('sad' + 'olin', 'i') },
  { name: 'client product (transcript content)', re: new RegExp('easy' + 'care', 'i') },
  { name: 'client term (transcript content)',    re: new RegExp('sperr' + 'grund', 'i') },
  { name: 'home path',                    re: new RegExp('/home/' + 'sa' + 'p\\b') },
  { name: 'encoded home path',            re: new RegExp('-home-' + 'sa' + 'p\\b') },
  { name: 'encoded win path',             re: new RegExp('C--Users-' + 'sa' + 'p\\b') },
  { name: 'username (bare word)',         re: new RegExp('\\b' + 'sa' + 'p' + '\\b') },
  { name: 'github handle',                re: new RegExp('sa' + 'pn1s', 'i') },
  { name: 'email',                        re: new RegExp('sa' + 'ptional', 'i') },
];

/**
 * THE ONE SANCTIONED EXCEPTION (FEAT-049 licence).
 *
 * Every token above is a leak everywhere — except the copyright line of the
 * LICENSE file, where the licensor's identity is the POINT rather than a slip.
 * PolyForm Noncommercial grants rights from "the licensor" and sends anyone
 * wanting commercial terms to that licensor; a licence naming nobody grants
 * from nobody and gives the reader no one to ask, which is precisely the
 * failure mode of a hand-written licence. The repository is published under
 * this handle, so the handle is public by construction the moment it ships.
 *
 * Scoped as narrowly as it can be, on purpose: ONE file, ONE token, and ONLY
 * on a line matching PolyForm's own `Required Notice:` form. The same handle
 * one line lower in LICENSE, or in any other file, still FAILS. This is an
 * exemption from a token, never a hole in the gate — allowed hits are counted
 * and REPORTED on every run (below), so the exception can never be silent.
 *
 * NOTE: this file-scoped exemption is meaningful only for the whole-repo gate.
 * The ticket-write guard scans ticket CONTENT (never LICENSE), so no allowance
 * applies there — a ticket carrying any token is refused, full stop.
 */
export const ALLOWED_HITS = [
  {
    file: 'LICENSE',
    token: 'github handle',
    line: /^Required Notice: Copyright \d{4} /,
    why: 'the licence must name an identifiable, contactable licensor to be worth anything',
  },
];

export const allowedHitFor = (rel, tokenName, line) =>
  ALLOWED_HITS.find((a) => a.file === rel && a.token === tokenName && a.line.test(line));

/**
 * Scan a block of text for private tokens. Returns one entry per offending
 * (line, token) pair: `{ lineNo (1-based), line, token }`. Callers get the raw
 * material to report a refusal — the same file:line + token-class shape the gate
 * prints — without re-implementing the match. No ALLOWED_HITS logic here: this
 * is for scanning content that has no sanctioned exemption (ticket bodies).
 */
export function findLeaks(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    for (const t of TOKENS) {
      if (t.re.test(line)) out.push({ lineNo: i + 1, line, token: t.name });
    }
  });
  return out;
}
