#!/usr/bin/env node
/**
 * FEAT-091 — response-format layer 2: block grammar, fallback metrics, hook
 * integration, injection, and onboarding delivery.
 *
 *   node scripts/verify-feat-091-response-blocks.mjs
 *
 * Everything here drives the REAL artifacts: the real parser, the real Stop hook
 * as a child process over real JSONL transcripts, the real composeInstructions
 * against the REAL committed docs/prompts/RESPONSE_FORMAT.md (not a fixture — a
 * fixture would prove the mechanism while the shipped doc silently failed to
 * inject), and a REAL `onboard.mjs` run into a scratch directory.
 *
 * Two deliberate realism choices, per the working agreement:
 *   - [4] grades a BUSY, realistic reply (digest + repeated blocks + code + a
 *     bulleted uncategorized run), not the minimal case that proves the mechanism.
 *   - [3] truncates the metrics JSONL at several points, because the hook appends
 *     to it while a reader may be running: a complete fixture cannot prove a
 *     concurrent reader safe.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * BUG-118 (round 2): the Stop hook grades only the session its ORCHARD_SESSION
 * marker NAMES — a presence flag was inherited by nested hand-started sessions.
 * These suites test the GRADER, so each run declares itself the owner of the
 * payload it sends, injecting a session id when a fixture omits one (a real Stop
 * payload always carries one). The launcher gate is BUG-118's own suite.
 */
const SUITE_SESSION_ID = '0b118000-0000-4000-8000-000000000118';
const ownPayload = (o) => (o && typeof o === 'object' && typeof o.session_id !== 'string')
  ? { ...o, session_id: SUITE_SESSION_ID } : o;
const ownMarker = (o) => (o && typeof o?.session_id === 'string') ? o.session_id : SUITE_SESSION_ID;
/** Same, for suites that feed RAW stdin (including deliberate garbage). */
function ownRaw(input) {
  try {
    const o = JSON.parse(input);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const p = ownPayload(o);
      return { input: JSON.stringify(p), marker: ownMarker(p) };
    }
  } catch { /* garbage stays garbage: the hook must fail open on it */ }
  return { input, marker: SUITE_SESSION_ID };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOOK = path.join(HERE, 'hooks', 'response-format-gate.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat091-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat091-data-'));

let pass = 0, fail = 0;
const failures = [];
const skipped = [];
/**
 * Declare a section unrunnable in THIS environment, with the reason. A missing
 * environment prerequisite is not a failing assertion, and reporting it as one
 * costs an independent verifier time chasing their own sandbox. Skips are counted
 * and printed in the total so they can never quietly hollow out the suite.
 */
function skip(what, why) {
  skipped.push(`${what} — ${why}`);
  console.log('  SKIP  ' + what + '\n          reason: ' + why);
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '\n          observed: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  }
}

const B3 = '```';
const B4 = '````';

