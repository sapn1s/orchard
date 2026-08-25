#!/usr/bin/env node
/**
 * FEAT-091 — STANDING differential test of the block grammar's notion of a
 * LITERAL region against the CommonMark 0.31.2 REFERENCE implementation (John
 * MacFarlane's own — `commonmark` on npm, the spec editor's port).
 *
 *   node scripts/verify-feat-091-commonmark-diff.mjs
 *
 * WHY THIS EXISTS. This grammar has had SEVEN clean-room BROKEN verdicts, most of
 * them because the parser's model of a markdown construct disagreed with what
 * markdown actually does: a `~~~` fence (round 4), a top-level HTML block wrapper
 * (round 5), an over-wide HTML-start predicate (round 6), condition 7's
 * "may not interrupt a paragraph" clause approximated by a boolean any non-blank
 * line set (round 7), and a container model that stripped markers with a regex
 * instead of tracking the container STACK, so a list item whose content was
 * indented code looked like an open paragraph (round 8). Every one is a disagreement about whether the region a
 * `````orchard-notes` fence sits in is LITERAL. The strongest possible check is
 * therefore to ask the spec editor's OWN implementation the same question, over a
 * wide space, in BOTH directions, and require agreement.
 *
 * The round-7 lane built and validated this exact harness (73 contexts x 22 tag
 * lines = 1,606 documents; the round-6 parser generation shows 240 disagreements,
 * the current parser zero) in a scratch install under /tmp, because it could not
 * touch package.json. Its own handoff: "A separate lane is wiring `commonmark` in
 * as a standing check and owns package.json; when it lands, this differential
 * belongs in the suite." This is that wiring — the harness adopted verbatim, with
 * the pinned devDependency as its oracle rather than a point-in-time /tmp install.
 *
 * THE PROPERTY, observable from the outside. For a document
 * `[context...] <tag> \n ````orchard-notes \n TOKEN \n ```` \n TAIL`:
 *   REFERENCE verdict — does an `html_block` node in the reference AST cover the
 *                       fence line? (i.e. the context+tag made it literal)
 *   PARSER verdict    — did parseResponseBlocks fold TOKEN into an orchard-notes
 *                       block (live) or leave it visible (literal)?
 * They must agree BOTH ways: a reference-literal region the parser folds HIDES the
 * token behind a collapsed fold (the round-5/round-7 defect); a reference-live
 * region the parser calls literal corrupts the parse and flags well-formed input
 * (the round-6 defect).
 *
 * ENVIRONMENT. `commonmark` is a devDependency — never required at runtime or by a
 * session, never imported by src/ or public/. A clean-room export strips
 * node_modules and has no network, so its absence is an environment fact, not a
 * defect: this SKIPs with the reason, counted in the TOTAL, exactly as the
 * stripped-doc and missing-git legs of the sibling suites do. Do NOT `npm install`
 * it to un-skip in a clean room — that clean room's node_modules is a symlink into
 * the live repo, so the install writes the dependency into the live tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The randomised generator is SHARED with the renderer's browser leg — see the
// block comment at [3] below for why it does not live in this file any more.
import { rngFrom, fuzzDoc, FUZZ_TOKEN } from './lib/feat-091-fold-corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PARSER = path.join(ROOT, 'public', 'lib', 'response-blocks.js');

// The immediately-prior parser generation, for the non-vacuity calibration: the
// round-7 fix, before round 8 replaced the prefix-stripping container model with a
// real container stack and aligned the tag grammar with the reference. A FIXED
// sha, never a moving baseline (docs/CONVENTIONS.md: a must-FAIL proof must not be
// anchored to a moving one), so the number it prints is reproducible. It scores
// 460 disagreements on this space — 378 hiding, 82 over-recognition — where the
// current parser scores 0. (The round-6 generation, 5565736, scores 772.)
const CALIBRATION_SHA = '52807b9'; // FEAT-091 7th-verdict fix
// ...and, for the RANDOMISED leg below, round 10, EVERY generation the fuzz has replaced, not just the last
// one. The generator grew multi-line constructs this round, so the honest
// question is not "does the newest space embarrass the newest predecessor" but
// "does it still score every generation before it" — a calibration TABLE. Each
// row is a fixed sha with the floor it must clear; `class` names the direction
// that generation's own defect lived in, so a row cannot pass on unrelated noise.
const FUZZ_CALIBRATION = [
  { sha: '5565736', label: 'round 6', minBad: 50, cls: 'hiding', minCls: 5 },
  { sha: '52807b9', label: 'round 7', minBad: 50, cls: 'hiding', minCls: 5 },
  { sha: '10db355', label: 'round 8', minBad: 50, cls: 'hiding', minCls: 5 },
  // Round 9 is the generation THIS round replaced. Its defect is the WRONGLY-
  // LITERAL direction — a multi-line link reference definition it could not see —
  // so it shows up as over-recognition, and the fold it destroys is content the
  // reader never sees folded. `hiding` is NOT its class and is not required.
  { sha: '91b35ab', label: 'round 9', minBad: 50, cls: 'over', minCls: 20 },
];

let pass = 0, fail = 0;
const failures = [];
const skipped = [];
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

/* ══ [3] THE RANDOMISED DIFFERENTIAL ═══════════════════════════════════════
 * The enumerated space above is a MATRIX: 107 contexts someone thought to write
 * down, crossed with 31 tag lines someone thought to write down. Every round of
 * this grammar has been found by a shape that was not in the matrix — and round
 * 9's was found by generating random container-and-tag combinations against the
 * reference instead of replaying a fixed list. The round-8 lane RAN such a fuzz,
 * thirty thousand documents in scratch, and did not commit it; the defect came
 * through exactly that gap. So it is committed, and it is the check that ends the
 * cycle: it generates FRESH combinations on every run.
 *
 * WHAT IS RANDOMISED, i.e. the dimensions the matrix cannot enumerate:
 *   - CONTAINER LINES: 0-4 of them, each 0-4 columns of indent, then 0-2 nested
 *     container markers — block quotes (`>`, `> `, `>  `) and list markers with a
 *     RANDOM DIGIT COUNT (1-10, so both sides of CommonMark's nine-digit limit),
 *     either delimiter, and 0-7 following spaces or a tab (so both sides of the
 *     5-spaces-means-indented-code threshold) — then a random leaf: prose, blank,
 *     ATX, setext underlines, thematic breaks, indented code, fence openers of
 *     both characters, HTML starts of every condition, a link reference
 *     definition, a table row, and prose that merely LOOKS like HTML.
 *   - MULTI-LINE CONSTRUCTS (round 10), which no per-line leaf pool can reach:
 *     link reference definitions split across up to three lines over `\n`- and
 *     TAB-bearing separators, with titles that may or may not end their line;
 *     multi-line HTML blocks of conditions 2-5; an unterminated fence; indented
 *     code interrupted by a blank. Their continuation lines carry the container
 *     prefix, a blanked-out prefix, or nothing at all — so LAZY continuation of a
 *     half-finished construct is generated too. One document in four also ends
 *     its context with a definition block plus a setext underline, immediately
 *     above the tag line, because that ADJACENCY is what decides condition 7.
 *   - THE TAG LINE: a random tag name from the condition-1/6 lists and outside
 *     them, 0-2 attributes with random names over the spec's character classes
 *     (`[A-Za-z_:][A-Za-z0-9:._-]*`), quoted / single-quoted / unquoted values,
 *     random whitespace runs INCLUDING tab and form feed, optional self-closing
 *     slash, optional trailing text — plus the non-tag controls.
 *   - THE FENCE ITSELF: either character, 3-5 long, and a random indent or
 *     container prefix shared by the fence, its body and its close.
 *
 * THE ORACLE, stated precisely. For each document the reference is asked: does a
 * fenced code block with info `orchard-notes` OPEN at the fence line, hold the
 * token, and CLOSE at the close line? That is LIVE. Anything else — an enclosing
 * html_block, an enclosing code block, indented code, or a fence that never
 * closes — is LITERAL, because in every one of those cases the token reaches the
 * reader. `parseResponseBlocks` must reach the same verdict, and separately, on
 * EVERY document, a token that is not folded must be VISIBLE in the parse
 * (fallback or an expanded block) — the invariant stated over the reader rather
 * than over the parse tree.
 *
 * REPRODUCIBILITY: the seed is random per run and PRINTED; set
 * FEAT091_FUZZ_SEED=<n> to replay a failure exactly, FEAT091_FUZZ_N=<n> to widen.
 */
