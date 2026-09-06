/**
 * BUG-155 — a valid orchard-digest fence renders as JSON when a lead-in precedes it.
 *
 * Two halves are verified against the REAL public/lib/digest.js module, driven
 * through a real DOM (happy-dom) so renderAssistantText produces real nodes:
 *
 *   HALF 1 (floor)     — a body-position orchard-digest NEVER renders raw JSON as
 *                        prose. Valid -> a real .digest rail; malformed -> a
 *                        contained <pre> code block.
 *   HALF 2 (tolerance) — a well-formed fence behind a SHORT lead-in is lifted and
 *                        the lead-in renders as prose ABOVE the rail; a fence
 *                        beyond the bound is NOT lifted (but still not raw JSON).
 *
 * MUST-FAIL: point DIGEST_PATH at the pre-change module (see the ticket's Activity
 * log for the exact command) and the lead-in + floor cases fail there.
 *
 * Env: DIGEST_PATH (default public/lib/digest.js relative to repo root) — the
 * module under test, so the same suite can grade the pre-change code.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIGEST_PATH = process.env.DIGEST_PATH
  ? path.resolve(ROOT, process.env.DIGEST_PATH)
  : path.join(ROOT, 'public', 'lib', 'digest.js');

const win = new Window({ url: 'http://localhost/' });
globalThis.document = win.document;
globalThis.window = win;

const { parseDigest, renderAssistantText } = await import(pathToFileURL(DIGEST_PATH).href);

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  fails.push({ name, detail });
  console.log(`  FAIL: ${name}${detail !== undefined ? `  [${detail}]` : ''}`);
}

/* Render helpers over the produced DOM node. */
const render = (text) => renderAssistantText(text, { enabled: true, projectId: 'p1' });
const hasDigestRail = (node) => !!node.querySelector('.digest');
const digestTexts = (node) => [...node.querySelectorAll('.digest .digest-text')].map((n) => n.textContent);
// The raw-JSON-wall defect: the JSON body appears as a prose <p> (or any non-code
// text) directly, i.e. an "items" string outside a <pre>/<code>.
const rawJsonInProse = (node) => {
  for (const p of node.querySelectorAll('p')) {
    if (/"items"\s*:/.test(p.textContent)) return true;
  }
  return false;
};
const codeBlockText = (node) => [...node.querySelectorAll('pre')].map((n) => n.textContent).join('\n');

const DIGEST = (items) => JSON.stringify({ items });
const fence = (json) => '```orchard-digest\n' + json + '\n```';

/* ── HALF 2 / control: a digest at the very TOP still works ─────────────────── */
{
  const msg = fence(DIGEST([{ text: 'Top item.', kind: 'done', importance: 'high' }])) + '\nBody below.';
  const d = parseDigest(msg);
  check('top: parseDigest lifts a leading fence', !!d && d.items.length === 1, JSON.stringify(d && d.items));
  check('top: before is empty', !!d && !(d.before ?? "").trim(), d && JSON.stringify(d.before));
  const node = render(msg);
  check('top: renders a .digest rail', hasDigestRail(node));
  check('top: rail carries the item', digestTexts(node).includes('Top item.'));
  check('top: no raw JSON in prose', !rawJsonInProse(node));
}

/* ── HALF 2: digest behind a SHORT lead-in is lifted, lead-in ABOVE ─────────── */
{
  const msg = 'Found it.\n\n' + fence(DIGEST([{ text: 'Localhost prefers IPv4 now.', kind: 'done' }])) + '\nMore detail here.';
  const d = parseDigest(msg);
  check('lead-in: parseDigest lifts the fence behind a lead-in', !!d && d.items.length === 1, JSON.stringify(d));
  check('lead-in: the lead-in is captured in before', !!d && (d.before ?? "").trim() === "Found it.", d && JSON.stringify(d.before));
  check('lead-in: rest is the body below', !!d && d.rest.trim() === 'More detail here.', d && JSON.stringify(d.rest));
  const node = render(msg);
  check('lead-in: renders a .digest rail', hasDigestRail(node));
  check('lead-in: NO raw JSON in prose (the bug)', !rawJsonInProse(node));
  // The lead-in prose must appear ABOVE the rail in document order.
  const rail = node.querySelector('.digest');
  const leadInP = [...node.querySelectorAll('p')].find((p) => p.textContent.includes('Found it.'));
  check('lead-in: lead-in prose exists', !!leadInP);
  check('lead-in: lead-in renders ABOVE the rail',
    !!rail && !!leadInP && (rail.compareDocumentPosition(leadInP) & win.Node.DOCUMENT_POSITION_PRECEDING) !== 0);
}

/* Realistic verbatim-style lead-in from the ticket (failure #18). */
{
  const msg = 'Clear recommendation: make localhost prefer IPv4 for that hostname via /etc/gai.conf.\n'
    + fence(DIGEST([
      { text: 'Prefer IPv4 for localhost via /etc/gai.conf.', kind: 'decision', importance: 'high', ref: 'BUG-155' },
      { text: 'Switching modes — this is advice, not a change.', kind: 'fyi' },
    ]));
  const node = render(msg);
  check('ticket#18: renders a .digest rail', hasDigestRail(node));
  check('ticket#18: no raw JSON wall', !rawJsonInProse(node));
  check('ticket#18: both items present', digestTexts(node).length === 2, digestTexts(node).length);
}