async function main() {
  const { parseResponseBlocks, KNOWN_BLOCKS, CATEGORY_BLOCKS, LEGACY_BLOCKS, COLLAPSED_BLOCKS, EXPANDED_BLOCKS, characterise } =
    await import(path.join(ROOT, 'public', 'lib', 'response-blocks.js'));
  const { recordTurn, summariseMetrics, buildRecord, formatReport } =
    await import(path.join(ROOT, 'scripts', 'lib', 'format-metrics.mjs'));

  /* ══ [1] the grammar ═════════════════════════════════════════════════════ */
  console.log('\n[1] block grammar');

  // ROUND 12 — the SEMANTIC vocabulary. Pinned exactly, in order, because the set
  // is the feature: a name silently added or dropped changes what the injected
  // core promises and what the metrics can ever say.
  check('the semantic category set is exactly the six + the declared fallback',
    JSON.stringify(CATEGORY_BLOCKS) === JSON.stringify([
      'orchard-finding', 'orchard-outcome', 'orchard-ask',
      'orchard-judgment', 'orchard-status', 'orchard-narration',
      'orchard-uncategorized',
    ]),
    CATEGORY_BLOCKS);
  // MIGRATION. The two presentation-era names are FROZEN, not removed: stored
  // transcripts are full of them and must keep rendering exactly as they did.
  check('the legacy names are still known',
    JSON.stringify(LEGACY_BLOCKS) === JSON.stringify(['orchard-answer', 'orchard-notes']),
    LEGACY_BLOCKS);
  check('vocabulary is the categories + the legacy names + the digest',
    JSON.stringify(KNOWN_BLOCKS) === JSON.stringify([...CATEGORY_BLOCKS, ...LEGACY_BLOCKS, 'orchard-digest']),
    KNOWN_BLOCKS);
  // THE HIDING SURFACE IS BOUNDED BY A PROPERTY, NOT BY A LIST. This used to pin
  // the literal set, and round 13 (FEAT-093) added `finding` to it at the user's
  // request — at which point a literal pin only records that a change happened.
  // What must stay true is the DIRECTION: a category the reader MUST SEE to know
  // where they stand can never be made invisible. Round 14 (this ticket) narrowed
  // that non-negotiable set to the digest, the ask and the status — the headline,
  // what needs you, where it stands. The supporting record — what is true, the
  // full retrospective of what I changed, the reasoning behind a call I made, and
  // the play-by-play of establishing it — may fold. The declared fallback and the
  // legacy visible name also stay expanded. This check fails LOUDLY if a future
  // round folds one of the must-see names.
  const ADDRESSED_TO_READER = [
    'orchard-ask', 'orchard-status', 'orchard-digest',
    'orchard-uncategorized', 'orchard-answer',
  ];
  check('nothing the reader must see can ever be folded',
    ADDRESSED_TO_READER.every((n) => !COLLAPSED_BLOCKS.includes(n)),
    { collapsed: COLLAPSED_BLOCKS, addressed: ADDRESSED_TO_READER });
  check('the fold holds the supporting record only: finding + outcome + judgment + narration (+ legacy alias)',
    JSON.stringify([...COLLAPSED_BLOCKS].sort())
      === JSON.stringify(['orchard-finding', 'orchard-judgment', 'orchard-narration', 'orchard-notes', 'orchard-outcome'].sort()),
    COLLAPSED_BLOCKS);
  check('every other known name is expanded, derived not listed',
    EXPANDED_BLOCKS.length === KNOWN_BLOCKS.length - COLLAPSED_BLOCKS.length
      && EXPANDED_BLOCKS.every((n) => !COLLAPSED_BLOCKS.includes(n)),
    EXPANDED_BLOCKS);

  {
    // The new vocabulary parses, and each name is carried through verbatim.
    const src = CATEGORY_BLOCKS.map((n, i) => `${B4}${n}\nbody ${i}\n${B4}`).join('\n\n') + '\n';
    const p = parseResponseBlocks(src);
    check('every semantic category parses as its own block',
      JSON.stringify(p.blocks.map((b) => b.name)) === JSON.stringify(CATEGORY_BLOCKS),
      p.blocks.map((b) => b.name));
    check('...with nothing left loose', p.fallbackChars === 0, p.fallbackRuns.length);
  }

  {
    // THE LABEL. `name label` — the name is the first token, the rest is free text
    // kept with its case, and it is the whole learning loop for the fallback.
    const p = parseResponseBlocks(
      `${B4}orchard-uncategorized A copy-paste prompt For You\nrun this elsewhere\n${B4}\n`);
    check('a labelled block still parses under its NAME',
      p.blocks.length === 1 && p.blocks[0].name === 'orchard-uncategorized', p.blocks.map(b => b.name));
    check('the label is carried, with its case preserved',
      p.blocks[0].label === 'A copy-paste prompt For You', p.blocks[0].label);
    check('the declared fallback is reported separately from loose prose',
      p.declaredUncategorized.length === 1 && p.declaredUncategorized[0].label === 'A copy-paste prompt For You'
        && typeof p.declaredUncategorized[0].excerpt === 'string' && Array.isArray(p.declaredUncategorized[0].tags),
      p.declaredUncategorized);
    const un = parseResponseBlocks(`${B4}orchard-uncategorized\nno label\n${B4}\n`);
    check('an UNLABELLED declared fallback still parses, and is reported as unlabelled',
      un.declaredUncategorized.length === 1 && un.declaredUncategorized[0].label === '',
      un.declaredUncategorized);
    // A label must not turn a known name into an unknown one, and must not leak
    // into a flag: flags are worded with the name, never the author's text.
    const lab = parseResponseBlocks(`${B4}orchard-finding some label here\nunterminated\n`);
    check('a flag is worded with the NAME, never the label',
      lab.malformed.length === 1 && lab.malformed[0].startsWith('unterminated:orchard-finding@'),
      lab.malformed);
    // A label on a COLLAPSED name folds (it is a real block now, where it used to
    // degrade to visible prose as an unknown name). Inside the invariant: the
    // author wrote a fold, so the content was authored as hidden.
    const fold = parseResponseBlocks(`${B4}orchard-narration why I did it\nnarrating\n${B4}\n`);
    check('a labelled collapsed opener is a real fold, not an unknown name',
      fold.blocks.length === 1 && fold.blocks[0].name === 'orchard-narration' && fold.blocks[0].label === 'why I did it'
        && fold.malformed.length === 0,
      { blocks: fold.blocks.map(b => [b.name, b.label]), malformed: fold.malformed });
    // C1 IS NOT WEAKENED BY A LABEL: a labelled reserved opener inside a fold
    // still ends it. `name` is a prefix of `info`, so the namespace test is the
    // same predicate — this pins that it stayed that way.
    const c1 = parseResponseBlocks(
      `${B4}orchard-narration\nnarrating\n${B4}orchard-ask with a label\nMUST-BE-VISIBLE\n${B4}\n${B4}\n`);
    check('C1 still fires on a LABELLED reserved opener inside a fold',
      c1.malformed.some((m) => m.startsWith('ambiguous-fold:')),
      c1.malformed);
    const hidden = c1.blocks.filter((b) => COLLAPSED_BLOCKS.includes(b.name)).map((b) => b.content).join('\n');
    check('...and the visible content is NOT inside the fold',
      !hidden.includes('MUST-BE-VISIBLE'), hidden);
  }

  {
    const p = parseResponseBlocks(
      `${B4}orchard-answer\nShip it.\n${B4}\n\n${B4}orchard-notes\nRan the suite.\n${B4}\n`);
    check('well-formed answer + notes parse', p.blocks.length === 2 && p.blocks[0].name === 'orchard-answer' && p.blocks[1].name === 'orchard-notes', p.blocks.map(b => b.name));
    check('block content excludes the fence lines', p.blocks[0].content === 'Ship it.', p.blocks[0].content);
    check('no fallback when everything is inside blocks', p.fallbackChars === 0 && p.fallbackRuns.length === 0, p.fallbackRuns);
    check('shape=structured', p.shape === 'structured', p.shape);
  }

  {
    // The load-bearing fence rule: a 4-backtick block survives inner ```code```.
    const p = parseResponseBlocks(`${B4}orchard-answer\nUse this:\n${B3}js\nx()\n${B3}\nDone.\n${B4}\n`);
    check('4-backtick block contains a 3-backtick code fence intact',
      p.blocks.length === 1 && p.blocks[0].content.includes(`${B3}js`) && p.blocks[0].content.endsWith('Done.'), p.blocks[0]?.content);
    check('inner code fence produced no fallback', p.fallbackRuns.length === 0, p.fallbackRuns);
  }

  /* ── [1b0] the two ROUND-3 defects, named, at parser level ────────────────
   * Both are the same mistake in different clothes: the parser reasoned about
   * "lines" and "fences" with rules that did not match how the input is really
   * structured. Kept as named checks alongside the generated corpus so a reader
   * of the output can see the reported bug itself, not only an aggregate. */
  {
    // DEFECT 1 — a reserved opener separated by a LONE CR. C1 was a per-LF-line
    // predicate, so the opener sat mid-"line" and was invisible to it: the
    // decision was folded away with an EMPTY malformed list.
    const p = parseResponseBlocks(
      `${B4}orchard-notes\nNARRATION\r${B4}orchard-answer\rMUST-SEE-DECISION\r${B4}\r\n${B4}\nTAIL\n`);
    const folded = p.blocks.filter(b => b.name === 'orchard-notes').map(b => b.content).join('\n');
    check('lone-CR reserved opener is NOT folded away',
      !folded.includes('MUST-SEE-DECISION'), { folded });
    check('...it is promoted to a visible orchard-answer',
      p.blocks.some(b => b.name === 'orchard-answer' && b.content.includes('MUST-SEE-DECISION')),
      p.blocks.map(b => `${b.name}:${b.content}`));
    check('...and the uncertainty is reported, never silent',
      p.malformed.some(m => m.startsWith('ambiguous-fold:orchard-notes')), p.malformed);
  }

  {
    // Line endings are normalised at the boundary, so the SAME document under
    // LF / CRLF / lone CR / mixed must parse identically. Anything that differs
    // is a line-splitting rule that forgot.
    const lines = [`${B4}orchard-notes`, 'narration', `${B3}js`, 'x()', `${B3}`, `${B4}`, 'tail'];
    const join = (seq) => lines.map((l, k) => l + (k < lines.length - 1 ? seq[k % seq.length] : '')).join('');
    const shot = (t) => JSON.stringify({
      blocks: parseResponseBlocks(t).blocks.map(b => [b.name, b.content, b.startLine, b.endLine]),
      fb: parseResponseBlocks(t).fallbackRuns.map(r => r.text),
      mal: parseResponseBlocks(t).malformed,
    });
    const lf = shot(join(['\n']));
    for (const [tag, seq] of [['CRLF', ['\r\n']], ['lone CR', ['\r']], ['mixed', ['\n', '\r\n', '\r']]]) {
      check(`${tag} parses byte-identically to LF (same document, same parse)`, shot(join(seq)) === lf,
        shot(join(seq)) === lf ? 'identical' : { lf, got: shot(join(seq)) });
    }
  }

  {
    // DEFECT 2 — a closing fence LONGER than its opener is legal CommonMark. The
    // old even-tally guard read a 3-run and a 4-run as two unpaired lengths, so
    // well-formed input got flagged and the fold was cut early, ejecting authored
    // notes content into the visible region.
    const B6 = '``````';
    const p = parseResponseBlocks(
      `${B6}orchard-notes\nBEFORE\n${B3}js\nconst x = 1;\n${B4}\nAFTER\n${B6}\nTAIL\n`);
    check('a longer-than-opener close pairs SILENTLY (no false ambiguous-fold)',
      p.malformed.length === 0, p.malformed);
    check('...the whole authored body stays in the fold, nothing ejected',
      p.blocks.length === 1 && p.blocks[0].name === 'orchard-notes'
      && p.blocks[0].content.includes('BEFORE') && p.blocks[0].content.includes('AFTER'),
      p.blocks.map(b => `${b.name}:${b.content}`));
    check('...and the tail after the fold is still visible',
      p.fallbackRuns.some(r => r.text.includes('TAIL')), p.fallbackRuns.map(r => r.text));
    // The genuinely unpaired case must still end the fold — visible and reported.
    const q = parseResponseBlocks(`${B4}orchard-notes\nnarration\n${B3}\ndangling\n${B4}\ntail\n`);
    check('a genuinely UNPAIRED inner fence still ends the fold, and is reported',
      q.malformed.some(m => m.includes('unpaired-fence-in-fold')), q.malformed);
  }

  /* ── [1b0'] the ROUND-4 defect, named, at parser level ────────────────────
   * Same class as rounds 1-3, reached through a third syntax: a construct that
   * makes a region INERT was not modelled, so an example became live markup. This
   * time it was CommonMark's OTHER fence character. The clean-room input is graded
   * verbatim, and both directions of the pairing rule are pinned beside it. */
  {
    const p = parseResponseBlocks('~~~markdown\n````orchard-notes\nMUST-BE-READER-VISIBLE\n````\n~~~');
    check('ROUND 4: a notes example inside a ~~~ fence is INERT, not a fold',
      p.blocks.length === 0 && p.shape === 'unstructured', p.blocks.map(b => [b.name, b.content]));
    check('...its content survives as visible fallback prose',
      p.fallbackRuns.some(r => r.text.includes('MUST-BE-READER-VISIBLE')), p.fallbackRuns.map(r => r.text));
    check('...and the input is legal CommonMark, so NOTHING is flagged',
      p.malformed.length === 0, p.malformed);
    // The mirror order, which a one-character grammar also gets wrong.
    const q = parseResponseBlocks('```markdown\n~~~~orchard-notes\nMIRROR\n~~~~\n```');
    check('ROUND 4 mirror: a ~~~ notes example inside a ``` fence is equally inert',
      q.blocks.length === 0 && q.malformed.length === 0 && q.fallbackRuns.some(r => r.text.includes('MIRROR')),
      { blocks: q.blocks.length, malformed: q.malformed });
  }

  {
    // A tilde fence is a FULL citizen, not merely something to skip over: it opens
    // real blocks, and the fold guard is character-blind because there is one
    // fence primitive rather than one per character.
    const p = parseResponseBlocks('~~~~orchard-notes\nNARRATION\n```js\nrun()\n```\n~~~~\nTAIL\n');
    check('a ~~~ orchard-notes IS a real block, with an inner ``` fence intact',
      p.blocks.length === 1 && p.blocks[0].name === 'orchard-notes' && p.blocks[0].content.includes('run()')
      && p.malformed.length === 0, { blocks: p.blocks.map(b => b.name), malformed: p.malformed });
    check('...and the block records WHICH fence character opened it', p.blocks[0]?.fenceChar === '~', p.blocks[0]?.fenceChar);
    const q = parseResponseBlocks('~~~~orchard-notes\nN\n````orchard-answer\nDECISION\n````\n~~~~\n');
    check('the fold guard is character-blind: an answer inside a TILDE fold is promoted',
      q.blocks.some(b => b.name === 'orchard-answer' && b.content.includes('DECISION'))
      && !q.blocks.some(b => b.name === 'orchard-notes' && b.content.includes('DECISION')),
      q.blocks.map(b => [b.name, b.content]));
    check('...and reported, exactly as under backticks',
      q.malformed.some(m => m.startsWith('ambiguous-fold:orchard-notes')), q.malformed);
  }

  {
    // CommonMark pairs a fence with its OWN character, at any length. Both
    // directions, because a grammar that shared one regex would get one wrong.
    const p = parseResponseBlocks('```orchard-answer\nA\n~~~~~~~~\nB\n```\n');
    check('a long ~~~ run does not close a ``` fence',
      p.blocks.length === 1 && p.blocks[0].content.includes('~~~~~~~~') && p.blocks[0].content.includes('B'),
      p.blocks.map(b => b.content));
    const q = parseResponseBlocks('~~~orchard-answer\nA\n````````\nB\n~~~\n');
    check('a long ``` run does not close a ~~~ fence',
      q.blocks.length === 1 && q.blocks[0].content.includes('````````') && q.blocks[0].content.includes('B'),
      q.blocks.map(b => b.content));
    // The one asymmetry, and it is CommonMark's: a backtick fence's info string
    // may not contain a backtick; a tilde fence's info string may contain anything.
    const r = parseResponseBlocks('BEFORE\n```js `x` = 1\nAFTER\n');
    check('a ``` line whose info string carries a backtick is NOT a fence',
      r.blocks.length === 0 && r.fallbackRuns.some(x => x.text.includes('AFTER')), r.blocks);
    const s = parseResponseBlocks('BEFORE\n~~~ ```orchard-answer\nINSIDE\n~~~\nAFTER\n');
    check('a ~~~ line whose info string carries backticks IS a fence, and an inert one',
      s.blocks.length === 0 && s.malformed.length === 0 && s.fallbackRuns.some(x => x.text.includes('INSIDE')),
      { blocks: s.blocks.length, malformed: s.malformed });
  }

  {
    // INERT CONSTRUCT 2 — indented code. Not a new rule: an opener is only
    // recognised at 0-3 columns, and an indented code block has no line at 0-3
    // columns, so this falls out. Asserted for BOTH characters rather than assumed.
    for (const ch of ['`', '~']) {
      const F = ch.repeat(3);
      const p = parseResponseBlocks(`${B4}orchard-notes\nnarration\n    ${F}orchard-answer\n    EXAMPLE\n    ${F}\nend\n${B4}\n`);
      check(`a 4-space-indented ${F} orchard example stays folded and silent (escape hatch)`,
        p.blocks.length === 1 && p.blocks[0].content.includes('EXAMPLE') && p.malformed.length === 0,
        { blocks: p.blocks.map(b => b.name), malformed: p.malformed });
    }
  }

  {
    // INERT CONSTRUCT 3 — HTML blocks, DELIBERATELY not modelled. What is asserted
    // is the BOUND on that decision: C1 is character- and markup-blind, so an
    // HTML-wrapped reserved opener still ends the fold and an authored answer can
    // never hide behind a `<div>`. (Rationale in public/lib/response-blocks.js.)
    const p = parseResponseBlocks(`${B4}orchard-notes\nN\n<div>\n${B3}orchard-answer\nHTML-WRAPPED-DECISION\n${B3}\n</div>\n${B4}\n`);
    check('HTML is not inert here, and the bound holds: a wrapped answer is NOT folded',
      !p.blocks.some(b => b.name === 'orchard-notes' && b.content.includes('HTML-WRAPPED-DECISION')),
      p.blocks.map(b => [b.name, b.content]));
    check('...and it is reported, never silent',
      p.malformed.some(m => m.startsWith('ambiguous-fold:')), p.malformed);
  }

  {
    // A TAB indent is 4 columns, so a tab-indented run is not a fence at all —
    // to this parser and to the renderer alike. 0-3 spaces still are.
    for (const ind of ['', ' ', '  ', '   ']) {
      const p = parseResponseBlocks(`${ind}${B4}orchard-answer\nvisible\n${ind}${B4}\n`);
      check(`an opener indented ${ind.length} spaces is a fence`, p.blocks[0]?.name === 'orchard-answer', p.blocks);
    }
    const t = parseResponseBlocks(`\t${B4}orchard-answer\nvisible\n\t${B4}\n`);
    check('a TAB-indented opener is NOT a fence (CommonMark 4-column stop) — content stays visible prose',
      t.blocks.length === 0 && t.fallbackRuns.some(r => r.text.includes('visible')), { blocks: t.blocks.length });
  }

  {
    // A fence INSIDE a plain code block must never open a block (docs do this).
    const p = parseResponseBlocks(`Example:\n${B4}markdown\n${B3}orchard-answer\nnot real\n${B3}\n${B4}\ntail\n`);
    check('orchard fence inside a code block is inert', p.blocks.length === 0 && p.shape === 'unstructured', p.blocks);
    check('...and its text survives as fallback', p.fallbackRuns.some(r => r.text.includes('not real')), p.fallbackRuns.map(r => r.text));
  }

  {
    const p = parseResponseBlocks(`${B4}orchard-answer\nThis fence is never closed.\nMore prose here.\n`);
    check('unterminated known fence -> flagged', p.malformed.some(m => m.startsWith('unterminated:orchard-answer')), p.malformed);
    check('unterminated -> ZERO blocks, all of it fallback', p.blocks.length === 0 && p.fallbackChars > 0, { blocks: p.blocks.length, fb: p.fallbackChars });
    check('unterminated -> content preserved verbatim (nothing dropped)',
      p.fallbackRuns[0].text.includes('This fence is never closed.') && p.fallbackRuns[0].text.includes('More prose here.'), p.fallbackRuns[0]?.text);
    check('unterminated -> opener line kept too (visible, not swallowed)',
      p.fallbackRuns[0].text.includes('orchard-answer'), p.fallbackRuns[0]?.text.slice(0, 40));
  }

  {
    // Forward compatibility: THIS parser is the "older renderer" for a name a
    // future spec adds. It must show the content, not hide it, not error.
    const p = parseResponseBlocks(`${B4}orchard-evidence\nTOTAL: 12 passed\n${B4}\nprose\n`);
    check('unknown orchard-* name -> no block, no throw', p.blocks.length === 0, p.blocks);
    check('unknown orchard-* CONTENT renders as fallback (never hidden)',
      p.fallbackRuns.some(r => r.text.includes('TOTAL: 12 passed')), p.fallbackRuns.map(r => r.text));
    check('unknown name is recorded by name', p.unknownBlocks[0]?.name === 'orchard-evidence', p.unknownBlocks);
  }

  {
    const p = parseResponseBlocks('Just a short answer, no ceremony at all.');
    check('no blocks at all is legal -> shape=unstructured', p.shape === 'unstructured' && p.malformed.length === 0, p);
    check('no blocks -> whole message is one fallback run', p.fallbackRuns.length === 1 && p.fallbackRuns[0].position === 'whole-message', p.fallbackRuns);
  }

  {
    const p = parseResponseBlocks(`${B4}orchard-notes\na\n${B4}\n${B4}orchard-answer\nb\n${B4}\n${B4}orchard-notes\nc\n${B4}\n`);
    check('blocks may repeat and appear in any order',
      p.counts['orchard-notes'] === 2 && p.counts['orchard-answer'] === 1, p.counts);
    check('document order is preserved',
      p.blocks.map(b => b.name).join('>') === 'orchard-notes>orchard-answer>orchard-notes', p.blocks.map(b => b.name));
  }

  {
    const p = parseResponseBlocks(`${B3}orchard-digest\n{"items":[{"text":"x","kind":"done"}]}\n${B3}\nprose after\n`);
    check('orchard-digest counts as a known block, not fallback', p.counts['orchard-digest'] === 1, p.counts);
    check('prose after the digest is fallback', p.fallbackRuns.some(r => r.text.includes('prose after')), p.fallbackRuns.map(r => r.text));
  }

  for (const [label, input] of [['null', null], ['undefined', undefined], ['number', 42], ['empty string', ''], ['only whitespace', '   \n\n  ']]) {
    let ok = false, res;
    try { res = parseResponseBlocks(input); ok = res && Array.isArray(res.blocks) && Array.isArray(res.fallbackRuns); } catch { ok = false; }
    check(`degenerate input (${label}) -> well-formed result, no throw`, ok, res);
  }

  {
    // Indented fences (0-3 spaces are legal CommonMark openers; 4+ is code).
    const p = parseResponseBlocks(`  ${B4}orchard-answer\nindented open\n  ${B4}\n`);
    check('a 2-space indented fence still opens a block', p.blocks.length === 1, p.blocks);
  }

  /* ══ [1b] the CORRECTED malformed contract ═══════════════════════════════
   * The spec used to say "malformed input degrades to plain prose — the WHOLE
   * message must remain readable", and an independent pass applied it literally.
   * It was the WORDING that was wrong: throwing away a valid block because
   * something LATER is malformed loses structure and protects nothing, since the
   * content was never at risk. The contract is now: nothing lost or hidden,
   * document order preserved, degradation is LOCAL, and only a wholly unparseable
   * message renders wholly as prose. Degradation always moves content toward
   * VISIBLE — which is the property these cases pin. */
  console.log('\n[1b] malformed degrades LOCALLY, and always toward visible');

  {
    const p = parseResponseBlocks(`${B4}orchard-answer\nGOOD\n${B4}\n${B4}orchard-notes\nLOOSE\n`);
    check('a valid block BEFORE an unterminated fence keeps its block',
      p.blocks.length === 1 && p.blocks[0].name === 'orchard-answer' && p.blocks[0].content === 'GOOD', p.blocks);
    check('...the unterminated region is fallback prose, flagged unterminated',
      p.fallbackRuns.some(r => r.text.includes('LOOSE')) && p.malformed.some(m => m.startsWith('unterminated:')), { runs: p.fallbackRuns.map(r => r.text), malformed: p.malformed });
  }

  {
    // THE HIDING BUG. An unclosed `notes` used to be closed by the ANSWER's own
    // trailing fence, folding the reader's decision away — collapsed, silently,
    // with no malformed flag at all. A collapsed block that contains a top-level
    // opener for a visible name is now treated as missing its close.
    const p = parseResponseBlocks(`${B4}orchard-notes\nNARRATION\n${B4}orchard-answer\nDECISION\n${B4}\n`);
    check('an unterminated notes does NOT swallow the answer that follows it',
      p.blocks.length === 2 && p.blocks[0].name === 'orchard-notes' && p.blocks[1].name === 'orchard-answer', p.blocks.map(b => b.name));
    check('...the decision is its own visible block, not folded narration',
      p.blocks[1]?.content === 'DECISION' && !String(p.blocks[0]?.content).includes('DECISION'), p.blocks.map(b => b.content));
    check('...and the author is told (ambiguous-fold), where before nothing was flagged',
      p.malformed.some(m => m.startsWith('ambiguous-fold:orchard-notes')), p.malformed);
    // Same mistake with mismatched fence lengths.
    const q = parseResponseBlocks(`${B3}orchard-notes\nN\n${B4}orchard-answer\nD\n${B4}\n`);
    check('...also when the fence lengths differ (3-backtick notes, 4-backtick answer)',
      q.blocks.length === 2 && q.blocks[1].name === 'orchard-answer', q.blocks.map(b => b.name));
  }

  {
    // The MIRROR case must NOT be restructured: a visible block swallowing a
    // notes opener keeps its content visible and in order, so splitting it is the
    // only thing that could hide it. Report it, do not move it.
    const p = parseResponseBlocks(`${B4}orchard-answer\nA\n${B4}orchard-notes\nB\n${B4}\n`);
    check('a VISIBLE block swallowing a notes opener is left intact (content stays visible)',
      p.blocks.length === 1 && p.blocks[0].name === 'orchard-answer' && p.blocks[0].content.includes('B'), p.blocks);
    check('...but it is reported as nested-opener so the metrics can see it',
      p.malformed.some(m => m.startsWith('nested-opener:orchard-answer')), p.malformed);
  }

  {
    // CONTRACT CHANGE, and the reason the class is now closed. This used to assert
    // that a documented orchard-answer example inside a code fence inside notes
    // stays folded — i.e. that the scanner reasons about NESTING DEPTH inside a
    // fold. That reasoning is what produced two hidden-content defects in a row.
    // The guard is now depth-free: ANY reserved opener in a fold body ends the
    // fold there, visible and reported. The cost is this case; the benefit is that
    // no depth mistake can exist, because no depth is tracked.
    const p = parseResponseBlocks(
      `${B4}orchard-notes\nThe format looks like:\n${B3}\n${B3}orchard-answer\nEXAMPLE\n${B3}\n${B3}\nend of narration\n${B4}\n`);
    check('an orchard-* example inside notes is promoted to VISIBLE, not folded',
      !p.blocks.some(b => b.name === 'orchard-notes' && b.content.includes('EXAMPLE')), p.blocks.map(b => [b.name, b.content]));
    check('...and the promotion is reported, never silent',
      p.malformed.some(m => m.startsWith('ambiguous-fold:orchard-notes')), p.malformed);
    check('...and nothing is dropped: EXAMPLE still appears exactly once',
      [...p.blocks.map(b => b.content), ...p.fallbackRuns.map(r => r.text)].join('\n').split('EXAMPLE').length - 1 === 1,
      { blocks: p.blocks.map(b => b.content), runs: p.fallbackRuns.map(r => r.text) });

    // The depth-free ESCAPE HATCH for authors who want the example folded: 4+
    // spaces is not a fence opener in CommonMark at all, so it needs no depth
    // reasoning to stay inert.
    const q = parseResponseBlocks(
      `${B4}orchard-notes\nThe format looks like:\n    ${B3}orchard-answer\n    EXAMPLE\n    ${B3}\nend of narration\n${B4}\n`);
    check('a 4-space-indented orchard-* example stays inside the fold (escape hatch)',
      q.blocks.length === 1 && q.blocks[0].name === 'orchard-notes' && q.blocks[0].content.includes('EXAMPLE') && q.malformed.length === 0,
      { blocks: q.blocks.map(b => b.name), malformed: q.malformed });
  }

  {
    // CONTRACT CHANGE. This used to assert notes-inside-notes was inert "because
    // both collapse, so nothing is demoted". That assumption IS the BUG-108
    // defect: one more layer down sat an orchard-answer, and treating the nested
    // notes as opaque folded the answer away with an empty malformed list.
    const p = parseResponseBlocks(`${B4}orchard-notes\nx\n${B3}orchard-notes\ninner\n${B3}\ny\n${B4}\n`);
    check('a notes opener inside notes ends the outer fold (no opaque regions)',
      p.blocks.length >= 2 && p.blocks.every(b => b.name === 'orchard-notes'), p.blocks.map(b => [b.name, b.content]));
    check('...and it is reported', p.malformed.some(m => m.startsWith('ambiguous-fold:')), p.malformed);
  }

  {
    // THE BUG-108 INPUT, verbatim from the independent clean-room verdict.
    const p = parseResponseBlocks(
      '`````orchard-notes\nOUTER-NOTES\n````orchard-notes\nINNER-NOTES\n````orchard-answer\nSECRET-ANSWER\n````\n`````');
    check('BUG-108: the twice-nested answer is its own visible block',
      p.blocks.some(b => b.name === 'orchard-answer' && b.content.includes('SECRET-ANSWER')), p.blocks.map(b => [b.name, b.content]));
    check('BUG-108: no fold contains the answer',
      !p.blocks.some(b => b.name === 'orchard-notes' && b.content.includes('SECRET-ANSWER')), p.blocks.map(b => [b.name, b.content]));
    check('BUG-108: the ambiguity is reported at BOTH nesting levels (was: empty list)',
      p.malformed.filter(m => m.startsWith('ambiguous-fold:')).length === 2, p.malformed);
  }

  {
    // C2 — the irreducible ambiguity, resolved toward visible. A bare ``` inside a
    // 4-backtick fold is both the RECOMMENDED code-fence usage and a mistyped
    // close; pairing is the only depth-free signal, so pairs are content and an
    // unpaired run ends the fold.
    const ok = parseResponseBlocks(`${B4}orchard-notes\nRan it:\n${B3}js\nx()\n${B3}\nDone.\n${B4}\n`);
    check('C2: a PAIRED inner code fence keeps the recommended pattern working',
      ok.blocks.length === 1 && ok.blocks[0].content.includes('x()') && ok.malformed.length === 0,
      { blocks: ok.blocks.map(b => b.name), malformed: ok.malformed });
    const bad = parseResponseBlocks(`${B4}orchard-notes\nNARRATION\n${B3}\nLATER PROSE\n${B4}\n`);
    check('C2: an UNPAIRED inner run (a mistyped close) ends the fold, visibly',
      !bad.blocks.some(b => b.name === 'orchard-notes' && b.content.includes('LATER PROSE')), bad.blocks.map(b => [b.name, b.content]));
    check('C2: ...and says so', bad.malformed.some(m => m.includes('unpaired-fence-in-fold')), bad.malformed);
  }

  {
    // An UNKNOWN reserved name swallowed by notes is the same hiding shape: its
    // content is fallback prose (visible) when parsed, so it must escape the fold.
    const p = parseResponseBlocks(`${B4}orchard-notes\nN\n${B4}orchard-futurething\nFUTURE\n${B4}\n`);
    check('an unknown orchard-* block does not stay folded inside an unclosed notes',
      p.fallbackRuns.some(r => r.text.includes('FUTURE')) && !String(p.blocks[0]?.content).includes('FUTURE'),
      { runs: p.fallbackRuns.map(r => r.text), notes: p.blocks[0]?.content });
  }

  {
    const p = parseResponseBlocks('No fence anywhere.\n\nJust prose.');
    check('a message with no structure at all is one whole-message fallback run',
      p.shape === 'unstructured' && p.fallbackRuns.length === 1 && p.fallbackRuns[0].position === 'whole-message', p.fallbackRuns.map(r => r.position));
  }

  /* ══ [1c] the GENERATED property suite ═══════════════════════════════════
   * The cases above are hand-written, and hand-written cases are how this grammar
   * shipped two hidden-content defects in a row: each fix handled the shape that
   * had been demonstrated, and the next shape — one more layer of nesting — was
   * still broken. The input space is small and mechanical, so it is ENUMERATED
   * here rather than sampled: every block name x fence length x opened/closed x
   * nesting depth x ordering x LINE-ENDING REGIME x fence INDENT x CLOSER LENGTH,
   * each region a unique token, graded against an oracle taken from the authored
   * TREE (see scripts/lib/feat-091-fold-corpus.mjs).
   *
   * The last dimensions are each round's lesson, and the lesson has been the same
   * one four times: a generated suite only catches defects in the dimensions it
   * VARIES. Round 3 found a reserved opener hidden behind a LONE CR and a false
   * `ambiguous-fold:` on a legal longer-than-opener close, which the 7,166-case
   * suite could not have caught because every case was LF-separated, unindented
   * and closed by a run of exactly the opener's width. Round 4 found a notes
   * example inside a `~~~markdown` fence rendering inside a CLOSED fold, which the
   * 10,715-case suite could not have caught because every case was written with
   * BACKTICKS. Round 5 found a notes example inside a top-level HTML BLOCK doing
   * the same thing, which the 20,160-case suite could not have caught because HTML
   * blocks were deliberately unmodelled and the `html` stratum asserted only the
   * BOUND — a bound that held for `orchard-answer` and failed for `orchard-notes`,
   * i.e. it was tight in the direction that does not hide. Round 6 found the price
   * of round 5's FIX: it recognised HTML blocks with one deliberately loose
   * predicate (`<` then `! ? / letter`), which over-recognises, and a bare `<b` on
   * its own line — ordinary prose — inerted the `orchard-notes` block under it.
   * The 20,273-case suite could not catch that, because its `html5` stratum only
   * ever put REAL HTML in front of a block, and its one over-recognition case
   * ASSERTED THE FALSE FLAG AS EXPECTED. A suite that encodes the trade a fix made
   * cannot audit that trade. So the INERT CONSTRUCT is now a dimension by
   * CONDITION: `html5` enumerates every HTML-block kind that spans lines x both
   * fence characters x three block names (`wrap`), each condition's own END
   * (`end`), the precision cases that stop the fix degenerating into "inert
   * everything after a `<`" (`precise`), condition 7's paragraph clause in both
   * directions (`para7`), the dangling-fence case where an inert region ending
   * early could itself CREATE a fold (`dangle`), and — round 6's addition —
   * ORDINARY PROSE THAT MERELY RESEMBLES HTML (`prose`): incomplete tags,
   * comparisons, arrows, generics, autolinks, inline tags with trailing text, each
   * at the start of a message and under paragraph text. `bq`, `list` and `inline`
   * close the container/inline contexts carried as "not attempted" for three
   * rounds. Round 7 found the price of round 6's fix in the OTHER direction: it
   * honoured condition 7's "may not interrupt a paragraph" clause with a boolean
   * set by ANY non-blank line, and documented the resulting under-recognition as
   * the safe side. It is not — an `# ATX heading` above a complete custom tag left
   * the flag set, so the literal region was not recognised and the notes EXAMPLE
   * inside it became a real CLOSED fold, invisible in the render and in the
   * accessibility tree with an EMPTY malformed list. The 20,353-case suite could
   * not catch it because its `para7` stratum had exactly TWO contexts (blank, and
   * paragraph text). So the PARAGRAPH CONTEXT is now a dimension: the `para`
   * stratum crosses 73 contexts — every construct that can precede the tag,
   * headings, thematic breaks, setext underlines, both fence characters, every
   * HTML kind, indented code, quotes, lists, empty containers, link reference
   * definitions, lazy continuation — with condition-7, condition-6 and
   * not-HTML-at-all tag lines. Each context's expected verdict is the CommonMark
   * 0.31.2 reference implementation's, read off its AST, not the grammar's opinion
   * of itself. Round 8 found the price of round 7's fix in the dimension round 7
   * WROTE DOWN as approximate: it handled containers by stripping their markers
   * with a regex, one level deep, and said so. `-` followed by FIVE spaces is a
   * list item whose content is INDENTED CODE, not a paragraph; the greedy strip
   * saw a paragraph, so the `<my-widget>` under it looked like lazy continuation,
   * condition 7 was suppressed, and the authored example became a real CLOSED
   * fold with an EMPTY malformed list. The 20,864-case suite could not catch it
   * because its `para` stratum varied what was ABOVE the tag but never the
   * CONTAINER STACK the lines sat in. So containers are now a stack, not a
   * prefix, and the `container` stratum is that dimension: markers at depth 1-3,
   * every content indentation across the 4-column threshold, continuation by
   * indentation, lazy continuation, blank lines inside a container, mixed
   * containers, each leaf kind inside one, and the deliberate omissions each
   * pinned by a case. `tagcond` is round 8's SECOND defect, which the reference
   * differential found rather than a clean room: condition 7 rejected the four
   * type-1 tag names in either form, which really only removed COMPLETE CLOSING
   * TAGS (`</pre>`), every one of which the reference makes a condition-7 HTML
   * block — so a message opening with a lone `</pre>` had a literal region this
   * parser called LIVE. It also drops the 0.30/0.31.2 tag-list UNION for the one
   * pinned revision, because the union made `<source>` inert where the reference
   * keeps it live.
   *
   * CALIBRATION, so this is not a suite that passes because it asserts nothing.
   * The same 20,864 cases, graded against every parser generation (the numbers are
   * FAILING CASES; per-invariant counts are cases with >=1 violation of it; and
   * "falsely flagged" counts WELL-FORMED cases reporting something other than the
   * legitimate `unknown-block:` advisory). Reproduced by loading each generation's
   * `parseResponseBlocks` against the CURRENT corpus:
   *   git show 31acb24^:public/lib/response-blocks.js  (pre-FEAT-091)
   *       -> 1,674 failing: 1,112 I1 (hidden content), 50 I2, 871 I3, 2 falsely flagged.
   *   git show 31acb24:public/lib/response-blocks.js   (round-2 fix)
   *       -> 1,202 failing: 619 I1, 50 I2, 891 I3, 29 WELL-FORMED cases falsely flagged.
   *   git show 3851f04:public/lib/response-blocks.js   (round-3 fix)
   *       -> 1,118 failing: 644 I1, 0 I2, 812 I3, 0 falsely flagged.
   *   git show 326439c:public/lib/response-blocks.js   (round-4 fix)
   *       -> 395 failing: 348 I1, 0 I2, 395 I3, 0 falsely flagged. All 395 are
   *          `html`, `html5`, `para` or `reported` shape and ZERO are outside the
   *          inert-construct family. That is round 4's "the residual is bounded"
   *          argument, measured: the bound was real, and it was in the direction
   *          that does not matter.
   *   git show a2edb76:public/lib/response-blocks.js   (round-5 fix)
   *       -> 146 failing: 0 I1, 0 I2, 146 I3, and 146 WELL-FORMED cases falsely
   *          flagged. The shape of over-recognition, exactly: it hid NOTHING (I1
   *          zero — round 5's monotone-inertness argument was true), and it lost
   *          146 genuine blocks out of the parse while flagging legal prose.
   *   git show 5565736:public/lib/response-blocks.js   (round-6 fix)
   *       -> 245 failing: 241 I1, 0 I2, 245 I3, 3 falsely flagged. The MIRROR of
   *          round 5, and the reason "under-recognition is the safe side" is not a
   *          shipping argument: 241 of them HID CONTENT, and every failure is in
   *          the `para`, `container` or `tagcond` strata — 0 failures anywhere
   *          else. Over-recognition corrupts the parse; under-recognition of
   *          condition 7 folds authored text away. Neither direction is free, so
   *          neither may be approximated.
   *   git show 52807b9:public/lib/response-blocks.js   (round-7 fix, the parser
   *       this round's clean-room pass attacked)
   *       -> 45 failing: 41 I1, 0 I2, 45 I3, 3 falsely flagged. 30 `container`,
   *          13 `tagcond`, 2 `reported`, and ZERO in every stratum that existed
   *          before this round — the shape of a fix that closed its own
   *          demonstrated dimension and left the one it had written down as
   *          approximate. Fourth round running.
   *
   * ROUND 10 re-ran the WHOLE table against the round-10 corpus (21,282 cases,
   * 1,609 well-formed), because a calibration quoted from an older corpus is not a
   * calibration of the corpus that ships. Failing / I1 / I2 / I3 / falsely-flagged:
   *   31acb24^ pre  1889 / 1307 / 50 / 1086 /   2
   *   31acb24  r2   1417 /  814 / 50 / 1106 /  29
   *   3851f04  r3   1333 /  839 /  0 / 1027 /   0
   *   326439c  r4    610 /  543 /  0 /  610 /   0
   *   a2edb76  r5    330 /    2 /  0 /  330 / 310
   *   5565736  r6    297 /  272 /  0 /  297 /   5
   *   52807b9  r7    105 /   45 /  0 /  105 /  40
   *   10db355  r8     61 /    4 /  0 /   61 /  38
   *   91b35ab  r9     41 /    5 /  0 /   41 /  36   <- the generation this round replaced
   *   current  r10     0 /    0 /  0 /    0 /   0
   * Round 9's 41 are the MULTI-LINE link reference definition cases: 36 of them
   * are WELL-FORMED input falsely flagged and their authored fold LOST (the
   * wrongly-literal direction), and 5 additionally hide content in a container.
   * Against the current parser: 0 of each, with 1,609 well-formed cases silent.
   *
   * DIFFERENTIAL-TESTED AGAINST THE REFERENCE. Round 6's seven start conditions
   * were checked against the CommonMark 0.31.2 reference implementation over 63
   * candidate lines x 2 paragraph contexts — and passed 126/126, because the two
   * contexts it varied were the two the grammar got right. Round 7 widened the
   * space to 73 CONTEXTS x 22 tag lines = 1,606 documents, comparing, in BOTH
   * directions, whether the reference puts an html_block over the fence line and
   * whether this parser treats the region as literal: 0 disagreements. The same
   * 1,606 documents score round 6 at 240 disagreements, every one of them in the
   * HIDING direction. That check is now a COMMITTED, PINNED devDependency and a
   * standing script — `npm run verify:feat-091-commonmark-diff` — which round 8
   * widened to 107 contexts x 31 tag lines = 3,317 documents by adding the
   * CONTAINER contexts and the closing-tag / condition-6-list rows: the round-7
   * generation scores 460 disagreements on it (378 hiding), round 6 scores 772,
   * and the current parser 0. Round 8 also runs a SECOND, live differential HERE,
   * as leg [1d]: the container space crossed with an indent/marker PREFIX on the
   * tag and fence lines (2,736 documents), asserting zero hiding, that every
   * remaining under-recognition is the DOCUMENTED one AND leaves the token
   * visible, and that content is never lost in either direction. It SKIPs,
   * counted, when the devDependency is absent (a clean-room export), and the
   * transcribed `para` / `container` / `tagcond` strata still grade in that case.
   *
   * HONEST NOTE on the `bq` / `list` / `inline` strata: they fail ZERO cases on
   * every generation above — INCLUDING round 7, which round 8 proved broken in
   * container contexts. They were "container contexts, pinned", and they pinned
   * the wrong axis: quote depths, markers and indents around a FENCE, never the
   * container STACK a paragraph lives in. That is the difference between a stratum
   * that names a dimension and one that VARIES it, and it is why `container`
   * exists next to them rather than instead of them. */
  console.log('\n[1c] generated property suite over the full combination space');

  {
    const { generateCorpus, reportedDefectCases, gradeParse, remapCorpus, CORPUS_FOLD_NAMES } =
      await import(path.join(ROOT, 'scripts', 'lib', 'feat-091-fold-corpus.mjs'));
    // ROUND 12 — the corpus is EXTENDED, not replaced. Every case is generated
    // twice: once as authored (legacy `orchard-notes` / `orchard-answer`, which is
    // exactly the MIGRATION case — those messages are in stored transcripts and
    // must keep parsing identically) and once REMAPPED onto the semantic names.
    // Identical expectations both times, which is the claim: the grammar is driven
    // by its vocabulary tables, not by two hard-coded strings.
    const authored = [...generateCorpus(), ...reportedDefectCases()];
    const corpus = [...authored, ...remapCorpus(authored)];
    // The oracle's fold list is local by design; pin it against the implementation
    // so the two can only disagree loudly.
    check('the oracle and the grammar agree on which names can hide',
      JSON.stringify([...CORPUS_FOLD_NAMES].sort()) === JSON.stringify([...COLLAPSED_BLOCKS].sort()),
      { oracle: CORPUS_FOLD_NAMES, grammar: COLLAPSED_BLOCKS });
    const byShape = {};
    const byEol = {};
    let threw = 0, withFold = 0, wf = 0;
    const wfFlagged = [];
    const violations = { I1: [], I2: [], I3: [] };
    for (const c of corpus) {
      byShape[c.shape] = (byShape[c.shape] || 0) + 1;
      byEol[c.eol ?? 'lf'] = (byEol[c.eol ?? 'lf'] || 0) + 1;
      if (c.wellFormed) wf++;
      let parsed;
      try { parsed = parseResponseBlocks(c.text); } catch (err) { threw++; violations.I1.push(`${c.id}: THREW ${err.message}`); continue; }
      if (parsed.blocks.some((b) => CORPUS_FOLD_NAMES.includes(b.name))) withFold++;
      // The invariant round-3 defect 2 violated, stated on its own: WELL-FORMED
      // INPUT MUST REPORT NOTHING. A false flag on legal input costs nothing at
      // parse time and everything at read time — it teaches the reader that
      // `ambiguous-fold:` is noise, which is how the real one gets ignored.
      if (c.wellFormed) {
        const flags = parsed.malformed.filter((m) => !m.startsWith('unknown-block:'));
        if (flags.length) wfFlagged.push(`${c.id}: ${flags.join(',')}`);
      }
      for (const v of gradeParse(c, parsed)) violations[v.slice(0, 2)].push(`${c.id}: ${v}`);
    }
    const shown = (arr) => ({ n: arr.length, first: arr.slice(0, 3) });
    console.log(`      corpus: ${corpus.length} cases ${JSON.stringify(byShape)}`);
    console.log(`      line endings: ${JSON.stringify(byEol)}; ${wf} well-formed; ${withFold} render a fold`);
    check(`the parser never throws on any of the ${corpus.length} generated inputs`, threw === 0, threw);
    check('I1 — no content authored outside notes is ever folded (all cases)', violations.I1.length === 0, shown(violations.I1));
    check('I2 — every region appears exactly once, in authored order (all cases)', violations.I2.length === 0, shown(violations.I2));
    check('I3 — every deviation is reported; well-formed input is flagged nothing', violations.I3.length === 0, shown(violations.I3));
    check(`I4 — ZERO flags across the whole ${wf}-case well-formed subset (no false positives)`,
      wfFlagged.length === 0, shown(wfFlagged));
    // HARNESS INTEGRITY, added round 6 after it bit. Two `html5/para7` cases
    // slugged their id from the tag line, so `<my-widget>` and `</my-widget>`
    // collided. The parse leg here graded both fine — it keys off nothing — but the
    // RENDER leg joins parse results to render output BY ID, so the collision made
    // four tokens look like they "rendered nowhere at all". A duplicate id is a
    // silently mis-graded case, which is worse than a failing one.
    const ids = corpus.map((c) => c.id);
    const dupIds = [...new Set(ids.filter((x, k) => ids.indexOf(x) !== k))];
    check('every corpus case has a UNIQUE id (a collision mis-grades the render leg)',
      dupIds.length === 0, shown(dupIds));
    check('the corpus is not vacuous: >2000 folds, >150 well-formed parses, all 4 line-ending regimes, depth>=5',
      withFold > 2000 && wf > 150 && ['lf', 'crlf', 'cr', 'mixed'].every((e) => byEol[e] > 0) && byShape.depth5 > 0,
      { withFold, wellFormed: wf, byEol, depth5: byShape.depth5 });
    // The round-4 dimension, asserted as PRESENT rather than assumed: a corpus that
    // silently stopped generating tilde fences would pass every check above.
    const tildeCases = corpus.filter((c) => c.text.includes('~~~')).length;
    const tildeFolds = corpus.filter((c) => c.text.includes('~~~')
      && parseResponseBlocks(c.text).blocks.some((b) => CORPUS_FOLD_NAMES.includes(b.name))).length;
    check('the FENCE CHARACTER dimension is really generated: >5000 tilde cases, >500 of them folding',
      tildeCases > 5000 && tildeFolds > 500 && byShape.mix3 > 0 && byShape.icode > 0 && byShape.html > 0,
      { tildeCases, tildeFolds, mix3: byShape.mix3, icode: byShape.icode, html: byShape.html });
    // The round-5 dimensions, asserted PRESENT for the same reason: a corpus that
    // quietly stopped generating HTML wrappers or container contexts would pass
    // every check above while covering none of what this round was about.
    check('the INERT-CONSTRUCT and CONTAINER dimensions are really generated (html5/bq/list/inline)',
      byShape.html5 >= 60 && byShape.bq >= 12 && byShape.list >= 30 && byShape.inline >= 3,
      { html5: byShape.html5, bq: byShape.bq, list: byShape.list, inline: byShape.inline });
    // The ROUND-7 dimension, asserted present AND asserted NON-DEGENERATE. A
    // `para` stratum in which every case expected the same verdict would pass
    // against a parser that always inerted, or never did — which is exactly the
    // pair of failures rounds 5 and 6 shipped. So both sides must be populated.
    const para = corpus.filter((c) => c.shape === 'para');
    const paraInert = para.filter((c) => c.expectedFlags?.length).length;
    check('the PARAGRAPH-CONTEXT dimension is really generated, with BOTH verdicts populated',
      byShape.para >= 500 && paraInert >= 150 && para.length - paraInert >= 150,
      { para: byShape.para, expectInert: paraInert, expectLive: para.length - paraInert });
    // The ROUND-8 dimension, on the same terms. A `container` stratum that expected
    // one verdict everywhere would be satisfied by a parser that never trusts a
    // list, which is a different way to be wrong about the same thing.
    const cont = corpus.filter((c) => c.shape === 'container');
    const contInert = cont.filter((c) => c.expectedFlags?.length).length;
    check('the CONTAINER-STACK dimension is really generated, with BOTH verdicts populated',
      byShape.container >= 250 && contInert >= 60 && cont.length - contInert >= 60,
      { container: byShape.container, expectInert: contInert, expectLive: cont.length - contInert });
  }

  /* ── the round-8 reported input, asserted on its own ──────────────────────
   * The clean-room case, character for character, plus the controls that stop the
   * fix from degenerating in either direction. Round 8's defect was CONTAINER
   * GEOMETRY: a list marker followed by 5 spaces makes the item's content indented
   * code, so no paragraph is open, so the tag below it IS a condition-7 HTML block
   * and the notes fence inside it is an EXAMPLE. Round 7's prefix regex ate the
   * spaces, saw a paragraph, and folded the example away with an empty report. */
  {
    const reported = '-     code\n<my-widget>\n````orchard-notes\nADVERSARIAL-MUST-BE-VISIBLE\n````\n</my-widget>';
    const p = parseResponseBlocks(reported);
    check('round-8: a list item whose content is INDENTED CODE leaves no paragraph open, so the tag below is literal',
      p.blocks.length === 0 && p.counts['orchard-notes'] === 0, { blocks: p.blocks, counts: p.counts });
    check('round-8: ...the example inside it is fallback prose, i.e. visible',
      p.fallbackRuns.some((r) => r.text.includes('ADVERSARIAL-MUST-BE-VISIBLE')), p.fallbackRuns.map((r) => r.text));
    check('round-8: ...and it is REPORTED',
      p.malformed.join(',') === 'inert-html:orchard-notes@line3', p.malformed);
    // The content-indent rule, at every width around the 4-column threshold and on
    // every marker form: 1-4 spaces after the marker is a PARAGRAPH (fence live),
    // 5+ is INDENTED CODE (fence literal). Fixing only `-` with five spaces is how
    // this grammar reached round eight.
    for (const marker of ['-', '*', '+', '1.', '1)']) {
      for (const [sp, literal] of [[1, false], [2, false], [3, false], [4, false], [5, true], [6, true], [9, true]]) {
        const ctx = `${marker}${' '.repeat(sp)}code`;
        const q = parseResponseBlocks(`${ctx}\n<my-widget>\n\`\`\`\`orchard-notes\nTOK8\n\`\`\`\`\n</my-widget>`);
        const folded = q.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes('TOK8'));
        const visible = q.fallbackRuns.some((r) => r.text.includes('TOK8'));
        check(`round-8: \`${marker}\` + ${sp} spaces -> item content is ${literal ? 'INDENTED CODE (fence literal)' : 'a PARAGRAPH (fence live)'}`,
          literal ? (!folded && visible && q.malformed.some((m) => m.startsWith('inert-html:')))
            : (folded && q.malformed.length === 0),
          { ctx, folded, visible, malformed: q.malformed });
      }
    }
    // The container STACK, not one level of it: the same two verdicts at depth,
    // through quotes, nested lists and mixed containers.
    for (const [what, ctx, literal] of [
      ['a nested list item with indented-code content', '- -     code', true],
      ['a nested list item with paragraph content', '- - item', false],
      ['a quote whose content is indented code', '>     code', true],
      ['a quote whose content is a paragraph', '> quoted text', false],
      ['a nested quote', '> > deep quote', false],
      ['a list inside a quote with indented-code content', '> -     code', true],
      ['a list inside a quote with paragraph content', '> - quoted item', false],
      ['a blank quote marker', '> quoted\n>', true],
      ['a setext underline inside a list item', '- Title\n  ===', true],
      ['a heading inside a list item', '- item\n  # h', true],
      ['a closed fence inside a quote', '> ```\n> x\n> ```', true],
      ['an under-indented (lazy) continuation of a list item', '- item\nlazy text', false],
    ]) {
      const q = parseResponseBlocks(`${ctx}\n<my-widget>\n\`\`\`\`orchard-notes\nTOK8D\n\`\`\`\`\n</my-widget>`);
      const folded = q.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes('TOK8D'));
      check(`round-8: ${what} -> ${literal ? 'literal' : 'live'}`,
        literal ? (!folded && q.fallbackRuns.some((r) => r.text.includes('TOK8D')))
          : (folded && q.malformed.length === 0),
        { ctx, folded, malformed: q.malformed, blocks: q.blocks.map((b) => b.name) });
    }

    /* ROUND 8's SECOND DEFECT, found by the reference differential and not by a
     * clean room — which is the point of having the oracle in the suite. Condition
     * 7 rejected the four type-1 tag NAMES in either form; the conditions are tried
     * in order, so `<pre>` never reaches 7 anyway, and what the reject really threw
     * out were COMPLETE CLOSING TAGS. A message opening with a lone `</pre>` had a
     * literal region this parser called live, and the example under it was folded
     * away. Hiding direction, so it is fixed rather than recorded. */
    for (const tag of ['</pre>', '</script>', '</style>', '</textarea>', '</PRE>', '<pre/>']) {
      const q = parseResponseBlocks(`${tag}\n\`\`\`\`orchard-notes\nTOKCLOSE\n\`\`\`\`\nTAIL`);
      check(`round-8b: a lone \`${tag}\` at the start of a message is a condition-7 HTML block (literal, reported)`,
        q.blocks.length === 0 && q.fallbackRuns.some((r) => r.text.includes('TOKCLOSE'))
        && q.malformed.join(',') === 'inert-html:orchard-notes@line2',
        { tag, blocks: q.blocks.map((b) => b.name), malformed: q.malformed });
      // ...and the paragraph clause still applies to it, which is what says it is
      // condition SEVEN and not a new blanket rule.
      const r = parseResponseBlocks(`Ordinary paragraph text.\n${tag}\n\`\`\`\`orchard-notes\nTOKCLOSE2\n\`\`\`\`\nTAIL`);
      check(`round-8b: ...and under a paragraph the same \`${tag}\` may NOT interrupt it, so the block below is live and silent`,
        r.blocks.length === 1 && r.blocks[0].content === 'TOKCLOSE2' && r.malformed.length === 0,
        { tag, blocks: r.blocks.map((b) => [b.name, b.content]), malformed: r.malformed });
    }
    // The condition-6 tag list is ONE pinned revision (0.31.2), not a union: the
    // intentional divergence the union created is gone, and this is the pin.
    {
      const src = parseResponseBlocks('Ordinary paragraph text.\n<source>\n````orchard-notes\nTOKSRC\n````\nTAIL');
      check('round-8b: `<source>` is NOT a condition-6 tag in CommonMark 0.31.2, so under a paragraph it is condition 7 — live, silent',
        src.blocks.length === 1 && src.blocks[0].content === 'TOKSRC' && src.malformed.length === 0,
        { blocks: src.blocks.map((b) => [b.name, b.content]), malformed: src.malformed });
      const srch = parseResponseBlocks('Ordinary paragraph text.\n<search>\n````orchard-notes\nTOKSRCH\n````\nTAIL');
      check('round-8b: ...and `<search>`, which 0.31.2 ADDED, IS condition 6, so it interrupts the paragraph (literal, reported)',
        srch.blocks.length === 0 && srch.fallbackRuns.some((r) => r.text.includes('TOKSRCH'))
        && srch.malformed.some((m) => m.startsWith('inert-html:')),
        { blocks: srch.blocks.map((b) => b.name), malformed: srch.malformed });
    }
  }

  /* ── the round-7 reported input, asserted on its own ──────────────────────
   * The clean-room case, character for character, plus the control that stops the
   * fix from degenerating into "condition 7 is always inert". Stated here as well
   * as in the corpus because the corpus grades 20,864 cases and a reader looking
   * for THE reported defect should not have to trust a stratum name. */
  {
    const heading = '# Completed heading\n<my-widget>\n````orchard-notes\nMUST-STAY-VISIBLE\n````\n</my-widget>';
    const p = parseResponseBlocks(heading);
    check('round-7: an ATX heading CLOSES the paragraph, so the tag below it is literal',
      p.blocks.length === 0 && p.counts['orchard-notes'] === 0, { blocks: p.blocks, counts: p.counts });
    check('round-7: ...the example inside it is fallback prose, i.e. visible',
      p.fallbackRuns.some((r) => r.text.includes('MUST-STAY-VISIBLE')), p.fallbackRuns.map((r) => r.text));
    check('round-7: ...and it is REPORTED',
      p.malformed.join(',') === 'inert-html:orchard-notes@line3', p.malformed);
    // Every other completed leaf block, the same way — the defect was never only
    // about headings, and fixing only the demonstrated shape is how this grammar
    // reached round seven.
    for (const [what, ctx] of [['a thematic break', '***'], ['a setext heading', 'Title\n==='],
      ['a closed code fence', '```\nx\n```'], ['an indented code block', '    x'],
      ['an empty list item', '-'], ['an empty block quote', '>']]) {
      const q = parseResponseBlocks(`${ctx}\n<my-widget>\n\`\`\`\`orchard-notes\nTOK7\n\`\`\`\`\n</my-widget>`);
      check(`round-7: ${what} also closes the paragraph (condition 7 is literal below it)`,
        q.blocks.length === 0 && q.fallbackRuns.some((r) => r.text.includes('TOK7'))
        && q.malformed.some((m) => m.startsWith('inert-html:')),
        { ctx, blocks: q.blocks.map((b) => b.name), malformed: q.malformed });
    }
    // THE OTHER DIRECTION. A paragraph really open above the tag means condition 7
    // may NOT interrupt it, so the block below is a genuine fold and the parse is
    // silent. Without this, "no block at all" is also satisfied by a parser that
    // simply stopped recognising notes blocks under any `<tag>` line.
    for (const [what, ctx] of [['paragraph text', 'Ordinary paragraph text.'],
      ['a lazy quote continuation', '> quoted text'], ['a list item', '- item text'],
      ['a link reference definition', '[ref]: /url']]) {
      const q = parseResponseBlocks(`${ctx}\n<my-widget>\n\`\`\`\`orchard-notes\nTOKLIVE\n\`\`\`\`\n</my-widget>`);
      check(`round-7: ${what} leaves the paragraph OPEN, so the block below is live and silent`,
        q.blocks.length === 1 && q.blocks[0].name === 'orchard-notes'
        && q.blocks[0].content === 'TOKLIVE' && q.malformed.length === 0,
        { ctx, blocks: q.blocks.map((b) => [b.name, b.content]), malformed: q.malformed });
    }
  }

  /* ── the round-5 reported input, asserted on its own, both halves ─────────
   * The corpus grades it, but the two claims that matter — VISIBLE and REPORTED —
   * are stated here explicitly, because "resolves visible and reported" is two
   * claims and the previous round shipped a parser that satisfied neither for
   * exactly this input while its suite stayed green. */
  {
    const html = '<div>\n````orchard-notes\nMUST-BE-READER-VISIBLE-HTML\n````\n</div>';
    const p = parseResponseBlocks(html);
    check('round-5: an HTML-block-wrapped notes example produces NO block at all',
      p.blocks.length === 0 && p.counts['orchard-notes'] === 0, { blocks: p.blocks, counts: p.counts });
    check('round-5: ...its content is fallback prose, i.e. visible',
      p.fallbackRuns.some((r) => r.text.includes('MUST-BE-READER-VISIBLE-HTML')), p.fallbackRuns.map((r) => r.text));
    check('round-5: ...and it is REPORTED, not silently absorbed',
      p.malformed.join(',') === 'inert-html:orchard-notes@line2', p.malformed);
    // Precision, on the same input shape: one blank line and the fence is live
    // again. Without this, "no block at all" would also be satisfied by a parser
    // that had simply stopped recognising notes blocks.
    const live = parseResponseBlocks('<div>\n\n````orchard-notes\nNARRATION\n````\n');
    check('round-5: a blank line ENDS the HTML block, so the fence below is live again',
      live.blocks.length === 1 && live.blocks[0].name === 'orchard-notes'
      && live.blocks[0].content === 'NARRATION' && live.malformed.length === 0,
      { blocks: live.blocks.map((b) => [b.name, b.content]), malformed: live.malformed });
    // ...and the region ends at that blank line even when a ``` run sits inside
    // it. Round 5 extended the region past the blank in that case ("inertness must
    // be monotone"); round 9's randomised differential showed the extension is a
    // FALSE inert region — the reference ends a type-6 HTML block at the first
    // blank line unconditionally, so the ``` inside it is literal text and the
    // `orchard-notes` fence after the blank is a genuine block. Asserted against
    // the reference's verdict, not against the old rule.
    const dangle = parseResponseBlocks('<div>\n```text\n\n````orchard-notes\nHIDDEN?\n````\n```\n');
    check('round-9: an HTML region ends at its blank line even with a ``` run inside it (the reference\'s verdict)',
      dangle.blocks.length === 1 && dangle.blocks[0].name === 'orchard-notes'
      && dangle.blocks[0].content === 'HIDDEN?' && dangle.malformed.length === 0,
      { blocks: dangle.blocks.map((b) => [b.name, b.content]), malformed: dangle.malformed });
  }

  /* ══ [1d] CONTAINER DIFFERENTIAL vs THE COMMONMARK REFERENCE ══════════════
   * The corpus strata above grade against a TRANSCRIPT of the reference's
   * verdicts, taken once, by hand, for the contexts someone thought to write
   * down. That is exactly the failure mode of the last four rounds: a generated
   * suite only catches defects in the dimensions it varies, and a transcript only
   * covers the rows it has. So the container model is ALSO checked against the
   * reference implementation LIVE, over a generated container space, in both
   * directions — the oracle that found the last three defects on this grammar.
   *
   * The sibling script scripts/verify-feat-091-commonmark-diff.mjs owns the
   * TOP-LEVEL space (73 contexts x 22 tag lines) and is run by `npm run
   * verify:feat-091-commonmark-diff`; this leg is the CONTAINER space, which is a
   * different dimension (container contexts x tag lines x the indent/marker
   * PREFIX applied to the tag and fence lines) and belongs with the corpus it
   * calibrates. Same oracle, same devDependency, same skip semantics.
   *
   * THE ORACLE, and it is stricter than the sibling's: for a document
   * `[ctx…] PRE+<tag> / PRE+\`\`\`\`orchard-notes / PRE+TOKEN / PRE+\`\`\`\` / TAIL`,
   * the reference verdict is "does the reference AST contain a fenced code_block
   * STARTING on the fence line whose info is `orchard-notes` and whose literal
   * holds TOKEN" — i.e. is that fence LIVE. Then:
   *   HIDING          reference says NOT live, this parser folds TOKEN away. Zero,
   *                   always: this is the defect class, in every round.
   *   UNDER           reference says live, this parser does not fold. Allowed ONLY
   *                   where the parser deliberately does not recognise a fence at
   *                   all (behind a `>` marker, or at 4+ raw columns) — and even
   *                   then the TOKEN MUST BE VISIBLE, which is asserted per case.
   * Plus the universal property: in EVERY document TOKEN is either folded with the
   * reference's agreement, or visible. Content is never lost either way. */
  console.log('\n[1d] container differential vs the CommonMark 0.31.2 reference implementation');
  {
    const cm = await (async () => {
      try {
        const m = await import('commonmark');
        const c = (m && typeof m.Parser === 'function') ? m : (m.default ?? m);
        return (c && typeof c.Parser === 'function') ? c : null;
      } catch { return null; }
    })();
    if (!cm) {
      skip('container differential vs the CommonMark reference implementation',
        'the `commonmark` devDependency is absent (a clean-room export strips node_modules and has no network); it is a devDependency, never required at runtime or by a session — do NOT install it to un-skip, that writes into the live tree. The `container` stratum above still graded 282 cases against the transcribed reference verdicts.');
    } else {
      const reader = new cm.Parser();
      const TOKEN = 'MUST-STAY-VISIBLE';
      /* Container contexts: quote and list markers at depth 1-3, every content
       * indentation across the 4-column threshold, continuation by indentation,
       * lazy continuation, blank lines inside a container, mixed containers, and
       * every leaf kind inside one. */
      const CTX = [
        ['none', []], ['q1', ['> quoted text']], ['q2', ['> > deep quote']],
        ['q3', ['> > > deeper']], ['q-blank', ['> quoted', '>']],
        ['q-then-blank', ['> quoted', '']], ['q-tight', ['>quoted']],
        ['q-heading', ['> # h']], ['q-icode', ['>     code']],
        ['li-1sp', ['- item']], ['li-2sp', ['-  item']], ['li-3sp', ['-   item']],
        ['li-4sp', ['-    item']], ['li-5sp-icode', ['-     code']],
        ['li-6sp-icode', ['-      code']], ['li-tab', ['-\titem']], ['li-empty', ['-']],
        ['li-ord', ['1. item']], ['li-ord-5sp', ['1.     code']],
        ['li-ord-paren', ['1) item']], ['li-ord-9', ['9. item']],
        ['li-nested', ['- - deep item']], ['li-nested3', ['- - - deepest']],
        ['li-cont', ['- item', '  more text']], ['li-cont-icode', ['- item', '      code']],
        ['li-blank-then-cont', ['- item', '', '  more']], ['li-then-blank', ['- item', '']],
        ['li-setext', ['- Title', '  ===']], ['q-setext', ['> Title', '> ===']],
        ['q-list', ['> - quoted item']], ['list-q', ['- > listed quote']],
        ['li-indent3', ['   - item']], ['li-fence', ['- item', '  ```', '  x', '  ```']],
        ['q-fence', ['> ```', '> x', '> ```']], ['li-html', ['- <div>', '  x', '']],
        ['li-para-2lines', ['- one', '  two']], ['li-lazy', ['- one', 'lazy two']],
        ['q-lazy', ['> one', 'lazy two']],
      ];
      const TAGS = [
        ['t7-open', '<my-widget>'], ['t7-close', '</my-widget>'], ['t7-self', '<img src="a" />'],
        ['t6-div', '<div>'], ['t1-pre', '<pre>'], ['t2-comment', '<!--'],
        ['prose-bare-lt', '<b'], ['prose-generic', 'Array<string>'],
      ];
      /* The prefix applied to the tag and fence lines: raw indent across the
       * 4-column threshold, and container markers, so the fence itself is put
       * inside a container as well as under one. */
      const PREFIX = ['', ' ', '  ', '   ', '    ', '     ', '> ', '- ', '  > '];
      const refFenceIsLive = (input, fenceLine1) => {
        const ast = reader.parse(input);
        for (let w = ast.walker(), ev; (ev = w.next());) {
          if (!ev.entering || ev.node.type !== 'code_block') continue;
          const sp = ev.node.sourcepos;
          if (sp && sp[0][0] === fenceLine1
            && String(ev.node.info || '').trim().toLowerCase() === 'orchard-notes'
            && String(ev.node.literal || '').includes(TOKEN)) return true;
        }
        return false;
      };
      const runContainerDiff = (parse) => {
        let n = 0, agreeLive = 0, agreeLiteral = 0;
        const hiding = [], underNotAllowed = [], lost = [];
        for (const [cid, ctx] of CTX) {
          for (const [tid, tag] of TAGS) {
            for (const pre of PREFIX) {
              const fenceLine1 = ctx.length + 2;
              const input = [...ctx, pre + tag, `${pre}\`\`\`\`orchard-notes`,
                pre + TOKEN, `${pre}\`\`\`\``, 'TAIL'].join('\n');
              const where = `${cid} + ${tid} + pre=${JSON.stringify(pre)}`;
              const live = refFenceIsLive(input, fenceLine1);
              let p;
              try { p = parse(input); } catch (e) { n++; hiding.push({ where, threw: e.message }); continue; }
              n++;
              const folded = p.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN));
              const visible = p.fallbackRuns.some((r) => r.text.includes(TOKEN))
                || p.blocks.some((b) => b.name !== 'orchard-notes' && b.content.includes(TOKEN));
              if (!folded && !visible) lost.push(where);
              if (!live && folded) hiding.push({ where, malformed: p.malformed });
              else if (live && !folded) {
                // The documented under-recognition: no fence is recognised at all
                // because it is behind a quote marker or at 4+ raw columns.
                const allowed = pre.includes('>') || /^ {4,}$/.test(pre);
                if (!allowed || !visible) underNotAllowed.push({ where, visible });
              } else if (folded) agreeLive++;
              else agreeLiteral++;
            }
          }
        }
        return { n, agreeLive, agreeLiteral, hiding, underNotAllowed, lost };
      };

      const cur = runContainerDiff(parseResponseBlocks);
      console.log(`      ${cur.n} documents (${CTX.length} contexts x ${TAGS.length} tags x ${PREFIX.length} prefixes); `
        + `${cur.agreeLive} agree LIVE, ${cur.agreeLiteral} agree LITERAL`);
      if (cur.hiding.length) console.log('      HIDING e.g.: ' + cur.hiding.slice(0, 6).map((d) => d.where).join(' | '));
      check('the container space is WIDE (>2500 generated documents, not a replay)', cur.n > 2500, cur.n);
      check('BOTH directions are exercised (>100 agree-live AND >100 agree-literal)',
        cur.agreeLive > 100 && cur.agreeLiteral > 100, { agreeLive: cur.agreeLive, agreeLiteral: cur.agreeLiteral });
      check('ZERO HIDING disagreements in container contexts — no reference-literal region is folded into orchard-notes (the round-8 shape)',
        cur.hiding.length === 0, { n: cur.hiding.length, first: cur.hiding.slice(0, 6) });
      check('every remaining UNDER-recognition is the DOCUMENTED one (fence behind a `>` marker or at 4+ columns) AND leaves the token visible',
        cur.underNotAllowed.length === 0, { n: cur.underNotAllowed.length, first: cur.underNotAllowed.slice(0, 6) });
      check('CONTENT IS NEVER LOST: in every document the token is folded-with-agreement or visible',
        cur.lost.length === 0, { n: cur.lost.length, first: cur.lost.slice(0, 6) });

      /* Non-vacuity, against the IMMEDIATELY PRIOR generation — the parser this
       * round's clean-room pass attacked. A fixed sha, never a moving baseline. */
      const CAL = '52807b9'; // FEAT-091 7th-verdict fix
      const g = spawnSync('git', ['-C', ROOT, 'show', `${CAL}:public/lib/response-blocks.js`], { encoding: 'utf8', maxBuffer: 1e8 });
      if (g.status !== 0 || !g.stdout) {
        skip(`container-differential calibration vs the round-7 generation (${CAL})`,
          'git or that commit is unavailable in this tree (shallow/exported clone) — the current-parser assertions above still ran');
      } else {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feat091-cdiff-'));
        try {
          const tmp = path.join(scratch, `rb-${CAL}.mjs`);
          fs.writeFileSync(tmp, g.stdout);
          let oldParse = null;
          try { oldParse = (await import(tmp)).parseResponseBlocks; } catch { /* export drift */ }
          if (typeof oldParse !== 'function') {
            skip(`container-differential calibration vs the round-7 generation (${CAL})`, 'that commit does not export a usable parseResponseBlocks');
          } else {
            const old = runContainerDiff(oldParse);
            console.log(`      round-7 (${CAL}): ${old.hiding.length} HIDING disagreements over the same ${old.n} documents`);
            check(`the container differential is NON-VACUOUS: the round-7 generation HIDES content here and the current one does not (${CAL})`,
              old.hiding.length >= 20, old.hiding.length);
          }
        } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      }
    }
  }

  /* ══ [2] fallback characterisation ═══════════════════════════════════════ */
  console.log('\n[2] fallback characterisation (the thing that names a future block)');

  {
    const c = characterise('Should I enable this per project, or globally for you?');
    check('a question is tagged question + second-person', c.tags.includes('question') && c.tags.includes('second-person'), c.tags);
  }
  {
    const c = characterise('  ok  parses well-formed blocks\nPASS  counts fallback\nTOTAL: 41 passed, 0 failed\nExit code 0');
    check('verbatim test output is tagged command-output', c.tags.includes('command-output'), c.tags);
    check('...and numbers-heavy is available as a corroborating tell',
      characterise('1 2 3 4 5 6 7 8 9 10').tags.includes('numbers-heavy'), true);
  }
  {
    const c = characterise('I ran the suite, then I rebuilt the index, and I will check the gate next.');
    check('agent narration is tagged first-person-narration', c.tags.includes('first-person-narration'), c.tags);
  }
  {
    const c = characterise('- one thing\n- two thing\n- three thing');
    check('a bullet run is tagged list', c.tags.includes('list'), c.tags);
  }
  {
    const long = 'A'.repeat(3000);
    const c = characterise(long);
    check('a long run is excerpted from BOTH ends and reports true size',
      c.chars === 3000 && c.excerpt.length < 900 && c.excerpt.includes('chars omitted'), { chars: c.chars, exLen: c.excerpt.length });
  }

  /* ══ [3] durable metrics ═════════════════════════════════════════════════ */
  console.log('\n[3] metrics: record, aggregate, survive a concurrent writer');

  const mfile = path.join(TMP, 'metrics.jsonl');
  {
    const structured = parseResponseBlocks(
      `${B4}orchard-answer\nDecision here.\n${B4}\nSome loose bulk that fits no block:\n- a\n- b\n${B4}orchard-notes\nnarration\n${B4}\n`);
    const r1 = recordTurn(structured, { file: mfile, session_id: 's1', cwd: '/proj' });
    const r2 = recordTurn(parseResponseBlocks('a bare short reply'), { file: mfile, session_id: 's2', cwd: '/proj' });
    check('recordTurn writes and reports ok', r1.ok && r2.ok, { r1, r2 });

    const s = summariseMetrics(mfile);
    check('both turns counted (compliant turns give the denominator)', s.turns === 2, s.turns);
    check('structured vs unstructured split recorded', s.structured === 1 && s.unstructured === 1, { st: s.structured, un: s.unstructured });
    check('fallback share is computed over STRUCTURED messages only', s.fallbackShareStructured > 0 && s.fallbackShareStructured < 1, s.fallbackShareStructured);
    check('block usage aggregated', s.blockCounts['orchard-answer'] === 1 && s.blockCounts['orchard-notes'] === 1, s.blockCounts);
    check('fallback tags aggregated (the "what shape is it" signal)', s.tagCounts.list >= 1, s.tagCounts);
    check('tag SIGNATURES aggregated', Object.keys(s.signatures).length >= 1, s.signatures);
    check('the uncategorized text itself is archived from a structured message',
      s.samples.some(x => x.excerpt.includes('fits no block')), s.samples.map(x => x.excerpt));
    check('the report renders and states BOTH decision rules',
      formatReport(s).includes('ADD A CATEGORY when') && formatReport(s).includes('FIX COMPLIANCE'),
      formatReport(s).slice(0, 60));
    // THE FALLBACK LOOP, end to end through the recorded metrics: a declared
    // uncategorized block is counted APART from loose prose, and its label is
    // clustered — which is the only thing that can name a missing category.
    {
      const f2 = path.join(TMP, 'declared.jsonl');
      const decl = (label) => `${B4}orchard-ask${'\n'}Pick one.${'\n'}${B4}${'\n'}${B4}orchard-uncategorized ${label}${'\n'}You are migrating a project. Execute these steps.${'\n'}${B4}${'\n'}`;
      recordTurn(parseResponseBlocks(decl('a copy-paste prompt for you to run')), { file: f2 });
      recordTurn(parseResponseBlocks(decl('A Copy-Paste Prompt For You To Run')), { file: f2 });
      recordTurn(parseResponseBlocks(`${B4}orchard-uncategorized${'\n'}unlabelled${'\n'}${B4}${'\n'}`), { file: f2 });
      const d = summariseMetrics(f2);
      check('declared uncategorized blocks are counted apart from loose prose',
        d.declaredBlocks === 3 && d.declaredChars > 0, { blocks: d.declaredBlocks, chars: d.declaredChars });
      check('labels are clustered case-insensitively, so one shape reads as one shape',
        d.declaredLabelCounts['a copy-paste prompt for you to run'] === 2, d.declaredLabelCounts);
      check('an unlabelled declared block is counted AS a defect, not as a label',
        d.declaredUnlabelled === 1 && Object.keys(d.declaredLabelCounts).some(k => k.startsWith('(no label')),
        { unlabelled: d.declaredUnlabelled, labels: Object.keys(d.declaredLabelCounts) });
      check('the content is characterised, so a reader can see WHAT keeps landing there',
        d.declaredTagCounts['second-person'] >= 2 && d.declaredSamples[0].excerpt.includes('migrating a project'),
        { tags: d.declaredTagCounts, sample: d.declaredSamples[0]?.excerpt });
      const rep = formatReport(d);
      check('the report names the missing category out loud',
        rep.includes('a copy-paste prompt for you to run') && rep.includes('DECLARED UNCATEGORIZED'),
        rep.split('\n').filter(l => l.includes('copy-paste')).slice(0, 2));
    }
  }

  {
    // Truncation: the hook appends while a reader runs. Grade EVERY cut point of
    // a real 2-line file, not just the complete one.
    const whole = fs.readFileSync(mfile, 'utf8');
    let allOk = true; const bad = [];
    for (let cut = 1; cut <= whole.length; cut++) {
      const f = path.join(TMP, 'trunc.jsonl');
      fs.writeFileSync(f, whole.slice(0, cut));
      try {
        const s = summariseMetrics(f);
        if (typeof s.turns !== 'number' || s.turns < 0) { allOk = false; bad.push(cut); }
      } catch (e) { allOk = false; bad.push(`${cut}:${e.message}`); }
    }
    check(`every one of ${whole.length} truncation points parses without throwing`, allOk, bad.slice(0, 5));
    const halfway = summariseMetrics((() => {
      const f = path.join(TMP, 'half.jsonl');
      fs.writeFileSync(f, whole.slice(0, Math.floor(whole.length * 0.75)));
      return f;
    })());
    check('a half-written trailing line is skipped, not fatal, and counted as skipped',
      halfway.turns >= 1 && halfway.skippedLines >= 1, { turns: halfway.turns, skipped: halfway.skippedLines });
  }

  {
    const s = summariseMetrics(path.join(TMP, 'no-such-file.jsonl'));
    check('a missing metrics file summarises to zeros, never throws', s.turns === 0, s.turns);
  }

  {
    // Capture policy: an unstructured message must not archive bulk prose.
    const big = 'x '.repeat(4000);
    const recS = buildRecord(parseResponseBlocks(`${B4}orchard-answer\nhi\n${B4}\n${big}`), {});
    const recU = buildRecord(parseResponseBlocks(big), {});
    check('structured message keeps a full excerpt of its fallback', recS.fallbackRuns[0].excerpt.length > 300, recS.fallbackRuns[0].excerpt.length);
    check('unstructured message keeps only a short characterising snippet', recU.fallbackRuns[0].excerpt.length <= 240, recU.fallbackRuns[0].excerpt.length);
    check('both still record the TRUE size of what fell outside',
      recU.fallbackChars >= 8000 && recU.fallbackRuns[0].chars >= 8000, { rec: recU.fallbackChars });
  }

  {
    // A pathological reply must not write an unbounded line.
    const many = Array.from({ length: 40 }, (_, i) => `${B4}orchard-notes\nn${i}\n${B4}\n${'z'.repeat(3000)}`).join('\n');
    const rec = buildRecord(parseResponseBlocks(many), {});
    check('runs per record are capped', rec.fallbackRuns.length <= 12 && rec.fallbackRunsTotal > 12, { kept: rec.fallbackRuns.length, total: rec.fallbackRunsTotal });
    const f = path.join(TMP, 'cap.jsonl');
    recordTurn(parseResponseBlocks(many), { file: f });
    const line = fs.readFileSync(f, 'utf8').trim();
    check('the written line stays under the 24KB cap', line.length <= 24 * 1024, line.length);
  }

  {
    // Unwritable sink: a regular FILE stands where the log directory must be, so
    // mkdir fails with ENOTDIR. (Kept inside TMP deliberately — a path outside it
    // stalls under the sandbox rather than erroring, which would mask the check.)
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    const r = recordTurn(parseResponseBlocks('x'), { file: path.join(blocker, 'logs', 'm.jsonl') });
    check('an unwritable sink returns not-ok instead of throwing', r.ok === false && typeof r.reason === 'string', r);
  }

  /* ══ [4] the Stop hook, end to end, over real transcripts ════════════════ */
  console.log('\n[4] Stop hook: advisory, records metrics, never drops content');

  const transcript = (name, text) => {
    const file = path.join(TMP, name + '.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    ].join('\n') + '\n');
    return file;
  };
  // Never let a MISSING record crash the run: a regression must report every
  // failing check, not fatal on the first one.
  const lastRecord = () => metricLines().pop() ?? EMPTY_REC;

  const runHook = (payload, env = {}) => {
    const p = ownPayload(payload);
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify(p), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ORCHARD_SESSION: ownMarker(p), CLAUDE_STATION_DATA: DATA, ORCHARD_STOP_HOOK_ENFORCE: '', ORCHARD_STOP_HOOK_DISABLED: '', ...env },
    });
    return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  };
  const metricsFile = path.join(DATA, 'logs', 'response-format-metrics.jsonl');
  const EMPTY_REC = { counts: {}, fallbackRuns: [], malformed: [], shape: null, fallbackChars: 0 };
  const metricLines = () => {
    try { return fs.readFileSync(metricsFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); }
    catch { return []; }
  };

  // A REALISTIC busy reply: digest + repeated blocks + inner code + a loose run.
  const BUSY = [
    `${B3}orchard-digest`,
    '{"items":[{"text":"Shipped layer 2.","kind":"done","importance":"high","ref":"FEAT-091"}]}',
    B3,
    '',
    `${B4}orchard-answer`,
    'The block vocabulary is two names. Confirm before the renderer lane starts.',
    B4,
    '',
    `${B4}orchard-notes`,
    'I parsed the grammar, then wired the hook. Example fence:',
    `${B3}js`,
    'parseResponseBlocks(text)',
    B3,
    B4,
    '',
    'Loose verification output that fits no block today:',
    '  ok    parses well-formed blocks',
    'TOTAL: 41 passed, 0 failed',
    '',
    `${B4}orchard-answer`,
    'Second answer block, later in the same message.',
    B4,
  ].join('\n');

  {
    const before = metricLines().length;
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript('busy', BUSY), cwd: '/nonexistent/proj' });
    check('busy realistic reply -> hook exits 0 (advisory, never blocks)', res.code === 0, res);
    check('busy realistic reply -> no block decision emitted', !res.stdout.includes('"decision"'), res.stdout.slice(0, 120));
    const lines = metricLines();
    check('a metrics line was appended', lines.length === before + 1, { before, after: lines.length });
    const rec = lines[lines.length - 1] ?? EMPTY_REC;
    check('block usage recorded (answer x2, notes x1, digest x1)',
      rec.counts['orchard-answer'] === 2 && rec.counts['orchard-notes'] === 1 && rec.counts['orchard-digest'] === 1, rec.counts);
    check('the loose verification output was counted as fallback', rec.fallbackChars > 0, rec.fallbackChars);
    check('...and characterised as command-output, which is what would name a block',
      rec.fallbackRuns.some(r => r.tags.includes('command-output')), rec.fallbackRuns.map(r => r.tags));
    check('...and its text archived for a later reader',
      rec.fallbackRuns.some(r => r.excerpt.includes('TOTAL: 41 passed')), rec.fallbackRuns.map(r => r.excerpt));
    check('session id and cwd recorded', rec.session_id === undefined || rec.cwd === '/nonexistent/proj', { cwd: rec.cwd });
  }

  {
    // Uncategorized prose is MEASURED, NOT POLICED: it must never raise anything.
    const good = `${B3}orchard-digest\n{"items":[{"text":"Done.","kind":"done"}]}\n${B3}\nShort plain prose with no blocks at all.`;
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript('nofmt', good), cwd: '/nonexistent/proj' });
    check('a compliant digest-only reply with 100% fallback prose stays SILENT', res.code === 0 && res.stdout === '', res);
    const rec = lastRecord();
    // The digest IS a known block, so this reply is `structured` with 100% of its
    // PROSE in fallback — which is exactly the pre-FEAT-091 baseline every reply
    // starts from, and the number that should fall as layer 2 gets adopted.
    check('...but is still recorded, prose counted as fallback', rec.shape === 'structured' && rec.fallbackChars > 0 && rec.counts['orchard-answer'] === 0, { shape: rec.shape, fb: rec.fallbackChars });
  }

  {
    // A genuinely blockless short reply: the no-ceremony case, end to end.
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript('bare', 'Yes, that works.'), cwd: '/nonexistent/proj' });
    check('a bare blockless reply -> exits 0, no block decision', res.code === 0 && !res.stdout.includes('"decision"'), res);
    const rec = lastRecord();
    check('a bare blockless reply -> recorded as unstructured (the denominator)',
      rec.shape === 'unstructured' && rec.counts['orchard-answer'] === 0, { shape: rec.shape, counts: rec.counts });
    check('...and no malformed flag is raised for having no blocks', (rec.malformed || []).length === 0, rec.malformed);
  }

  {
    const bad = `${B3}orchard-digest\n{"items":[{"text":"Done.","kind":"done"}]}\n${B3}\n${B4}orchard-answer\nnever closed and the fence is missing`;
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript('unterm', bad), cwd: '/nonexistent/proj' });
    check('unterminated fence -> still exits 0 and does NOT block (advisory)', res.code === 0 && !res.stdout.includes('"decision"'), res);
    check('unterminated fence -> advisory mentions closing the fence',
      res.stdout.includes('orchard-answer') && /close every/i.test(res.stdout), res.stdout.slice(0, 200));
    const rec = lastRecord();
    check('unterminated fence -> recorded as malformed', (rec.malformed || []).some(m => m.startsWith('unterminated')), rec.malformed);
    check('unterminated fence -> the content still counted as fallback, not lost',
      rec.fallbackRuns.some(r => r.excerpt.includes('never closed')), rec.fallbackRuns.map(r => r.excerpt));
  }

  {
    // ENFORCE mode is opt-in; even there, plain uncategorized prose must not block.
    const good = `${B3}orchard-digest\n{"items":[{"text":"Done.","kind":"done"}]}\n${B3}\nOrdinary prose. Nothing is inside a block here.`;
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript('enf', good), cwd: '/nonexistent/proj' }, { ORCHARD_STOP_HOOK_ENFORCE: '1' });
    check('ENFORCE mode: fallback prose alone is not a violation', res.code === 0 && res.stdout === '', res);
  }

  {
    // Truncated transcript: the hook reads a file another process is writing.
    const whole = fs.readFileSync(transcript('trunc-src', BUSY), 'utf8');
    let allowed = 0, blocked = 0, errored = 0;
    const cuts = [];
    for (let i = 1; i <= 24; i++) cuts.push(Math.floor(whole.length * (i / 24)));
    for (const cut of cuts) {
      const f = path.join(TMP, 'trunc-t.jsonl');
      fs.writeFileSync(f, whole.slice(0, cut));
      const res = runHook({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path: f, cwd: '/nonexistent/proj' });
      if (res.code !== 0) errored++;
      else if (res.stdout.includes('"decision"')) blocked++;
      else allowed++;
    }
    check(`all ${cuts.length} truncated-transcript reads exit 0 (never wedge)`, errored === 0, { errored });
    check('no truncation point produced a block', blocked === 0, { blocked, allowed });
  }

  {
    const res = runHook({ hook_event_name: 'Stop', stop_hook_active: true, transcript_path: transcript('loop', 'garbage'), cwd: '/x' });
    check('loop safety preserved: stop_hook_active -> silent allow', res.code === 0 && res.stdout === '', res);
  }

  /* ══ [5] injection reaches a composed prompt ═════════════════════════════ */
  console.log('\n[5] injection into the composed system prompt (REAL committed doc)');

  process.env.CLAUDE_STATION_DATA = DATA;
  const { composeInstructions, responseFormatSection, RESPONSE_FORMAT_RELPATH } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const realDoc = path.join(ROOT, RESPONSE_FORMAT_RELPATH);

  // A CLEAN-ROOM EXPORT strips docs/prose as contamination, so the real committed
  // doc this section deliberately reads is simply absent there. That is an
  // environment fact, not a defect: SKIP with the reason stated, rather than crash
  // and hand an independent verifier a failure that is about their sandbox.
  const docPresent = fs.existsSync(realDoc);
  if (!docPresent) {
    skip(`[5] injection: ${RESPONSE_FORMAT_RELPATH} is not present in this tree`,
      'clean-room exports strip docs/; the injection path needs the real committed doc');
  }

  if (docPresent) {
    const sec = responseFormatSection({ filePath: realDoc });
    check('the REAL committed doc yields a section', typeof sec === 'string' && sec.length > 0, sec ? sec.length : sec);
    check('layer 1 survives injection (orchard-digest)', sec.includes('orchard-digest'), true);
    // EVERY category name must reach the prompt: a name the agent is never told
    // about is a name it can never use, and the metrics would read that as the
    // category being unnecessary.
    for (const n of ['orchard-finding', 'orchard-outcome', 'orchard-ask', 'orchard-judgment',
                     'orchard-status', 'orchard-narration', 'orchard-uncategorized']) {
      check(`layer 2 reaches the prompt (${n})`, sec.includes(n), true);
    }
    // The RETIRED names must NOT be advertised — they still parse forever, but a
    // new turn must not be taught to write one.
    check('the legacy names are NOT injected (they parse, they are not taught)',
      !sec.includes('orchard-answer') && !sec.includes('orchard-notes'), true);
    check('the fallback-is-not-lost rule reaches the prompt', /renders as ordinary prose/.test(sec), true);
    check('the split-a-compound-passage rule reaches the prompt', /is two passages: split it/.test(sec), true);
    check('the leave-nothing-loose rule reaches the prompt', /Leave nothing loose/i.test(sec), true);
    check('the fallback REQUIRES a label in the injected core', /orchard-uncategorized <short label/.test(sec), true);
    check('the section is NOT truncated by maxChars', !sec.trimEnd().endsWith('…'), sec.slice(-60));
    check('human-only doc body is NOT injected (cost discipline)',
      !sec.includes('Why named fenced blocks') && !sec.includes('Per-project override'), true);
    // THE COST DISCIPLINE, restated for round 12: the vocabulary tripled, so the
    // budget is the thing that has to hold. Six names + a fallback, one line each.
    // This bound is the SAME budget verify:feat-084 pins; keep the two in step. It
    // was left at 4000 when round 14 (FEAT-098) grew the core to ~5245 and raised
    // only feat-084's copy to 5500; ARCH-016 added the lane-final-message contract
    // (+~440, observed 5687) and both are now 5900, still under the 6000 maxChars
    // cap so the core is delivered whole. Growing past this is a decision.
    check('the injected core stays inside its stated budget',
      sec.length <= 5900 && sec.length < 6000, { sectionChars: sec.length });
  }

  if (docPresent) {
    const base = composeInstructions([], { hostPath: '/nonexistent' });
    const off = composeInstructions([], { hostPath: '/nonexistent', responseFormat: false });
    const on = composeInstructions([], { hostPath: '/nonexistent', responseFormat: realDoc });
    const app = (r) => (typeof r.systemPrompt === 'string' ? r.systemPrompt : r.systemPrompt?.append ?? '');
    check('disabled path is byte-identical to before the option existed', app(off) === app(base), { off: app(off).length, base: app(base).length });
    check('enabled path actually injects (identity test is not vacuous)', app(on) !== app(base) && app(on).includes('orchard-finding'), app(on).length);
    check('response-format is the LAST applied id', on.appliedIds[on.appliedIds.length - 1] === 'response-format', on.appliedIds);
  }

  /* ══ [6] a freshly onboarded scratch project gets it all ═════════════════ */
  console.log('\n[6] onboarding delivery (real onboard.mjs into a scratch dir)');

  const target = path.join(TMP, 'scratch-project');
  fs.mkdirSync(path.join(target, '.git'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'scratch', version: '0.0.0', scripts: {} }, null, 2));
  const ob = spawnSync('node', [path.join(ROOT, 'scripts', 'onboard.mjs'), '--dir', target], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_STATION_DATA: DATA },
  });
  check('onboard.mjs exits 0 on a fresh scratch project', ob.status === 0, { status: ob.status, err: (ob.stderr || '').slice(-400) });

  for (const rel of ['scripts/hooks/response-format-gate.mjs', 'public/lib/response-blocks.js', 'scripts/lib/format-metrics.mjs', 'scripts/lib/readability.mjs', 'public/lib/digest.js']) {
    check(`onboarded project has ${rel}`, fs.existsSync(path.join(target, rel)));
  }
  {
    // FEAT-091 renderer lane relocated the grammar to public/lib/response-blocks.js
    // (one parser shared by the hook and the browser UI, like public/lib/digest.js).
    const a = fs.readFileSync(path.join(ROOT, 'public/lib/response-blocks.js'), 'utf8');
    const b = fs.existsSync(path.join(target, 'public/lib/response-blocks.js')) ? fs.readFileSync(path.join(target, 'public/lib/response-blocks.js'), 'utf8') : '';
    check('the copied grammar is byte-identical to the source', a === b, { same: a === b });
  }
  {
    const s = fs.existsSync(path.join(target, '.claude/settings.json')) ? fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8') : '';
    check('the Stop hook is wired in the onboarded .claude/settings.json', s.includes('response-format-gate.mjs'), s.slice(0, 200));
  }
  {
    // The real requirement: the COPIED hook actually runs THERE, with no manual
    // setup, and records metrics into that machine's data dir.
    const tData = path.join(TMP, 'target-data');
    const tTranscript = path.join(TMP, 'target.jsonl');
    fs.writeFileSync(tTranscript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: BUSY }] } }) + '\n');
    const r = spawnSync('node', [path.join(target, 'scripts/hooks/response-format-gate.mjs')], {
      input: JSON.stringify({ session_id: SUITE_SESSION_ID, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tTranscript, cwd: target }),
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ORCHARD_SESSION: SUITE_SESSION_ID, CLAUDE_STATION_DATA: tData, ORCHARD_STOP_HOOK_ENFORCE: '', ORCHARD_STOP_HOOK_DISABLED: '' },
    });
    check('the COPIED hook runs in the onboarded project and exits 0', r.status === 0, { status: r.status, err: (r.stderr || '').slice(-300) });
    const f = path.join(tData, 'logs', 'response-format-metrics.jsonl');
    check('the COPIED hook records metrics with zero manual setup', fs.existsSync(f), f);
    if (fs.existsSync(f)) {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());
      check('...with the same block accounting as the source repo', rec.counts['orchard-answer'] === 2 && rec.counts['orchard-notes'] === 1, rec.counts);
    }
  }

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed, ${skipped.length} skipped`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  if (skipped.length) console.log('skipped (environment, not defects):\n  - ' + skipped.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of [TMP, DATA]) fs.rmSync(d, { recursive: true, force: true });
});