const FUZZ_N = Number(process.env.FEAT091_FUZZ_N || 20000);
const FUZZ_SEED = Number(process.env.FEAT091_FUZZ_SEED || (Date.now() % 2147483647));

/*
 * THE GENERATOR ITSELF now lives in scripts/lib/feat-091-fold-corpus.mjs, beside
 * the enumerated corpus, and is imported above. It moved in round 12 because the
 * eleventh independent pass named the one residual it could still see: this space
 * — roughly 480,000 documents a run — was graded in NODE ONLY, against the
 * reference, and never RENDERED. The tenth defect passed every parser-level check
 * and was caught only in a real browser, so a huge randomised space explored
 * nowhere near the reader is that same blind spot one level up.
 *
 * verify-feat-091-renderer.mjs [R] now samples this exact function and renders the
 * sample in a real browser. Sharing ONE generator is the point: two copies of a
 * fuzz space drift, and then the leg that renders and the leg that differentials
 * stop being about the same documents. The move was proven behaviour-preserving
 * rather than asserted — 20,000 documents x 4 seeds, byte-identical before and
 * after, fence and close line numbers included.
 */

/**
 * Run the randomised differential. Returns counts plus up to a few examples per
 * direction, each carrying the full input so a failure is copy-pasteable.
 */
function runFuzz(reader, parse, seed, n) {
  const rnd = rngFrom(seed);
  const refLive = (input, fenceLine, closeLine) => {
    const ast = reader.parse(input);
    for (let w = ast.walker(), ev; (ev = w.next());) {
      if (!ev.entering) continue;
      const nd = ev.node;
      if (nd.type !== 'code_block' || !nd._isFenced) continue;
      if (nd.sourcepos[0][0] !== fenceLine || nd.sourcepos[1][0] !== closeLine) continue;
      if ((nd.info || '').trim().toLowerCase() !== 'orchard-notes') continue;
      if (!(nd.literal || '').includes(FUZZ_TOKEN)) continue;
      return true;
    }
    return false;
  };
  let live = 0, literal = 0;
  const hiding = [], over = [], lost = [];
  const t0 = Date.now();
  for (let k = 0; k < n; k++) {
    const d = fuzzDoc(rnd);
    let isLive;
    try { isLive = refLive(d.input, d.fenceLine, d.closeLine); } catch { continue; }
    let parsed;
    try { parsed = parse(d.input); }
    catch (e) { over.push({ input: d.input, threw: e.message }); continue; }
    const folded = parsed.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(FUZZ_TOKEN));
    if (!folded) {
      const visible = parsed.fallbackRuns.some((r) => r.text.includes(FUZZ_TOKEN))
        || parsed.blocks.some((b) => b.name !== 'orchard-notes' && b.content.includes(FUZZ_TOKEN));
      if (!visible) lost.push({ input: d.input, malformed: parsed.malformed });
    }
    if (isLive && !folded) over.push({ input: d.input, malformed: parsed.malformed });
    else if (!isLive && folded) hiding.push({ input: d.input, malformed: parsed.malformed });
    else if (folded) live++;
    else literal++;
  }
  return { n, ms: Date.now() - t0, live, literal, hiding, over, lost };
}