/* ── BOUND: a digest BEYOND the lead-in bound is NOT lifted, but the FLOOR still
 *   renders it as a real digest (never raw JSON). ──────────────────────────── */
{
  const longLeadIn = Array.from({ length: 6 }, (_, i) => `Paragraph line number ${i} of a genuinely long body that is not a lead-in.`).join('\n\n');
  const msg = longLeadIn + '\n\n' + fence(DIGEST([{ text: 'Deep digest.', kind: 'fyi' }]));
  const d = parseDigest(msg);
  check('bound: a digest beyond the bound is NOT lifted (before is null)', d === null, JSON.stringify(d && (d.before ?? null)));
  const node = render(msg);
  check('bound: the deep digest still renders as a rail (floor)', hasDigestRail(node));
  check('bound: deep digest NOT raw JSON in prose', !rawJsonInProse(node));
  check('bound: the long body prose survives', node.textContent.includes('Paragraph line number 0'));
}

/* A digest after a CODE FENCE is body content, not a lead-in: not lifted, floor renders it. */
{
  const msg = 'Here is a snippet:\n\n```js\nconst x = 1;\n```\n\n' + fence(DIGEST([{ text: 'After code.', kind: 'done' }]));
  const d = parseDigest(msg);
  check('code-before: not lifted when a code fence precedes the digest', d === null);
  const node = render(msg);
  check('code-before: floor renders the digest as a rail', hasDigestRail(node));
  check('code-before: no raw JSON in prose', !rawJsonInProse(node));
}

/* ── HALF 1: malformed JSON inside a correct fence ─────────────────────────── */
{
  // Malformed LEADING digest (no lead-in): FEAT-083 whole-message-as-prose, and
  // the fence shows as a CODE block, never a prose JSON wall.
  const badJson = '{ "items": [ { "text": "oops", }, ] }'; // trailing commas
  const msg = fence(badJson) + '\nThe rest of the message.';
  const d = parseDigest(msg);
  check('malformed-lead: parseDigest returns null', d === null);
  const node = render(msg);
  check('malformed-lead: not painted as a .digest rail', !hasDigestRail(node));
  check('malformed-lead: NOT a raw JSON prose wall', !rawJsonInProse(node));
  check('malformed-lead: body text survives', node.textContent.includes('The rest of the message.'));
}
{
  // Malformed digest BEHIND a lead-in -> reaches the blocksToNodes floor.
  const badJson = '{ "items": [ { "text": "oops" } ,, ] }';
  const msg = 'Found it.\n' + fence(badJson);
  const d = parseDigest(msg);
  check('malformed-body: parseDigest returns null', d === null);
  const node = render(msg);
  check('malformed-body: not a .digest rail', !hasDigestRail(node));
  check('malformed-body: NOT raw JSON in prose (floor as code block)', !rawJsonInProse(node));
  check('malformed-body: renders inside a <pre> code block', codeBlockText(node).includes('"text"'));
  check('malformed-body: the lead-in still shows', node.textContent.includes('Found it.'));
}

/* ── Two digests in one message ─────────────────────────────────────────────── */
{
  const first = DIGEST([{ text: 'First digest item.', kind: 'done' }]);
  const second = DIGEST([{ text: 'Second digest item.', kind: 'fyi' }]);
  const msg = fence(first) + '\nMiddle prose.\n' + fence(second) + '\nTail prose.';
  const node = render(msg);
  const rails = node.querySelectorAll('.digest');
  check('two-digests: BOTH render as rails', rails.length === 2, rails.length);
  const texts = digestTexts(node);
  check('two-digests: first item present', texts.includes('First digest item.'));
  check('two-digests: second item present', texts.includes('Second digest item.'));
  check('two-digests: no raw JSON in prose', !rawJsonInProse(node));
  check('two-digests: middle + tail prose survive',
    node.textContent.includes('Middle prose.') && node.textContent.includes('Tail prose.'));
}

/* ── Anti-regression: a plain reply with no digest is byte-for-byte prose ────── */
{
  const msg = 'Just a normal reply.\n\nSecond paragraph.';
  const d = parseDigest(msg);
  check('plain: parseDigest returns null', d === null);
  const node = render(msg);
  check('plain: no digest rail', !hasDigestRail(node));
  check('plain: content intact', node.textContent.includes('Just a normal reply.') && node.textContent.includes('Second paragraph.'));
}

/* ── Anti-regression: a digest-only message (no body) still renders just the rail ─ */
{
  const msg = fence(DIGEST([{ text: 'Only a digest.', kind: 'done' }]));
  const node = render(msg);
  check('digest-only: rail renders', hasDigestRail(node));
  check('digest-only: item present', digestTexts(node).includes('Only a digest.'));
}

console.log(`\nBUG-155 digest lead-in/floor: ${pass} passed, ${fail} failed  (module: ${path.relative(ROOT, DIGEST_PATH)})`);
process.exit(fail ? 1 : 0);