const FENCE = '````orchard-notes';
const TOKEN = 'MUST-STAY-VISIBLE';

/**
 * Every kind of block that can sit ABOVE the tag line. Round 7's defect lived in
 * this dimension: an `# ATX heading` above a complete custom tag left the parser's
 * `paragraphOpen` flag set, so condition 7 was suppressed, the literal region went
 * unrecognised, and the notes example under it became a real closed fold. The
 * round-6 corpus had exactly two contexts (blank, paragraph); this is 107 — every
 * leaf and container block that changes what "the previous line" is to condition 7,
 * including (round 8) the CONTAINER STACK contexts at the end of the list.
 */
const CONTEXTS = [
  ['none', []],
  ['paragraph', ['Ordinary paragraph text.']],
  ['paragraph-two-lines', ['Line one of prose.', 'Line two of prose.']],
  ['blank', ['']],
  ['prose-then-blank', ['Prose.', '']],
  ['atx-h1', ['# Completed heading']],
  ['atx-h2', ['## Completed heading']],
  ['atx-h3', ['### h']],
  ['atx-h4', ['#### h']],
  ['atx-h5', ['##### h']],
  ['atx-h6', ['###### h']],
  ['atx-closed-seq', ['## Done ##']],
  ['atx-empty', ['#']],
  ['atx-indent3', ['   # h']],
  ['atx-after-prose', ['Prose.', '# h']],
  ['not-atx-7hashes', ['####### seven']],
  ['not-atx-hashtag', ['#hashtag']],
  ['tbreak-dash', ['---']],
  ['tbreak-star', ['***']],
  ['tbreak-underscore', ['___']],
  ['tbreak-spaced', ['* * *']],
  ['tbreak-long', ['-----']],
  ['tbreak-indent3', ['   ***']],
  ['tbreak-after-prose', ['Prose.', '***']],
  ['setext-h1', ['Title', '===']],
  ['setext-h2', ['Title', '---']],
  ['setext-single-eq', ['Title', '=']],
  ['setext-single-dash', ['Title', '-']],
  ['fence-backtick-closed', ['```js', 'x', '```']],
  ['fence-tilde-closed', ['~~~', 'x', '~~~']],
  ['fence-info-closed', ['```markdown', 'x', '```']],
  ['fence-after-prose', ['Prose.', '```', 'x', '```']],
  ['html-t6-closed', ['<div>', 'x', '</div>', '']],
  ['html-t6-blankended', ['<div>', 'x', '']],
  ['html-comment-1line', ['<!-- an aside -->']],
  ['html-doctype', ['<!DOCTYPE html>']],
  ['html-cdata-1line', ['<![CDATA[x]]>']],
  ['html-pi-1line', ['<?xml version="1.0"?>']],
  ['html-pre-closed', ['<pre>', 'x', '</pre>']],
  ['icode-4sp', ['    code line']],
  ['icode-tab', ['\tcode line']],
  ['icode-after-blank', ['', '    code line']],
  ['icode-after-prose', ['Prose.', '    continuation']],
  ['quote-text', ['> quoted text']],
  ['quote-empty', ['>']],
  ['quote-tight', ['>quoted']],
  ['quote-nested', ['> > deep']],
  ['quote-heading', ['> # quoted heading']],
  ['quote-blank-after', ['> quoted', '']],
  ['list-dash-text', ['- item text']],
  ['list-star-text', ['* item text']],
  ['list-plus-text', ['+ item text']],
  ['list-ordered-text', ['1. item text']],
  ['list-ordered-paren', ['1) item text']],
  ['list-empty-dash', ['-']],
  ['list-empty-star', ['*']],
  ['list-empty-ordered', ['1.']],
  ['list-then-blank', ['- item', '']],
  ['list-nested', ['- - deep item']],
  ['list-heading', ['- # listed heading']],
  ['linkref', ['[ref]: /url']],
  ['linkref-title', ['[ref]: /url "t"']],
  // ROUND 10 — a definition's label, destination and title may EACH sit on their
  // own line, and the reference resolves the whole thing out of the paragraph at
  // a setext underline. A one-line notion of a definition made `===` a heading
  // here, closed the paragraph, let condition 7 fire, and LOST the fold below.
  ['linkref-multiline-dest', ['[ref]:', '/url']],
  ['linkref-multiline-dest-setext', ['[ref]:', '/url', '===']],
  ['linkref-multiline-title', ['[ref]: /url', '"t"']],
  ['linkref-multiline-title-setext', ['[ref]: /url', '"t"', '===']],
  ['linkref-all-three-lines', ['[ref]:', '/url', '"t"', '===']],
  ['linkref-multiline-label', ['[a', 'b]: /url', '===']],
  ['linkref-title-over-two-lines', ['[ref]: /url "a', 'b"', '===']],
  ['linkref-title-not-at-line-end', ['[ref]: /url', '"t" x', '===']],
  ['linkref-dest-then-text', ['[ref]:', '/url', 'text', '===']],
  ['linkref-incomplete-setext', ['[ref]:', '===']],
  ['linkref-blank-breaks-it', ['[ref]:', '', '/url', '===']],
  ['linkref-tab-before-dest', ['[ref]:\t/url', '===']],
  ['linkref-two-multiline', ['[a]:', '/u1', '[b]:', '/u2', '===']],
  ['linkref-multiline-dash', ['[ref]:', '/url', '---']],
  ['linkref-multiline-in-quote', ['> [ref]:', '> /url', '> ===']],
  ['linkref-multiline-lazy-in-quote', ['> [ref]:', '/url', '> ===']],
  ['linkref-multiline-in-list', ['- [ref]:', '  /url', '  ===']],
  ['linkref-indented-dest', ['[ref]:', '      /url', '===']],
  ['linkref-angle-dest-multiline', ['[ref]:', '<a b>', '===']],
  ['linkref-empty-label', ['[ ]:', '/url', '===']],
  ['linkref-then-prose-setext', ['[ref]:', '/url', 'more', '===']],
  ['table-row', ['| a | b |', '| - | - |']],
  ['trailing-spaces-prose', ['Prose with trailing spaces.   ']],
  ['hardbreak-prose', ['Prose with a hard break.\\']],
  ['prose-then-quote', ['Prose.', '> quoted']],
  ['prose-then-list', ['Prose.', '- item']],
  ['prose-then-icode', ['Prose.', '    code']],
  ['prose-then-fence', ['Prose.', '```', 'x', '```']],
  ['prose-then-html-t6', ['Prose.', '<div>', 'x', '</div>', '']],
  ['heading-then-prose', ['# h', 'Prose.']],
  ['heading-then-blank', ['# h', '']],
  ['tbreak-then-prose', ['***', 'Prose.']],

  /* ── CONTAINER CONTEXTS (round 8) ────────────────────────────────────────
   * Round 7 fixed the paragraph rule for the contexts above and recorded that its
   * container handling was "one level deep". That documented limitation was the
   * next verdict:
   *
   *     -     code
   *     <my-widget>
   *     ````orchard-notes
   *     ADVERSARIAL-MUST-BE-VISIBLE
   *     ````
   *     </my-widget>
   *
   * A list marker plus FIVE spaces makes the item's content INDENTED CODE, so no
   * paragraph is open, so the tag is a condition-7 HTML block and the fence under
   * it is an EXAMPLE. The prefix regex ate the spaces, saw a paragraph, and the
   * example became a real CLOSED fold with an empty report. So the CONTAINER STACK
   * is a dimension here too: markers at depth 1-3, every content indentation
   * across the 4-column threshold, continuation by indentation, lazy continuation,
   * blank lines inside a container, mixed containers, and each leaf kind inside
   * one. (The companion leg in scripts/verify-feat-091-response-blocks.mjs crosses
   * these with an indent/marker PREFIX on the tag and fence lines as well.) */
  ['li-icode-5sp', ['-     code']],   // THE ROUND-8 DEFECT
  ['li-icode-6sp', ['-      code']],
  ['li-icode-ordered', ['1.     code']],
  ['li-icode-star', ['*     code']],
  ['li-icode-nested', ['- -     code']],
  ['li-icode-in-quote', ['> -     code']],
  ['li-content-2sp', ['-  item text']],
  ['li-content-4sp', ['-    item text']],
  ['li-content-tab', ['-\titem text']],
  ['li-cont-indented', ['- item', '  more text']],
  ['li-cont-icode', ['- item', '      code']],
  ['li-cont-lazy', ['- item', 'lazy text']],
  ['li-blank-then-cont', ['- item', '', '  more text']],
  ['li-nested-2', ['- - deep item']],
  ['li-nested-3', ['- - - deepest item']],
  ['li-indent3-marker', ['   - item text']],
  ['li-setext-inside', ['- Title', '  ===']],
  ['li-heading-inside', ['- item', '  # h']],
  ['li-tbreak-inside', ['- item', '  ***']],
  ['li-fence-inside', ['- item', '  ```', '  x', '  ```']],
  ['li-html-inside', ['- <div>', '  x', '']],
  ['li-ordered-9digit', ['123456789. item']],
  ['li-ordered-not-1-after-prose', ['Prose.', '2. item']],
  ['li-empty-after-prose', ['Prose.', '-']],
  ['quote-icode', ['>     code']],
  ['quote-icode-nested', ['> >     code']],
  ['quote-depth-3', ['> > > deepest quote']],
  ['quote-blank-marker', ['> quoted', '>']],
  ['quote-setext-inside', ['> Title', '> ===']],
  ['quote-fence-inside', ['> ```', '> x', '> ```']],
  ['quote-lazy-cont', ['> quoted', 'lazy text']],
  ['quote-in-list', ['- > listed quote']],
  ['list-in-quote', ['> - quoted item']],
  ['mixed-deep', ['> - > - deep mix']],
];

/**
 * Tag lines placed directly above the notes fence: every condition-7 shape (the
 * clause round 7 got wrong), the other HTML-block conditions as controls, and
 * ORDINARY PROSE THAT MERELY RESEMBLES HTML (round 6's stratum), which must NOT
 * inert the fence under it.
 */
const TAGS = [
  ['t7-open-custom', '<my-widget>'],
  ['t7-close-custom', '</my-widget>'],
  ['t7-open-span', '<span>'],
  ['t7-attr', '<a href="x">'],
  ['t7-attr-single', "<x-y a='1'>"],
  ['t7-attr-bare', '<x-y a=1>'],
  ['t7-selfclose', '<img src="a" />'],
  ['t7-close-span', '</span>'],
  ['t6-div', '<div>'],
  ['t6-close-div', '</div>'],
  ['t6-table', '<table>'],
  ['t1-pre', '<pre>'],
  ['t2-comment', '<!--'],
  ['t3-pi', '<?php'],
  ['t4-decl', '<!ENTITY foo'],
  ['t5-cdata', '<![CDATA['],
  ['prose-bare-lt', '<b'],
  ['prose-generic', 'Array<string>'],
  ['prose-lte', '<= 5 items'],
  ['prose-autolink', '<https://example.com/docs>'],
  ['prose-inline-tail', '<b>bold</b> inline'],
  ['prose-open-tail', '<my-widget>tail'],
  /* ROUND 8's SECOND DEFECT, found by this differential: condition 7 rejected the
   * four type-1 tag NAMES in either form. The conditions are tried in order, so
   * `<pre>` is condition 1 and never reaches 7 — what the reject really removed
   * were COMPLETE CLOSING TAGS and `<pre/>`, all of which the reference makes
   * condition-7 HTML blocks. Kept as permanent rows so the reject cannot return. */
  ['t7-close-pre', '</pre>'],
  ['t7-close-script', '</script>'],
  ['t7-close-style', '</style>'],
  ['t7-close-textarea', '</textarea>'],
  ['t7-selfclose-pre', '<pre/>'],
  ['t1-pre-attr', '<pre a="1">'],
  /* ...and the condition-6 tag list is ONE revision (0.31.2), not a 0.30 union:
   * `<source>` was dropped from it and `<search>` added. The union made `<source>`
   * inert under a paragraph where the reference keeps it live. */
  ['t6-search', '<search>'],
  ['t7-source', '<source>'],
  ['t7-source-attr', '<source src="a">'],
];

/** Load `commonmark`, or null if the devDependency is absent (clean rooms). */
async function loadCommonmark() {
  try {
    const m = await import('commonmark');
    const cm = (m && typeof m.Parser === 'function') ? m : (m.default ?? m);
    return (cm && typeof cm.Parser === 'function') ? cm : null;
  } catch { return null; }
}

/**
 * Run the full differential with a given `parseResponseBlocks`. Returns counts and
 * up-to-8 examples per direction. `reader` is a CommonMark Parser (source positions
 * are on by default, which the oracle needs).
 */
function runDifferential(reader, parse) {
  const referenceCoversFence = (input, fenceLine1) => {
    const ast = reader.parse(input);
    for (let w = ast.walker(), ev; (ev = w.next());) {
      if (!ev.entering || ev.node.type !== 'html_block') continue;
      const [[s], [t]] = ev.node.sourcepos;
      if (s <= fenceLine1 && fenceLine1 <= t) return true;
    }
    return false;
  };
  let n = 0, agreeLive = 0, agreeLiteral = 0;
  const hiding = [], over = [];
  for (const [ctxId, ctx] of CONTEXTS) {
    for (const [tagId, tag] of TAGS) {
      const input = [...ctx, tag, FENCE, TOKEN, '````', 'TAIL'].join('\n');
      const fenceLine1 = ctx.length + 2; // 1-based line of the orchard-notes fence
      const refInert = referenceCoversFence(input, fenceLine1);
      let folded;
      try {
        const parsed = parse(input);
        folded = parsed.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN));
        n++;
        if (refInert && folded) { hiding.push({ where: `${ctxId} + ${tagId}`, malformed: parsed.malformed }); }
        else if (!refInert && !folded) { over.push({ where: `${ctxId} + ${tagId}`, malformed: parsed.malformed }); }
        else if (folded) agreeLive++;
        else agreeLiteral++;
      } catch (e) {
        n++; over.push({ where: `${ctxId} + ${tagId}`, threw: e.message });
      }
    }
  }
  return { n, agreeLive, agreeLiteral, hiding, over };
}

async function main() {
  console.log('[1] differential vs the CommonMark 0.31.2 reference implementation');
  const commonmark = await loadCommonmark();
  if (!commonmark) {
    skip('CommonMark reference differential (the whole suite)',
      'the `commonmark` devDependency is absent (clean-room export strips node_modules and has no network); it is a devDependency, never required at runtime or by a session — do NOT install it to un-skip, that writes into the live tree');
    return report();
  }

  const reader = new commonmark.Parser();
  const { parseResponseBlocks } = await import(PARSER);
  const cur = runDifferential(reader, parseResponseBlocks);
  console.log(`      ${cur.n} documents (${CONTEXTS.length} contexts x ${TAGS.length} tag lines); `
    + `${cur.agreeLive} agree LIVE, ${cur.agreeLiteral} agree LITERAL`);
  if (cur.hiding.length) console.log('      HIDING e.g.: ' + cur.hiding.slice(0, 6).map((d) => d.where).join(' | '));
  if (cur.over.length) console.log('      OVER-RECOGNITION e.g.: ' + cur.over.slice(0, 6).map((d) => d.where).join(' | '));

  check('the differential space is WIDE (>1500 generated documents, not a replay)', cur.n > 1500, cur.n);
  check('BOTH directions are exercised (>100 agree-live AND >100 agree-literal, so the oracle is not trivially one-sided)',
    cur.agreeLive > 100 && cur.agreeLiteral > 100, { agreeLive: cur.agreeLive, agreeLiteral: cur.agreeLiteral });
  // The two headline invariants, one per direction.
  check('ZERO HIDING disagreements — no reference-literal region is folded into orchard-notes (the round-5/round-7 shape)',
    cur.hiding.length === 0, { n: cur.hiding.length, first: cur.hiding.slice(0, 6) });
  check('ZERO OVER-RECOGNITION disagreements — no reference-live fence is called literal (the round-6 false-flag shape)',
    cur.over.length === 0, { n: cur.over.length, first: cur.over.slice(0, 6) });

  // Direct sanity pins so "0 disagreements" cannot be met by an oracle or parser
  // that had quietly stopped recognising fences (or html blocks) at all.
  {
    const heading = ['# h', '<my-widget>', FENCE, TOKEN, '````', 'TAIL'].join('\n'); // round-7's exact defect shape
    const p = parseResponseBlocks(heading);
    check('sanity: an ATX heading above a complete custom tag leaves the fence LITERAL to both (round-7 defect shape)',
      !p.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN)), { blocks: p.blocks.map((b) => b.name) });
    const bare = ['<b', FENCE, TOKEN, '````', 'TAIL'].join('\n'); // round-6's exact defect shape
    const q = parseResponseBlocks(bare);
    check('sanity: a bare `<b` (not a block start) keeps the fence LIVE to both (round-6 defect shape)',
      q.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN)), { malformed: q.malformed });
    const icode = ['-     code', '<my-widget>', FENCE, TOKEN, '````', 'TAIL'].join('\n'); // round-8's exact defect shape
    const r = parseResponseBlocks(icode);
    check('sanity: a list item whose content is INDENTED CODE leaves the fence LITERAL to both (round-8 defect shape)',
      !r.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN)), { blocks: r.blocks.map((b) => b.name) });
    const para = ['- code', '<my-widget>', FENCE, TOKEN, '````', 'TAIL'].join('\n'); // ...and its control
    const s = parseResponseBlocks(para);
    check('sanity: ...while a list item whose content is a PARAGRAPH keeps it LIVE to both (round-8 control)',
      s.blocks.some((b) => b.name === 'orchard-notes' && b.content.includes(TOKEN)), { malformed: s.malformed });
  }

  /* ── non-vacuity calibration ──────────────────────────────────────────────
   * A differential that agrees with everything proves nothing. The SAME space,
   * run against the immediately-prior parser generation (round-6, before condition
   * 7 knew the paragraph rule), must report many REAL disagreements. Guarded on git
   * + the sha, so a git-less or shallow clone SKIPs (counted) rather than fails —
   * the current-parser assertions above still ran. */
  console.log('\n[2] non-vacuity calibration against the prior parser generation');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feat091-cmdiff-'));
  try {
    const g = spawnSync('git', ['-C', ROOT, 'show', `${CALIBRATION_SHA}:public/lib/response-blocks.js`], { encoding: 'utf8', maxBuffer: 1e8 });
    if (g.status !== 0 || !g.stdout) {
      skip('calibration vs the round-6 parser generation',
        `git or commit ${CALIBRATION_SHA} unavailable in this tree (shallow/exported clone) — the current-parser differential above still ran`);
    } else {
      const tmp = path.join(scratch, `rb-${CALIBRATION_SHA}.mjs`);
      fs.writeFileSync(tmp, g.stdout);
      let oldParse = null;
      try { oldParse = (await import(tmp)).parseResponseBlocks; } catch { /* export shape drift */ }
      if (typeof oldParse !== 'function') {
        skip('calibration vs the round-6 parser generation', `commit ${CALIBRATION_SHA} does not export a usable parseResponseBlocks`);
      } else {
        const old = runDifferential(reader, oldParse);
        const disagreements = old.hiding.length + old.over.length;
        console.log(`      prior generation (${CALIBRATION_SHA}): ${disagreements} disagreements `
          + `(${old.hiding.length} hiding, ${old.over.length} over-recognition) over the same ${old.n} documents`);
        check(`the differential is NON-VACUOUS: the PRIOR generation reports MANY disagreements the current one does not (${CALIBRATION_SHA})`,
          disagreements >= 100, disagreements);
        check('...and they are HIDING disagreements (the class of every round on this grammar), proving the oracle catches the direction that hides content',
          old.hiding.length >= 100, old.hiding.length);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  /* ── [3] the randomised differential (see the block comment above) ─────── */
  console.log('\n[3] RANDOMISED differential — fresh combinations every run');
  console.log(`      seed=${FUZZ_SEED} (replay with FEAT091_FUZZ_SEED=${FUZZ_SEED})`);
  const fz = runFuzz(reader, parseResponseBlocks, FUZZ_SEED, FUZZ_N);
  console.log(`      ${fz.n} random documents in ${fz.ms}ms; ${fz.live} agree LIVE, ${fz.literal} agree LITERAL`);
  const show = (d) => JSON.stringify(d.input);
  if (fz.hiding.length) console.log('      HIDING e.g.:\n        ' + fz.hiding.slice(0, 3).map(show).join('\n        '));
  if (fz.over.length) console.log('      OVER e.g.:\n        ' + fz.over.slice(0, 3).map(show).join('\n        '));
  if (fz.lost.length) console.log('      LOST e.g.:\n        ' + fz.lost.slice(0, 3).map(show).join('\n        '));
  check('the randomised space is WIDE and freshly generated (>=20000 documents this run)', fz.n >= 20000, fz.n);
  check('BOTH directions are exercised by the RANDOM space (>500 each, so the generator is not producing one shape)',
    fz.live > 500 && fz.literal > 500, { live: fz.live, literal: fz.literal });
  check('ZERO HIDING disagreements over the random space — no reference-literal region is folded into orchard-notes',
    fz.hiding.length === 0, { n: fz.hiding.length, first: fz.hiding.slice(0, 3).map(show) });
  check('ZERO OVER-RECOGNITION disagreements over the random space — no reference-live fence is called literal',
    fz.over.length === 0, { n: fz.over.length, first: fz.over.slice(0, 3).map(show) });
  check('CONTENT IS NEVER LOST: in every random document the token is folded-with-agreement or VISIBLE',
    fz.lost.length === 0, { n: fz.lost.length, first: fz.lost.slice(0, 3).map(show) });

  /* Non-vacuity for the RANDOM space, against the generation this round replaced.
   * A fuzz that agrees with everything proves nothing, and unlike the enumerated
   * space this one changes every run, so the calibration is what shows the space
   * still contains the defect class at all. */
  {
    const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat091-fuzzcal-'));
    try {
      console.log('      CALIBRATION TABLE — every prior generation, same '
        + `${FUZZ_N} documents, same seed:`);
      for (const row of FUZZ_CALIBRATION) {
        const what = `randomised calibration vs the ${row.label} parser generation (${row.sha})`;
        const g = spawnSync('git', ['-C', ROOT, 'show', `${row.sha}:public/lib/response-blocks.js`], { encoding: 'utf8', maxBuffer: 1e8 });
        if (g.status !== 0 || !g.stdout) {
          skip(what, `git or commit ${row.sha} unavailable in this tree (shallow/exported clone) — the random differential above still ran`);
          continue;
        }
        const tmp = path.join(scratch2, `rb-${row.sha}.mjs`);
        fs.writeFileSync(tmp, g.stdout);
        let oldParse = null;
        try { oldParse = (await import(tmp)).parseResponseBlocks; } catch { /* export shape drift */ }
        if (typeof oldParse !== 'function') {
          skip(what, `commit ${row.sha} does not export a usable parseResponseBlocks`);
          continue;
        }
        const old = runFuzz(reader, oldParse, FUZZ_SEED, FUZZ_N);
        const bad = old.hiding.length + old.over.length + old.lost.length;
        console.log(`        ${row.label} (${row.sha}): ${bad} disagreements `
          + `— ${old.hiding.length} hiding, ${old.over.length} over-recognition, ${old.lost.length} lost`);
        check(`NON-VACUOUS vs ${row.label} (${row.sha}): it disagrees many times where this generation does not`,
          bad >= row.minBad, bad);
        const got = row.cls === 'hiding' ? old.hiding.length : old.over.length;
        check(`...and in ${row.label}'s OWN defect direction (${row.cls}), so the space contains that class and not just noise`,
          got >= row.minCls, got);
      }
    } finally {
      fs.rmSync(scratch2, { recursive: true, force: true });
    }
  }

  report();
}

function report() {
  console.log(`\nTOTAL: ${pass} passed, ${fail} failed, ${skipped.length} skipped`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  if (skipped.length) console.log('skipped (environment, not defects):\n  - ' + skipped.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
