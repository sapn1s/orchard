/**
 * FEAT-091 — the response-format BLOCK GRAMMAR. Pure, no I/O, no node imports.
 *
 * Layer 1 of the response format is `orchard-digest` (JSON, structured, already
 * shipped in FEAT-083/084 and parsed by public/lib/digest.js). Layer 2 — this
 * module — is PROSE-shaped named fences that declare what each part of a reply
 * IS. The vocabulary is SEMANTIC (round 12): presentation is derived from the
 * category, never chosen per passage.
 *
 *     orchard-finding       what is true               COLLAPSED (with a preview)
 *     orchard-outcome       what I changed             visible
 *     orchard-ask           a decision that is YOURS    visible
 *     orchard-judgment      a call that was MINE        visible
 *     orchard-status        where the work stands      visible
 *     orchard-narration     the play-by-play           COLLAPSED
 *     orchard-uncategorized fits none of the above     visible, and MEASURED
 *
 * Two LEGACY names stay known forever so archived transcripts keep rendering
 * exactly as they did: `orchard-answer` (visible) and `orchard-notes`
 * (collapsed). They are not injected into new sessions.
 *
 * Everything else is FALLBACK: it still renders as ordinary prose (content is
 * never lost) and it is COUNTED AND CHARACTERISED. The fallback is now TWO
 * different signals, and the metrics keep them apart: `orchard-uncategorized` is
 * the author saying "no category fits" (a VOCABULARY gap — read its label and add
 * the missing name), while prose left outside every block is the author not
 * categorising at all (a COMPLIANCE gap). See docs/prompts/RESPONSE_FORMAT.md.
 *
 * ── AN INFO STRING MAY CARRY A LABEL
 * The block name is the FIRST token of the info string; anything after it is a
 * free-text label, preserved with its case. Only `orchard-uncategorized` requires
 * one, and it is the whole learning loop: the label is what turns "3% landed in
 * the fallback" into "what keeps landing there is X", which is what names the
 * next category. The rule is uniform — one grammar, no per-name special case —
 * so a label on any block is legal and inert.
 *
 * ── WHY THIS FILE HAS NO IMPORTS
 * It is written as browser-compatible ESM so the renderer half can use the SAME
 * grammar rather than reimplementing it (the failure mode of a second
 * implementation is the hook and the UI disagreeing about what a message
 * contains). The renderer lane may move this file to public/lib/response-blocks.js
 * and have the Stop hook import it from there — exactly the arrangement
 * public/lib/digest.js already has with the hook. Keep it dependency-free.
 *
 * ── FENCE GRAMMAR (a strict subset of CommonMark, so any markdown renderer that
 *    does not know these names still shows the content):
 *   - An opening fence is a run of >= 3 of a FENCE CHARACTER — a backtick OR a
 *     TILDE, CommonMark has two and they are equal citizens — indented 0-3
 *     spaces, followed by an info string. `orchard-answer` / `orchard-notes` /
 *     `orchard-digest` (case-insensitive, trimmed) are the KNOWN names.
 *   - A fence closes only on a run of the SAME character, AT LEAST AS LONG,
 *     indented 0-3 spaces, with nothing else on the line. This is what lets an
 *     answer block opened with 4 backticks contain ordinary ```code``` — the
 *     prose blocks routinely carry code, so 4 backticks is the recommended
 *     opener. A tilde run never closes a backtick fence, or vice versa.
 *   - Blocks DO NOT NEST. A fence appearing inside any already-open fence — a
 *     known block or a plain code block — is literal content, never an opener.
 *     That is why this is a linear scanner and not a set of regexes: it is the
 *     only way `\`\`\`\`markdown ... \`\`\`orchard-answer ... \`\`\`\`` stays inert.
 *   - An UNTERMINATED known fence degrades to fallback: the opener line and
 *     everything after it is treated as uncategorized prose and flagged
 *     malformed. Never an error, never dropped content.
 *   - ONE exception to "blocks do not nest", and it is not a special case for a
 *     particular shape — it is the INVARIANT that makes hidden content
 *     unrepresentable. See "THE FOLD IS THE ONLY GATE" below.
 *   - An UNKNOWN `orchard-*` name is reserved-namespace forward compatibility: its
 *     CONTENT is fallback (so an older renderer meeting a block named by a newer
 *     spec still shows the text) and its name is recorded separately, so we can
 *     see a name being used ahead of its specification.
 *
 * ── THE FOLD IS THE ONLY GATE  (FEAT-091, after two hidden-content defects)
 * The spec rule "degradation may only move content TOWARD visible" was, twice,
 * a property of particular branches rather than of the parse. Both defects had
 * the same shape: the scanner reasoned about NESTING DEPTH inside a collapsed
 * body, got the depth wrong, and an authored `orchard-answer` ended up inside a
 * CLOSED fold — absent from the rendered text and from the accessibility tree,
 * with an empty `malformed` list and an empty fallback list, so both consumers
 * agreed and both were wrong. Fixing the demonstrated shape each time is how you
 * get a third variant.
 *
 * The invariant is enforced structurally instead. Observe that a collapsed
 * (`orchard-notes`) block is the ONLY construct in this grammar that can make
 * content invisible — every other outcome (a block, a fallback run, an unknown
 * name, an unterminated fence, a plain code fence) renders expanded. So there is
 * exactly ONE gate, and the gate carries a CERTAINTY GUARD:
 *
 *     A collapsed block's body is admitted as folded content only if it is
 *     CERTAIN. It is certain iff
 *       (C1) no line in the body is a reserved (`orchard-*`) opening fence, and
 *       (C2) every inner fence in the body PAIRS — i.e. the body's fence
 *            structure is closed, so no inner fence is left dangling and could
 *            have been meant as this fold's close.
 *     Otherwise the fold ENDS at the offending line; the offending line and
 *     everything after it is re-scanned at top level (landing visible, or as its
 *     own block), and the uncertainty is REPORTED as `ambiguous-fold:`. The
 *     retained prefix is re-checked until it is certain, so the guard cannot be
 *     satisfied by a cut that merely moves the problem.
 *
 * Neither condition tracks nesting depth. C1 is a per-line predicate over EVERY
 * body line, inside inner fences or not. C2 is CommonMark's own pairing rule —
 * fences DO NOT NEST, so "is this fence closed" is a TWO-STATE automaton
 * (outside / inside-exactly-one-fence), never a depth counter. There is still no
 * "skip to the close of the inner fence at depth N" scan anywhere in this module;
 * the class of defect was a depth-tracking mistake and there is no depth to get
 * wrong. What this makes UNREPRESENTABLE (not merely handled): any shape in which
 * an `orchard-*` opener, at any nesting depth, in any order, at any fence length,
 * ends up inside a collapsed fold; and any shape in which the fold's own close is
 * in doubt because an inner fence is left open.
 *
 * C2 WAS a parity tally ("every run length occurs an even number of times"), and
 * that heuristic was WRONG on legal input: CommonMark lets a closing fence be
 * LONGER than its opener, so ```` ```js … ```` ```` is one properly paired code
 * block, but the tally saw a 3-run and a 4-run and called both unpaired. A false
 * `ambiguous-fold:` on well-formed input is not "the safe direction" in any useful
 * sense — it trains the reader to ignore the flag. The rule below is the real one:
 * a fence closes on a run of the SAME character that is AT LEAST AS LONG.
 *
 * The cost, stated plainly: a documented `orchard-*` fence example written INSIDE
 * a notes block no longer stays inside the fold — it is promoted to visible and
 * flagged. That is the correct direction (visible-and-reported), and there is a
 * depth-free escape hatch: indent the example by 4+ spaces, which is not a fence
 * opener in CommonMark at all, or put it in an `orchard-answer` block.
 *
 * IRREDUCIBLE AMBIGUITY, named: a bare ```` ``` ```` run inside a 4-backtick fold
 * is, character for character, both the RECOMMENDED code-fence usage and a
 * mistyped close. Nothing in the text separates them, and any rule that tried
 * would be depth reasoning again. C2 resolves it the only safe way: if such a run
 * PAIRS it is content (the recommended pattern keeps working); if it is UNPAIRED
 * the fold ends there — visible and reported — because an unpaired run is exactly
 * what a mistyped close looks like.
 *
 * ── LINE ENDINGS ARE NORMALISED ONCE, AT THE BOUNDARY
 * Every rule above is a per-LINE rule, so "what is a line" must be settled before
 * any of them run — otherwise a predicate can be structurally blind to a break.
 * It was: with only `\n` splitting, a reserved opener separated by a LONE CR sat
 * in the middle of what this module called one line, C1 could not see it, and an
 * authored `orchard-answer` was folded away silently. That is the same hiding
 * class as the nesting defects, reached by line-splitting instead.
 *
 * So `parseResponseBlocks` normalises `\r\n` and lone `\r` to `\n` FIRST, and
 * every downstream rule inherits it rather than each having to remember. Those
 * three are exactly CommonMark's line endings, and exactly what marked (the
 * renderer) normalises, so the parser and the render agree on where lines are by
 * construction. Nothing else is a line ending for either side — U+2028/U+2029 and
 * form feed are ordinary characters to both — so neither can carry a fence past a
 * predicate. (Reported positions and `totalChars` are therefore in normalised
 * coordinates: line numbers are only meaningful against normalised lines.)
 *
 * ── WHAT MAKES A REGION INERT, ENUMERATED  (round 4)
 * Every round of this grammar has been the same shape of defect: a construct the
 * author used to make a region INERT (literal text, not live markup) was not
 * modelled, so an example was parsed as a real block — and when that block was
 * `orchard-notes`, its content rendered inside a CLOSED fold. Round 4's instance:
 *
 *     ~~~markdown
 *     ````orchard-notes
 *     MUST-BE-READER-VISIBLE
 *     ````
 *     ~~~
 *
 * A CommonMark TILDE fence. Entirely unmodelled — the regexes said backtick — so
 * the outer fence was invisible and the inner one became a genuine fold. Present
 * in the DOM, absent from the rendered text AND from the accessibility tree, with
 * an empty `malformed` list: hidden content, silently mis-counted. Same class as
 * rounds 1-3, reached through a third syntax.
 *
 * So the inert-region constructs are enumerated here rather than discovered one
 * per round. CommonMark has exactly three ways to make a region literal:
 *
 *   1. FENCED CODE — BOTH fence characters, ``` and ~~~. Modelled, symmetrically:
 *      one `openerOf` / `isClosingFence` pair parameterised by character, so the
 *      opener-length, closer-length, info-string and 0-3-indent rules cannot be
 *      fixed for one character and forgotten for the other (which is exactly what
 *      happened). The one asymmetry is CommonMark's own: a BACKTICK fence's info
 *      string may not contain a backtick (`` ```a`b `` is not a fence), while a
 *      TILDE fence's info string may contain anything, backticks included.
 *   2. INDENTED CODE — 4+ columns of indent. Already covered, structurally and
 *      not by accident: an opening fence is only recognised at 0-3 columns, and an
 *      indented code block by definition contains no line at 0-3 columns (any such
 *      line ends it). So no line inside an indented code block can be an opener to
 *      this parser, and none is a fence to the renderer either. It is also the
 *      documented escape hatch for an example inside notes. Tested, not assumed —
 *      the corpus has an `icode` stratum.
 *   3. HTML BLOCKS — MODELLED, as of round 5. The previous round left them out and
 *      argued the residual was bounded by C1. The argument was true and useless:
 *      C1 bounds what can be hidden inside a fold that ALREADY EXISTS, and the
 *      defect was an HTML wrapper CREATING a fold that should not exist —
 *
 *          <div>
 *          ````orchard-notes
 *          MUST-BE-READER-VISIBLE-HTML
 *          ````
 *          </div>
 *
 *      A top-level CommonMark HTML block makes its contents literal, so that fence
 *      is an EXAMPLE. Unmodelled, it became a genuine fold: the token was in the
 *      DOM, absent from the rendered text AND from the accessibility tree, and the
 *      counter reported one clean `orchard-notes` with an EMPTY malformed list.
 *      The bound held for `orchard-answer` (the direction that does not hide) and
 *      failed for `orchard-notes` (the direction that does). Hence the rule this
 *      module now works under: A CONSTRUCT THAT CAN MAKE A REGION LITERAL IS A
 *      HIDING VECTOR UNTIL A TEST SAYS OTHERWISE. "The residual is bounded" is not
 *      a shipping argument; it is the prompt to write the test.
 *
 *      HOW IT IS MODELLED, and why it is not the paragraph-state monster the last
 *      round feared. The goal is NOT a faithful HTML-block parser; it is a rule
 *      that is SUFFICIENT for the invariant. Two halves:
 *
 *        START — CommonMark's SEVEN start conditions, transcribed one entry each
 *        into `HTML_STARTS`. Round 5 instead used ONE loose predicate (0-3 indent,
 *        `<`, then `! ? / letter`) and argued the resulting over-recognition was
 *        free, because an inert line still renders visible. Round 6 found the hole:
 *        a bare `<b` on its own line satisfies NO start condition — it is ordinary
 *        prose — yet the loose predicate inerted it and swallowed a correctly
 *        authored `orchard-notes` block under it. Well-formed input got a false
 *        `inert-html:` flag, `blocks` came back EMPTY, and the block's content was
 *        counted as uncategorised prose. So over-recognition is not free: it fires
 *        on text people write all the time (`<b`, `<div`, `Array<string>`), it
 *        teaches the reader to ignore the flag, and it corrupts the parse metrics
 *        the design rests on. The list is bounded and specified, so it is
 *        implemented, not approximated. See `HTML_STARTS` for each condition.
 *
 *        EXTENT — types 1-5 end at their own terminator (`</script>`-ish, `-->`,
 *        `?>`, `>`, `]]>`), checked from the start line itself so a one-line
 *        `<!-- x -->` is one line. Types 6 and 7 end at the first BLANK line.
 *        ONE addition makes it safe: the region NEVER ends while a fence opened
 *        inside it is still open — without that, a region could end EARLIER than
 *        the fence-only scan did and hand a still-open fence's tail back to the
 *        top level, where it could become a fold.
 *
 *        PARAGRAPH STATE — condition 7's "may not interrupt a paragraph" clause,
 *        implemented rather than approximated. Round 6 honoured the clause with a
 *        boolean set by ANY non-blank line, and wrote down that lines which are
 *        really some other leaf block still count as paragraph, calling the
 *        resulting under-recognition of condition 7 THE SAFE SIDE. Round 7
 *        falsified that on its own terms:
 *
 *            # Completed heading
 *            <my-widget>
 *            ````orchard-notes
 *            MUST-STAY-VISIBLE
 *            ````
 *            </my-widget>
 *
 *        The heading left the flag set, condition 7 was suppressed, the region was
 *        NOT literal, and the example inside it became a real CLOSED fold —
 *        invisible in the render and in the accessibility tree, `malformed` empty.
 *        Ten shapes, not one: every ATX level, all three thematic-break
 *        characters, setext underlines, indented code, an empty list item, an
 *        empty block quote. So the constructs that open and close a paragraph are
 *        ENUMERATED (see `paragraphStateAfter`), and the enumeration is
 *        differential-tested against the CommonMark reference implementation over
 *        73 preceding contexts x 22 tag lines, in BOTH directions, at zero
 *        disagreements. The same 1,606 documents score round 6 at 240.
 *
 *      DIRECTION OF ERROR, restated a third time and this time with the symmetry
 *      broken. Round 5 called it monotone inertness ("the inert set only grows");
 *      round 6 shrank the set deliberately and restated it as "where the spec is
 *      ambiguous, err toward NOT inert, because a missed inert region is bounded".
 *      Round 7's defect was a missed inert region, and it hid authored content.
 *      Both directions cost: a FALSE inert region corrupts the parse and flags
 *      legal prose (round 5's 146 false flags), a MISSED one folds authored text
 *      away (round 6's 150 hidden tokens). There is therefore NO safe side to lean
 *      on, and "the residual errs the safe way" is not available as a shipping
 *      argument for this construct — where the spec is decidable, decide it. It is
 *      decidable here: CommonMark's start conditions and paragraph rules are a
 *      finite list, and a reference implementation exists to check against.
 *      When a region IS inert and swallows a reserved opener it is still REPORTED
 *      as `inert-html:`, so that case is never silent.
 *
 *      This is top-level only, and deliberately: the fold guard (C1/C2) stays
 *      construct-blind. Teaching it about HTML could only WEAKEN it — C1 must keep
 *      firing on a reserved opener inside a fold at any depth, in any wrapper.
 *   4. CONTAINER CONTEXTS — blockquotes and list items. Not inert constructs, but
 *      the place a fence's EXTENT is easiest to get wrong, so they are pinned
 *      rather than assumed. Recognition is in CONTAINER CONTEXT (round 9): once a
 *      line's matched container prefix — a `>` or a list marker — is consumed, a
 *      fence at 0-3 columns of the REMAINING indent IS an opener, to us and to
 *      CommonMark, so a `>`-prefixed or list-nested `orchard-notes` fence really
 *      folds. What is NOT recognised is a construct at 4+ columns RELATIVE TO ITS
 *      CONTAINER: that is indented code, inert on both sides, and cannot hide. (An
 *      earlier reading here — that a `>`-prefixed line is "not an opener at all"
 *      and that raw-column under-recognition "cannot hide anything" — was retired
 *      by round 9 as false; see round 9 note 4 below. The renderer uses this parser
 *      and not a second one, so the verdict is the same on both sides.) The corpus
 *      has `bq` and `list` strata enumerating quote depths, markers and indents.
 *   5. INLINE CONSTRUCTS ARE NOT LITERALISERS, and this is a proof, not an
 *      omission: CommonMark settles BLOCK structure before any inline parsing, so a
 *      code span, a raw inline tag, or a link-reference-definition title can never
 *      contain a fenced code block — the fence wins, in every conforming renderer.
 *      A multi-line `` `` `` span "around" a notes fence therefore yields a real
 *      fold, and that is correct rather than tolerated. The corpus `inline` stratum
 *      asserts the fence wins, so the claim is tested and not merely reasoned.
 *      (A backslash-escaped run — `\`\`\`orchard-notes` — is not a fence to either
 *      side, and is pinned too.)
 *
 * Adding a further FENCE construct means changing `openerOf`/`isClosingFence` only
 * — the whole module has ONE fence primitive. Adding a further INERT construct
 * means one start predicate and one extent rule next to the HTML pair below.
 *
 * ── ROUND 9: WHAT A RANDOMISED DIFFERENTIAL FOUND THAT A MATRIX COULD NOT
 * Round 8 was found by an enumerated differential — 107 contexts x 31 tag lines,
 * a matrix of shapes someone thought to write down. Round 9's verdict came from
 * generating RANDOM container-and-tag combinations against the reference instead,
 * and the round-8 lane had actually RUN such a fuzz (30,000 documents, in scratch)
 * and not committed it. That gap is the whole story of this round, so the fuzz is
 * now a standing check that generates fresh documents on every run, with a printed
 * seed for replay (scripts/verify-feat-091-commonmark-diff.mjs, leg [3]).
 *
 * It found FIVE distinct causes, not one shape. Every one is the same class —
 * authored content inside a CLOSED fold, `malformed` empty — and every one is a
 * place where a rule was written in terms of a FIXED WIDTH or a RAW COLUMN rather
 * than derived from the line's actual container context:
 *
 *   1. LAZY CONTINUATION AND THE SETEXT CLAUSE. "A setext heading underline
 *      cannot be a lazy continuation line" was read as "such a line is not lazy
 *      continuation at all", so `===` under a list item's paragraph CLOSED the
 *      paragraph. The reference's setext start requires the deepest MATCHED
 *      container to be the paragraph, so on a lazy line it simply never fires and
 *      the line is ordinary continuation TEXT. See `isParagraphContinuationText`.
 *      This is the reported defect; the nine-digit ordered marker and the
 *      `data-a:b_c.d-e` attribute name in the same input were red herrings —
 *      `LIST_MARKER_RE` already derives the content column from the marker's real
 *      width, and the tag classes are already the reference's own, character for
 *      character.
 *   2. NO LEAF STATE ACROSS LINES. The classifier decided each line on its own, so
 *      the body of a fenced code block or an HTML block sitting INSIDE a container
 *      (`>```` / `> <div>`) was re-classified as prose and could leave a phantom
 *      paragraph open. See `classifyLeaf` and phase 0 of `advanceLineState`.
 *   3. "AT MOST ONE BLANK LINE" FOR AN EMPTY LIST ITEM. A blank line matched an
 *      empty item forever, so a tag written after it landed INSIDE the item and a
 *      fence at column 0 became a fold. See `matchContainers`.
 *   4. TWO DETECTIONS THAT COULD DISAGREE. The top-level scan asked `openerOf` /
 *      `htmlStartOf` of the RAW line (0-3 raw columns); the classifier asked the
 *      same questions of the line with its CONTAINER PREFIX consumed. Round 8
 *      wrote down that the resulting under-recognition "cannot hide anything — no
 *      fence recognised means no fold created". FALSE, and this is the round's
 *      most important correction: under-recognising the LITERALISER while still
 *      recognising the FENCE hides content. There is now ONE detection, in
 *      container context — see `restOfLine` and `para.opener` in the scan.
 *   5. UNBOUNDED EXTENTS. A fence could take its CLOSE, and an HTML region its
 *      end, from a line OUTSIDE the container the construct was opened in. Both
 *      are bounded now — see `containerBoundOf`.
 *
 * Two prior rules were RETIRED as false-inertness, each with the reference as the
 * arbiter and the differentials as the proof: the round-5 rule that an HTML region
 * never ends while a fence opened inside it is still open (the reference ends a
 * type-6/7 block at the first blank line, unconditionally), and the round-8 note
 * that link reference definitions are safely treated as paragraph text (they are
 * not: a setext underline over a definition-only paragraph underlines nothing, so
 * the paragraph stays OPEN — see `linkReferenceDefinitionLength`).
 *
 * ROUND 10 retired a third: round 9's note that only the ONE-LINE form of a link
 * reference definition is recognised and that "not recognising a definition
 * cannot hide". True about hiding, and irrelevant — it LOSES A BLOCK instead. A
 * definition's label, destination and title may each sit on their own line, so a
 * two-line definition made `===` a heading, closed the paragraph, let condition 7
 * fire and turned a well-formed authored fold into literal prose: the fold gone,
 * its narration exposed in the accessibility tree, uncertainty reported on VALID
 * input. The standing rule below binds in BOTH directions, and the definition
 * parser is now a port of the reference's own.
 *
 * THE STANDING RULE THIS ROUND ENFORCES: a gap in the hiding direction is CLOSED,
 * or PINNED with a test proving it cannot hide. It is never written down as a
 * documented limitation — four rounds running, the documented limitation was the
 * next verdict, and round 9 was two of them at once.
 */

/* ── vocabulary ─────────────────────────────────────────────────────────────── */

/** The reserved info-string prefix. Any `orchard-*` fence is ours, known or not. */
export const BLOCK_NAMESPACE = 'orchard-';

/**
 * THE SEMANTIC VOCABULARY (round 12), derived from a labelled random sample of
 * 155 passages of real orchestrator prose — see the ticket for the distribution
 * that produced it. Three pairs, on three axes, so the set is memorable and each
 * boundary is a single question:
 *
 *   the world     finding   what is TRUE   (learned, diagnosed, corrected, explained)
 *                 outcome   what I CHANGED (shipped, committed, filed) and what you now see
 *   a decision    ask       whose call is it? YOURS
 *                 judgment                    MINE
 *   the work      status    where it stands when this turn ENDS
 *                 narration what I am doing INSIDE this turn
 *
 * `orchard-uncategorized` is the declared fallback and is first-class: it renders,
 * it is counted, and its label is read to name the category that is missing.
 */
export const CATEGORY_BLOCKS = Object.freeze([
  'orchard-finding',
  'orchard-outcome',
  'orchard-ask',
  'orchard-judgment',
  'orchard-status',
  'orchard-narration',
  'orchard-uncategorized',
]);

/**
 * The declared "nothing fits" block. Not a leak — a designed signal. Its content
 * is characterised and its label clustered, so the counts answer "what KIND of
 * thing keeps landing here", which is the only question that can name a new
 * category.
 */
export const UNCATEGORIZED_BLOCK = 'orchard-uncategorized';

/**
 * FROZEN LEGACY NAMES. The presentation-only vocabulary that shipped before the
 * semantic one. They stay known FOREVER and keep their original rendering —
 * `orchard-answer` visible, `orchard-notes` collapsed — because stored
 * transcripts are full of them and rule 3 of the extension contract forbids
 * repurposing a shipped name. They are NOT in the injected core, so no new turn
 * produces one, and the metrics count them separately from the semantic set.
 */
export const LEGACY_BLOCKS = Object.freeze(['orchard-answer', 'orchard-notes']);

/**
 * The COMPLETE known vocabulary. Adding a name here is additive and
 * backward-compatible by construction — an older renderer treats the unrecognised
 * name as fallback and still renders its content as prose.
 */
export const KNOWN_BLOCKS = Object.freeze([...CATEGORY_BLOCKS, ...LEGACY_BLOCKS, 'orchard-digest']);

/**
 * Blocks the renderer collapses by default.
 *
 * THE RULE, restated (round 13). It used to be "a category is collapsed if its
 * value EXPIRES when the turn ends", which picked exactly `narration` — a rule
 * with one member is a description, not a rule, and it did not survive contact
 * with the reader. The user's own words about findings: *"it's not really useful
 * for me to read unless I want to."* The rule that predicts the set is:
 *
 *     A category is collapsed if the reader does not have to read it to know
 *     WHERE THEY STAND.
 *
 * `digest`, `ask` and `status` are the news the reader must be handed to know
 * where they stand: the scannable headline of the turn, what needs them, and
 * where it stands. Skipping one of those means missing something that is about
 * them. `finding`, `narration`, `outcome` and `judgment` are the SUPPORTING
 * RECORD behind those: what is true about the subject matter, the play-by-play
 * of establishing it, the full retrospective of what I did, and the reasoning
 * behind a call I made. All are worth keeping and worth consulting; none is news
 * the reader must be handed — the digest already carries the headline of what
 * changed, so the long prose of `outcome` and `judgment` is detail to open on
 * demand, not signal to hand over.
 *
 * ROUND 14 — the set grew by `outcome` and `judgment`. The user asked for this
 * across seven tickets (FEAT-083/085/091/093/098/125/127): the parts of a reply
 * addressed to them kept sitting below a wall of "here is what I did and why".
 * A caveat the round-13 note already raised is now live: the STATED rule has
 * been refined more than once, and a rule fitted to its members is a description,
 * not a predictor. The honest reading is that the reader's own triage — "I do
 * not need to read this to know where I stand" — is the ground truth, and the
 * members follow it; the prose above is the best current articulation of that
 * judgement, not a law it was derived from.
 *
 * WHY THIS IS THE BIG ONE, and why the fold alone would not have been enough:
 * `finding` is 34.7% of characters in the labelled sample — the single largest
 * category, more than twice `narration`'s 3.5%. So this is where the reading load
 * actually sits, and it is also why a folded finding renders with a PREVIEW of
 * its first sentence rather than a bare label (public/lib/digest.js): a third of
 * every reply behind a caption that says only "Finding" makes the reader open
 * every one to learn whether it mattered, which is more work than reading it was.
 * `outcome` and `judgment` fold with a preview for the SAME reason: they are long
 * "here is what I did / why I did it" prose, and a bare "Changed" / "My call"
 * caption would force the same open-to-triage that defeated the fold for findings.
 * `narration` keeps its bare label — it is small, and it is the one category the
 * reader has already been told expires.
 *
 * (`orchard-notes` is the frozen legacy alias of `narration` and folds identically.)
 *
 * THIS LIST IS NOT PURELY PRESENTATION, and that is deliberate: it also drives
 * the parser's certainty guard below ("THE FOLD IS THE ONLY GATE"), so a name
 * added here gets the guard for free and the renderer cannot fold anything the
 * guard has not cleared. The consequence for `finding`, stated plainly: a finding
 * whose body contains a reserved `orchard-*` opener, or an inner fence left
 * unpaired, now ENDS THE FOLD at that line and reports `ambiguous-fold:` —
 * visible and flagged, the same direction narration has always degraded in.
 */
export const COLLAPSED_BLOCKS = Object.freeze([
  'orchard-finding', 'orchard-outcome', 'orchard-judgment', 'orchard-narration', 'orchard-notes',
]);

/** Blocks the reader must see expanded. */
export const EXPANDED_BLOCKS = Object.freeze(
  KNOWN_BLOCKS.filter((n) => !COLLAPSED_BLOCKS.includes(n)),
);

/* ── fence scanning ─────────────────────────────────────────────────────────── */

/**
 * Opening fence: 0-3 space indent, >=3 of ONE fence character, then an info
 * string. CommonMark has TWO fence characters and this module treats them as one
 * construct with a parameter, never as two code paths — modelling only backticks
 * is what let a `~~~markdown` example be parsed as live markup (see the header).
 *
 * The single asymmetry is CommonMark's, not ours: a BACKTICK fence's info string
 * may not contain a backtick, because ``a`b`` would otherwise be ambiguous with
 * inline code; a TILDE fence's info string may contain any character, backticks
 * and tildes included.
 *
 * Rejecting ALL tabs in the indent is not laziness, it is CommonMark: a tab
 * advances to the next 4-column stop, so ANY leading tab puts the fence at
 * indent >= 4 and it is not a fence at all (it is indented content — construct 2
 * in the header's enumeration). The renderer reaches the same verdict, which is
 * what matters — the two must not disagree about what a fence is.
 */
const FENCE_OPEN_RES = Object.freeze([
  ['`', /^ {0,3}(`{3,})[ \t]*([^`\n]*?)[ \t]*$/],
  ['~', /^ {0,3}(~{3,})[ \t]*([^\n]*?)[ \t]*$/],
]);

/** Closing fence per character: a bare run, 0-3 indent, nothing else on the line. */
const FENCE_CLOSE_RES = Object.freeze({
  '`': /^ {0,3}(`{3,})[ \t]*$/,
  '~': /^ {0,3}(~{3,})[ \t]*$/,
});

/**
 * INERT CONSTRUCT 3 — HTML BLOCKS (see the header). CommonMark's SEVEN start
 * conditions, transcribed, one entry each — not approximated in either direction.
 *
 * The previous round used one loose predicate (`0-3 indent, <, then ! ? / letter`)
 * on the reasoning that all seven conditions begin that way so none could be
 * forgotten, and it treated the resulting over-recognition as free because an
 * inert line still renders visible. That reasoning was right about HIDING and
 * wrong about everything else. A bare `<b` on its own line is ordinary prose —
 * no complete tag, no listed tag name, no condition satisfied — and the loose
 * predicate inerted it, swallowing a correctly-authored `orchard-notes` block
 * written under it: `blocks` empty, a false `inert-html:` flag on well-formed
 * input, the block's content mis-counted as uncategorised prose. Over-recognition
 * is NOT free: it fires on text people actually write (`<b` in a sentence about
 * HTML, `<div` in a description, `Array<string>`, `a <b`), it trains the reader to
 * ignore the flag, and it corrupts the metrics the whole design rests on.
 *
 * So the list is exact. And so is the paragraph state condition 7 depends on:
 * round 7 showed that leaning the other way is not free either — a MISSED inert
 * region turns an authored example into a CLOSED fold, which is hidden content,
 * the exact class this module exists to make unrepresentable. Neither direction
 * of error is bounded in any useful sense, so neither is approximated; both the
 * seven conditions and the paragraph rule are transcribed from the spec and
 * differential-tested against the reference implementation.
 *
 * Each entry: `re` = the start condition, `end` = the kind's own terminator or
 * null for "ends at the first blank line", `notInParagraph` = the one condition
 * (type 7) that CommonMark forbids from interrupting a paragraph.
 */
/**
 * The tag grammar, transcribed from the reference implementation's own source
 * (commonmark 0.31.2, lib/common.js) rather than paraphrased. Round 8's second
 * pair of divergences were both paraphrase drift: `[ \t]` where the spec (and the
 * reference) say `\s`, which made a form feed or a non-breaking space inside an
 * otherwise complete tag stop it being one. Every difference here is a chance for
 * the parser and the reference to disagree about whether a region is literal, and
 * a disagreement in the literal direction hides content, so the classes are
 * copied character for character.
 */
const HTML_TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const HTML_ATTR_NAME = '[A-Za-z_:][A-Za-z0-9:._-]*';
const HTML_ATTR_VALUE = '(?:[^"\'=<>`\\x00-\\x20]+|\'[^\']*\'|"[^"]*")';
const HTML_ATTR = `(?:\\s+${HTML_ATTR_NAME}(?:\\s*=\\s*${HTML_ATTR_VALUE})?)`;
/** A COMPLETE open tag or closing tag — condition 7's whole content. */
const HTML_COMPLETE_TAG =
  `(?:<${HTML_TAG_NAME}${HTML_ATTR}*\\s*/?>|</${HTML_TAG_NAME}\\s*>)`;

/**
 * Condition 6's tag list — CommonMark 0.31.2's, EXACTLY, which is the revision
 * the pinned reference implementation (and the differential that grades this
 * module) implements.
 *
 * It was the UNION of 0.30 and 0.31.2, which differ in `source` (0.30 only) and
 * `search` (0.31.2 only). The stated reason was to avoid pinning this module to
 * "whichever revision the renderer's markdown library tracks" — but there is no
 * such library: the renderer is this repo's own deliberately-minimal markdown in
 * public/lib/dom.js, which does not implement HTML blocks at all. So the union
 * bought nothing and cost a real divergence: `<source>` under a paragraph is
 * condition 7 to the reference (live, because 7 may not interrupt a paragraph)
 * and was condition 6 to this module (inert), which is round 6's over-recognition
 * class — a false `inert-html:` flag on legal prose. One revision, the pinned
 * one, and the differential is the thing that keeps it honest.
 */
const HTML_BLOCK_TAGS = [
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
].join('|');

const HTML_STARTS = Object.freeze([
  // 1: <script | <pre | <style | <textarea, then whitespace, `>`, or end of line.
  { type: 1, re: /^ {0,3}<(?:script|pre|style|textarea)(?=\s|>|$)/i,
    end: /<\/(?:script|pre|style|textarea)>/i },
  // 2: <!--
  { type: 2, re: /^ {0,3}<!--/, end: /-->/ },
  // 3: <?
  { type: 3, re: /^ {0,3}<\?/, end: /\?>/ },
  // 4: <! followed by an ASCII letter (declarations, e.g. <!DOCTYPE html>).
  { type: 4, re: /^ {0,3}<![A-Za-z]/, end: />/ },
  // 5: <![CDATA[
  { type: 5, re: /^ {0,3}<!\[CDATA\[/, end: /]]>/ },
  // 6: `<` or `</` + a listed block tag name + whitespace, EOL, `>` or `/>`.
  { type: 6, re: new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?=\\s|/?>|$)`, 'i'),
    end: null },
  // 7: a COMPLETE open or closing tag alone on the line, and the ONE condition
  // that may not interrupt a paragraph.
  //
  // NO TAG-NAME EXCLUSION, and that is round 8's second fix. The prose of the
  // spec says condition 7's OPEN tag may not be named `pre`/`script`/`style`/
  // `textarea`; this module read that as "reject those four names in either
  // form", which also threw out COMPLETE CLOSING TAGS. It is wrong twice over.
  // The conditions are tried IN ORDER, so `<pre>` and `<pre a="1">` are already
  // condition 1 and never reach here; what the over-wide reject actually removed
  // was `</pre>`, `</script>`, `</style>`, `</textarea>` and `<pre/>` — none of
  // which condition 1 matches (it needs whitespace, `>` or EOL after the name) —
  // and the reference implementation makes every one of them a condition-7 HTML
  // block. So a message OPENING with a lone `</pre>` had a literal region the
  // parser called live, and an `orchard-notes` example under it became a real
  // CLOSED fold. The hiding direction, found by the reference differential and
  // fixed here rather than recorded as a limitation.
  { type: 7, re: new RegExp(`^ {0,3}${HTML_COMPLETE_TAG}\\s*$`),
    end: null, notInParagraph: true },
]);

/**
 * The HTML-block kind `line` starts, or null. `inParagraph` says whether the
 * previous line left a paragraph open, which only condition 7 cares about.
 * Conditions are tried in spec order, so `<!--` is a comment before it is a
 * declaration and `<pre>` is type 1 before it is a complete tag.
 */
function htmlStartOf(line, inParagraph) {
  for (const s of HTML_STARTS) {
    if (s.notInParagraph && inParagraph) continue;
    if (s.re.test(line)) return s;
  }
  return null;
}

/* ── paragraph state ────────────────────────────────────────────────────────
 * Condition 7 — the ONLY start condition CommonMark forbids from interrupting a
 * paragraph — needs to know whether the previous line left a paragraph open.
 * Round 6 approximated that with "any non-blank line is paragraph text", on the
 * argument that under-recognising condition 7 errs toward NOT inert and is
 * therefore bounded. Round 7 falsified it on its own terms: `# heading` above a
 * complete custom tag left the flag set, condition 7 was suppressed, the region
 * was NOT treated as literal, and the `orchard-notes` EXAMPLE written inside it
 * became a real CLOSED fold — content in the DOM, absent from the rendered text
 * and from the accessibility tree, `malformed` empty. The same hole existed for
 * thematic breaks, setext headings, indented code, an empty list item and an
 * empty block quote: ten shapes, not one. So under-recognition here is NOT the
 * safe side, because the flag's two directions are not symmetric — a FALSE
 * paragraph corrupts the parse (round 6), and a MISSED paragraph-close HIDES
 * CONTENT (round 7). Only the real rule is safe, so the real rule is what is
 * implemented: the constructs that open and close a paragraph are ENUMERATED.
 *
 * A paragraph is closed by any COMPLETED leaf block and by any container marker
 * whose content is itself not paragraph text:
 *   - a BLANK line;
 *   - an ATX HEADING (`#`..`######` then whitespace or end of line);
 *   - a THEMATIC BREAK (three or more of `*`, `-` or `_`, one character only);
 *   - a FENCED CODE opener, either character (handled by the main scan, which
 *     consumes the whole fence, and here for fences inside a container);
 *   - an HTML BLOCK start (types 1-6 always; type 7 only when no paragraph is
 *     already open, which is this very rule, applied one level in);
 *   - a SETEXT UNDERLINE (`===` / `---`), which only exists when a paragraph IS
 *     open and turns it into a heading;
 *   - an EMPTY container: `-`, `1.` or `>` with nothing after the marker.
 * A paragraph is left OPEN by ordinary text, and by INDENTED CODE (4+ columns)
 * only when one was already open, because indented code cannot interrupt a
 * paragraph — it is continuation text.
 *
 * CONTAINERS ARE A STACK, NOT A PREFIX  (round 8)
 * Round 7 handled containers by STRIPPING their markers off the line with a
 * regex and classifying what was left, carrying a marker "chain" string so two
 * lines could be asked whether they were in the same container. It wrote down
 * that this was one level deep and approximate. That documented limitation was
 * the next verdict — the fourth round in a row where it was:
 *
 *     -     code
 *     <my-widget>
 *     ````orchard-notes
 *     ADVERSARIAL-MUST-BE-VISIBLE
 *     ````
 *     </my-widget>
 *
 * `-` followed by FIVE spaces is a list item whose content starts one column
 * after the marker and is therefore INDENTED CODE, not a paragraph (CommonMark
 * 5.2: with 5+ spaces after the marker the content indent is marker+1 and the
 * rest is code). The prefix regex ate all five spaces greedily, saw the
 * paragraph `code`, and left a paragraph open; `<my-widget>` at column 0 then
 * looked like lazy continuation, condition 7 was suppressed, and the authored
 * example became a real CLOSED fold — invisible in the render and in the
 * accessibility tree, `malformed` EMPTY. Same hiding class, reached through
 * container geometry.
 *
 * A line's meaning is a function of the CONTAINER STACK it sits in, so the
 * stack is what is modelled: `advanceLineState` walks the open containers of
 * the previous line, matches or fails each one, opens whatever new containers
 * the line starts, and classifies only what is left. WHAT IS IMPLEMENTED:
 *   - BLOCK QUOTES at any depth: 0-3 spaces, `>`, one optional following space.
 *   - LIST ITEMS at any depth, with the real CONTENT INDENT rule: marker plus
 *     1-4 following spaces sets the content column; 5+ spaces means content
 *     column marker+1 and the remainder is indented code; a marker with nothing
 *     after it is an empty item at marker+1.
 *   - CONTINUATION by indentation: a later line stays in a list item only if it
 *     is indented to that item's content column (or is blank).
 *   - LAZY CONTINUATION: an under-indented / unprefixed line that is paragraph
 *     continuation text inherits the open paragraph and keeps the containers.
 *   - INDENTED CODE INSIDE A CONTAINER: measured from the container's content
 *     column, not from column 0, and it cannot interrupt a paragraph.
 *   - THE PARAGRAPH-INTERRUPT RULES: a list item may not interrupt a paragraph
 *     unless it has content and, if ordered, starts at 1; a block quote may.
 *   - TABS as 4-column stops, expanded ONCE per line before any of the above,
 *     so every rule can be written in columns and none has to re-derive it.
 *
 * WHAT IS DELIBERATELY NOT IMPLEMENTED, each with a test that it cannot hide
 * (see the `container` stratum and the container differential):
 *   - LIST TIGHTNESS / two-blank-lines-close-a-list, and list-type changes
 *     (`-` after `*`) starting a NEW list. Both only change how a list is
 *     grouped, never whether a line is literal.
 *   (Round 10 removed LINK REFERENCE DEFINITIONS from this list: they are now
 *   parsed for real, across lines, by a port of the reference's `parseReference`.)
 *
 * EVERY OTHER CONSTRUCT WHOSE EXTENT CAN SPAN LINES, enumerated round 10 while
 * fixing the definition case, with where each is modelled:
 *   - FENCED CODE BLOCKS — the open leaf (`classifyLeaf` -> `leaf.kind==='fence'`),
 *     bounded by their container (`containerBoundOf`). Round 9.
 *   - HTML BLOCKS, conditions 1-5 — an explicit end pattern carried on the leaf;
 *     conditions 6-7 end at the first blank line. Round 9.
 *   - SETEXT HEADINGS — a paragraph plus an underline; the underline's meaning
 *     depends on the whole paragraph above it, which is now literally its
 *     accumulated content. Rounds 9 and 10.
 *   - PARAGRAPHS THEMSELVES, including LAZY continuation across an unmatched
 *     container prefix — the `refContent` accumulator follows a lazy line too,
 *     because a definition can be finished lazily.
 *   - INDENTED CODE across a blank line: it stays one block in the reference and
 *     is re-classified line-by-line here. It cannot differ: every line of it is
 *     CLOSED to this classifier either way, and an `orchard-notes` fence at 4+
 *     columns is not recognised, so nothing folds. Generated by the fuzz
 *     (`    code` / blank / `    more code`) at zero disagreements.
 *   - LIST TIGHTNESS and two-blank-lines-close-a-list — above; grouping only.
 *   - INLINE constructs that span lines (a code span, a raw inline tag, an
 *     inline link's destination or title) live INSIDE a paragraph and cannot make
 *     a following line literal; pinned in the corpus `inline` stratum.
 *   - The renderer-side EXTENT of a fence or HTML region inside a container:
 *     the main scan recognises fence and HTML starts in CONTAINER CONTEXT — on
 *     the line with its matched container prefix consumed (`restOfLine`,
 *     `para.opener`), NOT at 0-3 columns of raw indent — so a fence at 0-3
 *     container-relative columns inside a deep quote or list IS recognised and
 *     folds. What stays unrecognised is a construct at 4+ columns RELATIVE TO ITS
 *     CONTAINER, which is indented code and inert on both sides, so the token
 *     stays visible. (Round 9 retired the raw-indent-only reading as false — see
 *     round 9 note 4 above: under-recognising the literaliser while still
 *     recognising the fence hides content.) The container differential asserts
 *     this for every such case.
 *
 * The whole rule is differential-tested against the CommonMark 0.31.2 reference
 * implementation over a generated container space — nested quotes, nested
 * lists, mixed containers, every content indentation, setext underlines and
 * blank lines inside containers — in BOTH directions, at zero hiding
 * disagreements (scripts/verify-feat-091-response-blocks.mjs, `para` stratum
 * and the container differential leg; scripts/verify-feat-091-commonmark-diff.mjs
 * for the top-level space).
 */
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/**
 * A LIST MARKER at the start of what is left after the containers so far: a
 * bullet (`-` `*` `+`) or an ordered marker of at most 9 digits then `.` or `)`,
 * followed by a space or the end of the line. Capture 1 is the ordered number,
 * which the paragraph-interrupt rule needs (only `1.` may interrupt).
 */
const LIST_MARKER_RE = /^(?:[-*+]|(\d{1,9})[.)])(?= |$)/;

/* ══ LINK REFERENCE DEFINITIONS — THE ONE LEAF WHOSE EXTENT SPANS LINES ═════
 *
 * Round 9 recognised definitions with a ONE-LINE regex, `[label]: dest` and an
 * optional title all on the same line. Round 10's clean room found the gap that
 * leaves, and it LOSES A BLOCK:
 *
 *     [ref]:
 *     /url
 *     ===
 *     <my-widget>
 *     ````orchard-notes
 *     NARRATION
 *     ````
 *
 * A definition's label, destination and title may EACH sit on their own line
 * (CommonMark 4.7: "the title may extend over multiple lines... whitespace,
 * including up to one line ending"). The reference therefore resolves the whole
 * two-line definition out of the paragraph when `===` arrives, leaves nothing to
 * underline, makes no heading, and keeps the paragraph OPEN — so condition 7 is
 * suppressed on `<my-widget>` and the fence below is a LIVE `orchard-notes`
 * block. The one-line regex saw no definition, so the paragraph was not
 * `onlyRefs`, `===` became a setext HEADING, the paragraph closed, condition 7
 * fired, and a well-formed authored fold became literal prose: the fold
 * DISAPPEARED, its narration was exposed in the accessibility tree, and
 * `inert-html:orchard-notes` was reported as uncertainty on VALID input. Round
 * 9's note ("the multi-line form is not recognised, and cannot hide") was true
 * about hiding and irrelevant about losing, which is the other direction of the
 * same standing rule.
 *
 * A LINE CLASSIFIER CANNOT DECIDE THIS ONE LINE AT A TIME, and no wider regex
 * fixes that: whether line N is inside a definition depends on lines 1..N-1.
 * (`[a]: /u` then `"title"` is ONE definition; `[a]: /u` then `"title"` then
 * `more` is a definition plus the text `more`, because the title is discarded
 * when it is not at a line end.) So the paragraph carries its ACCUMULATED
 * CONTENT — exactly the reference's `_string_content` — and the resolution below
 * is a direct port of the reference's `parseReference`, run at exactly the one
 * place the reference runs it: the setext-underline block start, which resolves
 * definitions off the front of the paragraph and only makes a heading if
 * something is left (blocks.js, "resolve reference link definitiosn").
 *
 * The content is accumulated from the RAW line, not the tab-expanded one: the
 * reference's `spnl` is `/^ *(?:\n *)?/`, which does not match a TAB, so
 * `[a]:<TAB>/url` is NOT a definition. Expanding that tab first would invent one,
 * and inventing a definition is the HIDING direction.
 *
 * Accumulation stops the moment the content cannot start a definition (it does
 * not begin with `[`), because from then on the resolve loop can never consume
 * anything and the remainder can never be empty. That bounds the state to
 * definition-shaped paragraphs.
 */
const REF_ESCAPABLE = "[!\"#$%&'()*+,./:;<=>?@[\\\\\\]^_`{|}~-]";
const REF_ESCAPED_CHAR = '\\\\' + REF_ESCAPABLE;
/** `^\[(?:[^\\\[\]]|\\.){0,1000}\]` — a label MAY contain line endings. */
const REF_LABEL_RE = /^\[(?:[^\\[\]]|\\.){0,1000}\]/s;
/** Optional whitespace including AT MOST ONE line ending. Tabs are not whitespace here. */
const REF_SPNL_RE = /^ *(?:\n *)?/;
const REF_SPACE_AT_EOL_RE = /^ *(?:\n|$)/;
const REF_DEST_BRACES_RE = /^(?:<(?:[^<>\n\\\0]|\\.)*>)/;
const REF_TITLE_RE = new RegExp(
  '^(?:"(?:' + REF_ESCAPED_CHAR + '|\\\\[^\\\\]|[^\\\\"\\0])*"'
  + "|'(?:" + REF_ESCAPED_CHAR + "|\\\\[^\\\\]|[^\\\\'\\0])*'"
  + '|\\((?:' + REF_ESCAPED_CHAR + '|\\\\[^\\\\]|[^\\\\()\\0])*\\))',
);
const REF_ESCAPABLE_HERE_RE = new RegExp('^' + REF_ESCAPABLE);
const REF_WHITESPACE_CHAR_RE = /^[ \t\n\v\f\r]/;

/**
 * End offset of a link DESTINATION starting at `pos`, or -1. A port of the
 * reference's `parseLinkDestination`: either a `<...>` form, or a run of
 * non-whitespace with BALANCED parentheses and backslash escapes.
 */
function refDestinationEnd(s, pos) {
  const braces = REF_DEST_BRACES_RE.exec(s.slice(pos));
  if (braces) return pos + braces[0].length;
  if (s[pos] === '<') return -1;
  const save = pos;
  let openparens = 0;
  let c;
  while (pos < s.length) {
    c = s[pos];
    if (c === '\\' && REF_ESCAPABLE_HERE_RE.test(s.charAt(pos + 1))) {
      pos += 1;
      if (pos < s.length) pos += 1;
    } else if (c === '(') { pos += 1; openparens += 1; }
    else if (c === ')') { if (openparens < 1) break; pos += 1; openparens -= 1; }
    else if (REF_WHITESPACE_CHAR_RE.test(c)) break;
    else pos += 1;
  }
  if (pos === save && c !== ')') return -1;
  if (openparens !== 0) return -1;
  return pos;
}

/**
 * How many characters at the FRONT of `s` are one complete link reference
 * definition, or 0. A port of the reference's `parseReference`, minus the refmap
 * (this module never resolves a link, it only needs the EXTENT).
 */
function linkReferenceDefinitionLength(s) {
  const label = REF_LABEL_RE.exec(s);
  if (!label || label[0].length > 1001) return 0;
  const rawlabel = label[0];
  let pos = rawlabel.length;
  if (s[pos] !== ':') return 0;
  pos += 1;
  pos += REF_SPNL_RE.exec(s.slice(pos))[0].length;
  const destEnd = refDestinationEnd(s, pos);
  if (destEnd < 0) return 0;
  pos = destEnd;
  const beforeTitle = pos;
  pos += REF_SPNL_RE.exec(s.slice(pos))[0].length;
  let title = null;
  if (pos !== beforeTitle) {
    const t = REF_TITLE_RE.exec(s.slice(pos));
    if (t) { title = t[0]; pos += t[0].length; }
  }
  if (title === null) pos = beforeTitle;
  // The definition must reach a line end. If a title was found but does not, the
  // title is DISCARDED and the destination re-checked — the reference's own
  // second chance, and the reason `[a]: /u` + `"t"` + `more` is a definition
  // plus the paragraph `more`.
  let m = REF_SPACE_AT_EOL_RE.exec(s.slice(pos));
  if (m) pos += m[0].length;
  else if (title === null) return 0;
  else {
    pos = beforeTitle;
    m = REF_SPACE_AT_EOL_RE.exec(s.slice(pos));
    if (!m) return 0;
    pos += m[0].length;
  }
  // "A link label must contain at least one character that is not a space, tab or line ending."
  if (rawlabel.slice(1, -1).trim() === '') return 0;
  return pos;
}

/**
 * Strip every leading link reference definition from paragraph content, the way
 * the reference's setext block start does. What is LEFT is what the underline
 * would underline; empty means no heading is made and the paragraph stays open.
 */
function resolveLinkRefDefs(content) {
  let s = content;
  for (;;) {
    if (s.charCodeAt(0) !== 91) return s;              // not `[`
    const n = linkReferenceDefinitionLength(s);
    if (!n) return s;
    s = s.slice(n);
  }
}

/**
 * Append one paragraph line to the accumulated ref content, or give up (null) once
 * the content can no longer be all-definitions. `null` means "a paragraph is open
 * but a setext underline over it is a HEADING", which is the common case.
 */
function appendRefContent(prev, contentLine) {
  if (prev === null) return null;
  const next = prev + contentLine;
  return next.charCodeAt(0) === 91 ? next : null;
}

/**
 * Expand tabs to 4-column stops, ONCE per line, before any container rule runs.
 * CommonMark defines every block-structure indent in COLUMNS and a tab as an
 * advance to the next multiple of 4, so doing this at the boundary lets the
 * whole classifier below index by character and be counting columns — the same
 * trick, and the same reason, as normalising line endings at the parse boundary.
 * It is used for CLASSIFICATION ONLY; block content is always taken from the
 * original line, so no reported text is rewritten.
 */
function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; }
    else { out += ch; col += 1; }
  }
  return out;
}

/**
 * For a line that contains a TAB, a map from an index in `expandTabs(line)` back
 * to the index in the ORIGINAL line that produced it (every column of an expanded
 * tab maps to the tab itself, and `length` maps to `length`). Null when there is
 * no tab, i.e. when the two indexings are the same. Used only to recover the RAW
 * text of a paragraph line after the container prefix has been consumed in
 * COLUMNS — see the link-reference-definition section on why the raw text matters.
 */
function tabSourceMap(rawLine) {
  if (!rawLine.includes('\t')) return null;
  const map = [];
  let col = 0;
  for (let i = 0; i < rawLine.length; i++) {
    if (rawLine[i] === '\t') {
      const n = 4 - (col % 4);
      for (let k = 0; k < n; k++) map.push(i);
      col += n;
    } else { map.push(i); col += 1; }
  }
  map.push(rawLine.length);
  return map;
}

/** How many spaces `s` has at `i` (tabs are already expanded). */
function spacesAt(s, i) {
  let n = 0;
  while (s.charCodeAt(i + n) === 32) n++;
  return n;
}

/**
 * Classify the LEAF this line starts, given `rest` — the line with its container
 * markers already consumed, so its own leading spaces are measured from the
 * innermost container's CONTENT column — and whether a paragraph was open in that
 * same container. Returns `{ open, leaf }`: whether a paragraph is left open, and
 * the leaf block left OPEN ACROSS LINES, if any.
 *
 * THE LEAF IS PART OF THE STATE (round 9). This used to return only the boolean.
 * A boolean cannot say "the next line is inside a fenced code block", and the
 * top-level scan only consumes fences and HTML regions it can see at 0-3 columns
 * of RAW indent — so a construct sitting inside a CONTAINER was invisible to
 * both, and its body was classified line by line as if it were prose:
 *
 *     >```
 *     >===
 *     <my-widget>
 *     ````orchard-notes
 *     ROUND-9-MUST-BE-VISIBLE
 *     ````
 *
 * The `===` is code CONTENT inside the quoted fence, but line-at-a-time
 * classification called it a paragraph, so the tag line looked like it was
 * interrupting one, condition 7 was suppressed, and the authored example became a
 * real CLOSED fold with an empty `malformed`. Three shapes, one cause: a quoted
 * fence, a fence inside a list item, and a quoted HTML block. So the open leaf is
 * carried, and its content lines are never re-classified.
 */
function classifyLeaf(rest, wasOpen, wasRefs, contentLine) {
  const CLOSED = { open: false, refContent: null, leaf: null };
  const started = wasOpen ? wasRefs : '';               // '' = a fresh paragraph
  if (!rest.trim()) return CLOSED;                      // blank line
  if (spacesAt(rest, 0) >= 4) {                         // indented code
    // Continuation text of an open paragraph. Indented code cannot interrupt one,
    // and the reference strips ALL leading whitespace off a paragraph line, so an
    // indented line still contributes to the definition content.
    if (!wasOpen) return CLOSED;
    return { open: true, refContent: appendRefContent(wasRefs, contentLine), leaf: null };
  }
  if (THEMATIC_BREAK_RE.test(rest)) return CLOSED;
  if (ATX_HEADING_RE.test(rest)) return CLOSED;
  const o = openerOf(rest);                             // fenced code, either char
  if (o) {
    return { open: false, refContent: null, opener: o, leaf: { kind: 'fence', char: o.char, len: o.len } };
  }
  const h = htmlStartOf(rest, wasOpen);
  if (h) {
    // Types 1-5 may terminate on their own start line (`<!-- x -->`); types 6 and
    // 7 (`end: null`) run to the first blank line, so they always stay open.
    const done = h.end ? h.end.test(rest) : false;
    return { open: false, refContent: null, htmlKind: h, leaf: done ? null : { kind: 'html', end: h.end } };
  }
  // THE SETEXT BLOCK START, which is the one place the reference resolves link
  // reference definitions. Everything the paragraph holds so far is stripped of
  // leading definitions; if anything is LEFT it becomes a heading and the
  // paragraph closes, and if nothing is left no heading is made at all and the
  // underline becomes the paragraph's new content — still OPEN, which is what
  // suppresses condition 7 on the line below.
  if (wasOpen && SETEXT_UNDERLINE_RE.test(rest)) {
    if (wasRefs === null || resolveLinkRefDefs(wasRefs) !== '') return CLOSED;
    return { open: true, refContent: appendRefContent('', contentLine), leaf: null };
  }
  return { open: true, refContent: appendRefContent(started, contentLine), leaf: null };
}

/**
 * Walk the open container stack against `line` (tabs already expanded), consuming
 * each container's marker or indentation left to right. Returns how many matched
 * and the offset reached. The first failure stops the walk — everything after it
 * is unmatched, which is what makes a line a candidate for lazy continuation.
 *
 * Split out of `advanceLineState` (round 9) because the top-level scan needs the
 * SAME walk to bound a construct's extent: a fenced code block or an HTML block
 * cannot outlive the container it was opened in, and neither can be continued
 * lazily. See `containerBoundOf`.
 */
function matchContainers(stack, line) {
  let idx = 0;
  let matched = 0;
  for (; matched < stack.length; matched++) {
    const c = stack[matched];
    if (c.type === 'bq') {
      const sp = spacesAt(line, idx);
      if (sp > 3 || line[idx + sp] !== '>') break;
      idx += sp + 1;
      if (line[idx] === ' ') idx += 1;
    } else {
      // A list item matches a blank line (a blank does not close the item) —
      // UNLESS the item is still EMPTY, because "a list item can begin with at
      // most one blank line" (CommonMark 5.2). Round 9 found the hiding shape:
      //     -
      //     (blank)
      //        <p x>
      //     ````orchard-notes
      // The reference closes the empty item at the blank line, so the tag is a
      // TOP-LEVEL condition-6 HTML block and the fence under it is an EXAMPLE.
      // Matching the blank kept the item open, put the tag inside it, and the
      // fence — at column 0, outside the item — became a real CLOSED fold.
      if (!line.slice(idx).trim()) {
        if (!c.hasContent) break;
        idx = line.length;
        continue;
      }
      const sp = spacesAt(line, idx);
      if (sp < c.contentIndent) break;
      idx += c.contentIndent;
    }
  }
  return { matched, idx };
}

/**
 * Could this line be a LAZY CONTINUATION of an open paragraph — i.e. is it
 * paragraph continuation text? Only a line that starts no other block can be,
 * and INDENTED CODE explicitly can (indented code cannot interrupt a paragraph).
 * Container starts never reach here: `advanceLineState` opens them first.
 *
 * A SETEXT UNDERLINE IS LAZY CONTINUATION TEXT, and getting that backwards is
 * round 9's first defect. "A setext heading underline cannot be a lazy
 * continuation line" (CommonMark 4.3) says the line cannot become a HEADING — it
 * does NOT say the line starts some other block. The reference implementation
 * makes that explicit: its setext start requires the deepest MATCHED container to
 * be the paragraph itself (`container.type === "paragraph"`), so on a lazy line
 * the setext start simply never fires and the line falls through to ordinary
 * paragraph continuation text. This module read the clause as "not a lazy line at
 * all", closed the paragraph, and that is what let
 *
 *     999999999. item
 *     ===
 *     2.     code
 *     <x data-a:b_c.d-e=1>
 *     ````orchard-notes
 *     RANDOM-MUST-BE-VISIBLE
 *     ````
 *
 * hide its content: to the reference the `===` continues the item's paragraph
 * LAZILY, so the following `2.` marker is a sibling item (not a paragraph
 * interrupt — the deepest matched container is the document, not the paragraph),
 * its five spaces make its content indented code, no paragraph is open, and the
 * tag line is a condition-7 HTML block that makes the fence an EXAMPLE. This
 * module instead ended the paragraph at `===`, restarted one at `2.     code`,
 * suppressed condition 7, and folded the authored content into a closed
 * `orchard-notes` — `malformed` empty. Same hiding class as every prior round,
 * reached through the lazy-continuation rule.
 *
 * When the paragraph IS the matched container the setext rule applies normally —
 * that is `leafLeavesParagraphOpen`'s `wasOpen && SETEXT_UNDERLINE_RE` branch,
 * which is exactly the reference's own condition, one level in.
 */
function isParagraphContinuationText(rest) {
  if (!rest.trim()) return false;
  if (spacesAt(rest, 0) >= 4) return true;
  if (THEMATIC_BREAK_RE.test(rest)) return false;
  if (ATX_HEADING_RE.test(rest)) return false;
  if (openerOf(rest)) return false;
  if (htmlStartOf(rest, true)) return false;            // types 1-6 interrupt; 7 does not
  return true;                                          // incl. a setext underline
}

/**
 * The state at the start of a message: no containers open, no paragraph, no open
 * leaf block. `leaf` is the LEAF-BLOCK half of the state (round 9) — see
 * `classifyLeaf`.
 */
const NO_PARAGRAPH = Object.freeze({ stack: Object.freeze([]), open: false, refContent: null, leaf: null, opener: null, htmlKind: null });

/**
 * THE CONTAINER-AWARE LINE CLASSIFIER (see the section header). Given the state
 * after the previous line, return the state after `line`:
 * `{ stack, open }`, where `stack` is the open container stack — `{type:'bq'}`
 * or `{type:'li', contentIndent}` in columns relative to the container that
 * holds it — and `open` says whether a paragraph is open in the innermost one.
 *
 * Three phases, which is CommonMark's own order:
 *   1. MATCH the already-open containers, left to right, consuming each one's
 *      marker or indentation. The first failure stops the walk.
 *   2. OPEN whatever new containers the remainder starts, honouring the
 *      paragraph-interrupt rules.
 *   3. CLASSIFY the leaf that is left — or, if containers were left unmatched
 *      and no new one opened and the leaf is paragraph continuation text, treat
 *      the line as LAZY continuation and keep the previous stack.
 */
function advanceLineState(prev, rawLine) {
  const line = expandTabs(rawLine);
  const srcMap = tabSourceMap(rawLine);
  const stack = prev.stack;
  const walk = matchContainers(stack, line);
  const matched = walk.matched;
  let idx = walk.idx;
  const allMatched = matched === stack.length;
  const newStack = stack.slice(0, matched);
  let rest = line.slice(idx);
  // Where `rest` starts in `line`, kept in step with every slice below, so the
  // RAW text of this line's content can be recovered (see `tabSourceMap` and the
  // link-reference-definition section).
  let restOff = idx;
  let openedNew = false;

  // PHASE 0 — a LEAF BLOCK still open from the previous line. Its content is
  // literal: it is not re-classified, it starts no container, and it is not
  // paragraph text. Neither a fenced code block nor an HTML block can be
  // continued lazily, so unmatched containers END it and the line is classified
  // afresh below (which is exactly the reference's `closeUnmatchedBlocks`).
  if (prev.leaf && allMatched) {
    const l = prev.leaf;
    let stillOpen;
    if (l.kind === 'fence') stillOpen = !isClosingFence(rest, l.char, l.len);
    else if (l.end) stillOpen = !l.end.test(rest);      // HTML types 1-5
    else stillOpen = !!rest.trim();                     // HTML types 6-7: blank ends it
    return {
      stack: rest.trim() ? withContent(newStack) : newStack,
      open: false,
      refContent: null,
      leaf: stillOpen ? l : null,
      opener: null,
      htmlKind: null,
    };
  }

  for (;;) {
    const sp = spacesAt(rest, 0);
    if (sp >= 4) break;                       // indented code: never a container start
    const after = rest.slice(sp);
    if (!after) break;
    if (after[0] === '>') {                   // a quote MAY interrupt a paragraph
      newStack.push({ type: 'bq' });
      rest = after.slice(1);
      restOff += sp + 1;
      if (rest[0] === ' ') { rest = rest.slice(1); restOff += 1; }
      openedNew = true;
      continue;
    }
    // `* * *` is a thematic break, not a list of a list of a list.
    if (THEMATIC_BREAK_RE.test(after)) break;
    const m = LIST_MARKER_RE.exec(after);
    if (!m) break;
    const markerWidth = m[0].length;
    const afterMarker = after.slice(markerWidth);
    const emptyItem = !afterMarker.trim();
    // A list item may not interrupt a paragraph unless it has content and, when
    // ordered, starts at 1. Only relevant while that paragraph is still ours.
    if (prev.open && allMatched && !openedNew
        && (emptyItem || (m[1] !== undefined && Number(m[1]) !== 1))) break;
    const spAfter = spacesAt(afterMarker, 0);
    let contentIndent;
    if (emptyItem) { contentIndent = sp + markerWidth + 1; rest = ''; restOff = line.length; }
    else if (spAfter >= 5) {
      // 5+ spaces after the marker: the content column is marker+1 and what is
      // left is INDENTED CODE. This is the round-8 defect, in one branch.
      contentIndent = sp + markerWidth + 1;
      rest = afterMarker.slice(1);
      restOff += sp + markerWidth + 1;
    } else {
      contentIndent = sp + markerWidth + spAfter;
      rest = afterMarker.slice(spAfter);
      restOff += sp + markerWidth + spAfter;
    }
    // `hasContent` is the "at most one blank line" rule's state: an item that has
    // not yet held a non-blank line is closed by a blank one. See matchContainers.
    newStack.push({ type: 'li', contentIndent, hasContent: !emptyItem });
    openedNew = true;
  }

  // A line whose containers did not all match can be LAZY continuation only of a
  // paragraph — never of a leaf block, which the phase-0 fallthrough just closed.
  // The RAW text this line contributes to an open paragraph: the reference strips
  // ALL leading whitespace off a paragraph line (`advanceNextNonspace`) and keeps
  // the rest of the line verbatim, tabs included.
  const rawRest = srcMap ? rawLine.slice(srcMap[Math.min(restOff, srcMap.length - 1)]) : rawLine.slice(restOff);
  const contentLine = rawRest.replace(/^[ \t]*/, '') + '\n';

  if (!prev.leaf && !allMatched && !openedNew && prev.open
      && isParagraphContinuationText(rest)) {
    // LAZY continuation: containers survive and the line is appended to the same
    // paragraph, so it also extends a link reference definition in progress —
    // `> [a]:` / `/url` / `> ===` is one definition, and calling a lazy line
    // "ordinary text" (round 9) would lose the block below it.
    return {
      stack: withContent(stack),
      open: true,
      refContent: appendRefContent(prev.refContent, contentLine),
      leaf: null,
      opener: null,
      htmlKind: null,
    };
  }
  const wasOpen = !prev.leaf && prev.open && allMatched && !openedNew;
  const cls = classifyLeaf(rest, wasOpen, wasOpen ? prev.refContent : null, contentLine);
  return {
    stack: rest.trim() ? withContent(newStack) : newStack,
    open: cls.open,
    refContent: cls.refContent,
    leaf: cls.leaf,
    // What this line STARTS, in its container context — the top-level scan's only
    // source of truth about fences and HTML starts (see `parseResponseBlocks`).
    opener: cls.opener || null,
    htmlKind: cls.htmlKind || null,
    // The opener line's OWN container-stripped text. It cannot be recovered with
    // `restOfLine(state.stack, line)`: the line that OPENS a container does not
    // match that container's continuation rule (`- <!DOCTYPE h>` has no four
    // columns of indent), so the walk returns null and a type-1..5 terminator on
    // the start line itself would be missed — which ended the region one line
    // LATE and handed a real fold the content that region should have made
    // literal.
    rest,
  };
}

/**
 * `rawLine` with the container prefix of `stack` consumed, or null if the line
 * does not sit in that stack at all. The top-level scan measures a construct's
 * closing fence and terminator against THIS, never the raw line — a fence opened
 * at the content column of a list item is closed at that column too.
 */
function restOfLine(stack, rawLine) {
  const line = expandTabs(rawLine);
  if (!stack.length) return line;
  const w = matchContainers(stack, line);
  return w.matched === stack.length ? line.slice(w.idx) : null;
}

/** Mark every open list item as having held content (see matchContainers). */
function withContent(stack) {
  let changed = false;
  const out = stack.map((c) => {
    if (c.type !== 'li' || c.hasContent) return c;
    changed = true;
    return { type: 'li', contentIndent: c.contentIndent, hasContent: true };
  });
  return changed ? out : stack;
}

/** Any fence run at all — used only to characterise fallback prose. */
const ANY_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/m;

/** Line endings, per CommonMark (and per marked): CRLF, lone CR, LF. */
const LINE_ENDINGS_RE = /\r\n?/g;

/**
 * Is `line` a closing fence for a block opened with `len` of `char`? A run of the
 * OTHER fence character never closes it, however long — CommonMark pairs a fence
 * with its own character.
 */
function isClosingFence(line, char, len) {
  const re = FENCE_CLOSE_RES[char];
  if (!re) return false;
  const m = re.exec(line);
  return !!m && m[1].length >= len;
}

/**
 * Parse an opening fence line into `{ char, len, info }`, or null if it is not
 * one. THE one fence primitive in this module: every rule below (the top-level
 * scan, C1, C2) goes through it, so a fence rule cannot be right in one scanner
 * and wrong in another.
 */
function openerOf(line) {
  for (const [char, re] of FENCE_OPEN_RES) {
    const m = re.exec(line);
    if (!m) continue;
    const raw = (m[2] || '').trim();
    const info = raw.toLowerCase();
    // THE NAME IS THE FIRST TOKEN; the rest is a free-text label (case kept).
    // `name` is a prefix of `info`, so every namespace test below is unchanged by
    // a label: `info.startsWith('orchard-')` and `name.startsWith('orchard-')`
    // are the same predicate, and C1 therefore cannot be weakened by one.
    const sp = raw.search(/\s/);
    const name = sp === -1 ? info : info.slice(0, sp);
    const label = sp === -1 ? '' : raw.slice(sp).trim();
    return { char, len: m[1].length, info, name, label };
  }
  return null;
}

/* ── fallback characterisation ──────────────────────────────────────────────── */

const EXCERPT_HEAD = 400;
const EXCERPT_TAIL = 200;

/**
 * Cap a fallback excerpt from BOTH ends. The head says what the run is about; the
 * tail catches the ask, which in a real reply is usually the last sentence. A
 * middle-truncated excerpt answers "what kind of thing is this" far better than a
 * head-only one of the same size.
 */
export function excerpt(text, head = EXCERPT_HEAD, tail = EXCERPT_TAIL) {
  const s = String(text ?? '');
  if (s.length <= head + tail + 40) return s;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${omitted} chars omitted]…\n${s.slice(-tail)}`;
}

const TAG_TESTS = [
  // Is the reader being ASKED something? The single most actionable shape.
  ['question', (t) => /\?\s*(\n|$)/.test(t)],
  // Addressed to the reader vs the agent narrating itself. These two together are
  // what tell us whether uncategorized prose wanted `answer` or wanted `notes`.
  ['second-person', (t) => /\b(you|your|you're|yours)\b/i.test(t)],
  ['first-person-narration', (t) => /\b(I|I'm|I've|I'll|we|we're|let me|next up)\b/.test(t)],
  // Bulky verbatim material — the shape that would justify an `evidence` block.
  ['code-fence', (t) => ANY_FENCE_RE.test(t)],
  ['command-output', (t) => /^\s*(PASS|FAIL|ok\b|not ok\b|TOTAL:|Exit(ed)? (code|status)|npm (run|test)|\$ )/m.test(t)],
  ['numbers-heavy', (t) => (t.match(/\b\d+\b/g) || []).length >= 8],
  // Document furniture: a run with these is a structured sub-document, not a
  // stray sentence, and a recurring one is a candidate for its own name.
  ['list', (t) => (t.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) || []).length >= 2],
  ['heading', (t) => /^ {0,3}#{1,6}\s+\S/m.test(t)],
  ['table', (t) => (t.match(/^\s*\|.*\|\s*$/gm) || []).length >= 2],
  ['ticket-ref', (t) => /\b(?:FEAT|BUG|ARCH|CHORE)-\d+\b/.test(t)],
  ['file-paths', (t) => (t.match(/(?:^|\s)(?:\/|\.\/|src\/|scripts\/|docs\/|public\/)[\w.@/-]+/g) || []).length >= 2],
  ['url', (t) => /https?:\/\/\S+/.test(t)],
];

/**
 * Describe a run of uncategorized prose well enough that a LATER reader can
 * decide whether it deserves a block name — without having to trust that the
 * excerpt survived truncation. Cheap, deterministic, no model call.
 */
export function characterise(text) {
  const s = String(text ?? '');
  const lineArr = s.split('\n');
  const tags = [];
  for (const [name, test] of TAG_TESTS) {
    let hit = false;
    try { hit = test(s); } catch { hit = false; }
    if (hit) tags.push(name);
  }
  const words = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  if (s.trim().length < 200) tags.push('short');
  return {
    chars: s.length,
    lines: lineArr.length,
    words,
    tags,
    excerpt: excerpt(s),
  };
}

/* ── the parser ─────────────────────────────────────────────────────────────── */

/**
 * Split an assistant message into known blocks + fallback runs.
 *
 * Never throws: a non-string, an empty string, a message with no blocks at all
 * and a message that is one unterminated fence all return a well-formed result.
 * A message with no blocks is LEGAL — `shape` reports `unstructured` and the
 * whole text is one fallback run.
 *
 * @param {string} text
 * @returns {{
 *   blocks: {name:string, label:string, content:string, startLine:number, endLine:number, fence:number, fenceChar:string, chars:number}[],
 *   fallbackRuns: {text:string, startLine:number, position:string, chars:number, lines:number, words:number, tags:string[], excerpt:string}[],
 *   counts: Record<string, number>,
 *   unknownBlocks: {name:string, chars:number}[],
 *   malformed: string[],
 *   shape: 'unstructured'|'structured',
 *   declaredUncategorized: {label:string, startLine:number, chars:number, lines:number, words:number, tags:string[], excerpt:string}[],
 *   fallbackChars: number,
 *   blockChars: number,
 *   totalChars: number,
 * }}
 */
export function parseResponseBlocks(text) {
  const raw = typeof text === 'string' ? text : '';
  // NORMALISE LINE ENDINGS ONCE, HERE, before any rule runs (see the header).
  // A CRLF transcript would otherwise leave `\r` on the info string, so
  // `orchard-digest\r` misses KNOWN_BLOCKS and raises a spurious advisory on a
  // compliant reply; and a LONE CR would not split at all, hiding a whole
  // reserved opener inside what the per-line rules called one line. Doing it at
  // the boundary means no predicate below has to remember.
  const src = raw.replace(LINE_ENDINGS_RE, '\n');
  const lines = src.split('\n');

  const blocks = [];
  const unknownBlocks = [];
  const malformed = [];
  /** Every fenced code region this scan recognised — see the push site (BUG-111). */
  const fences = [];
  /** @type {{lines:string[], startLine:number}[]} */
  const runsRaw = [];
  let pending = null;

  const pushFallbackLine = (line, idx) => {
    if (!pending) pending = { lines: [], startLine: idx };
    pending.lines.push(line);
  };
  const flush = () => {
    if (pending) { runsRaw.push(pending); pending = null; }
  };

  /**
   * THE CONTAINER BOUND (round 9). The last line index that is still inside the
   * container stack `stack` a construct was opened in, starting the walk after
   * `start`. A fenced code block and an HTML block both END when their container
   * stops matching — neither can be continued lazily — so no construct's extent
   * may run past this line.
   *
   * Without it, extents leaked out of their container in BOTH directions. An HTML
   * block started inside a list item ran to end-of-message and swallowed a fence
   * the reference keeps LIVE, raising a false `inert-html:` (round 6's class); and
   * — the direction that hides — an `orchard-notes` fence opened inside a list
   * item could take its CLOSE from a line outside the item, folding away
   * everything in between:
   *
   *     -
   *       ````orchard-notes
   *       narration
   *     ROUND-9-MUST-BE-VISIBLE
   *       ````
   *
   * To the reference the item's code block ends at `ROUND-9-...` (column 0 does
   * not match the item's content column), so that line is a visible top-level
   * paragraph. Bounded, this module agrees: the fence finds no close inside the
   * item, degrades to `unterminated:` fallback, and every line stays visible.
   *
   * At top level `stack` is empty and every line matches, so this is a no-op for
   * the overwhelmingly common case.
   */
  const containerBoundOf = (start, stack) => {
    if (!stack.length) return lines.length - 1;
    for (let j = start + 1; j < lines.length; j++) {
      const line = expandTabs(lines[j]);
      if (matchContainers(stack, line).matched !== stack.length) return j - 1;
    }
    return lines.length - 1;
  };

  /**
   * Index of the closing fence for an opener at `i` of `len` x `char`, or -1.
   * Never past the container bound: a fence cannot be closed from outside the
   * container it was opened in.
   */
  const findClose = (i, char, len, bound, stack) => {
    const last = bound === undefined ? lines.length - 1 : bound;
    for (let j = i + 1; j <= last; j++) {
      const rest = stack ? restOfLine(stack, lines[j]) : lines[j];
      if (rest !== null && isClosingFence(rest, char, len)) return j;
    }
    return -1;
  };

  /**
   * First line in [from, until) that is a reserved (`orchard-*`) opening fence,
   * or -1. A per-line predicate: NO nesting depth is tracked, deliberately.
   */
  const firstReservedOpener = (from, until) => {
    for (let j = from; j < until; j++) {
      const o = openerOf(lines[j]);
      if (o && o.info.startsWith(BLOCK_NAMESPACE)) return j;
    }
    return -1;
  };

  /**
   * THE CERTAINTY GUARD on the one gate that can hide content (see the header).
   * Returns `{ line, reason }` for the EARLIEST reason the body [from, until) is
   * not unambiguously folded content, or null if it is certain.
   *
   * C1 — a reserved opener anywhere in the body, at any depth: the author may
   *      have meant a real block, and a real block must never be folded away.
   * C2 — an inner fence that is never closed: it may have been meant as this
   *      fold's close, so where the fold really ends is in doubt, and doubt
   *      resolves toward visible.
   *
   * C2 is CommonMark's pairing rule, not a heuristic standing in for it: a fence
   * closes on a run of the SAME character, AT LEAST AS LONG as the opener, alone
   * on its line. Because fences do not nest, tracking that needs one slot, not a
   * stack — `openAt` is either -1 (outside) or the line of the single fence
   * currently open. An opener still open when the body ends is the unpaired one.
   * A closing fence LONGER than its opener is legal and must pair silently; the
   * old even-tally read that as two unpaired lengths and flagged legal input.
   * "Same character" is load-bearing in both directions: a ``` run inside an
   * open ~~~ fence is literal content and does NOT pair it, and vice versa.
   */
  const foldUncertainty = (from, until) => {
    let c1 = -1;
    let openAt = -1, openLen = 0, openChar = '';
    for (let j = from; j < until; j++) {
      const o = openerOf(lines[j]);
      // C1 first, and unconditionally — a reserved opener counts even INSIDE an
      // inner fence, because this is a per-line predicate with no depth in it.
      if (o && o.info.startsWith(BLOCK_NAMESPACE)) { if (c1 === -1) c1 = j; continue; }
      if (openAt === -1) {
        if (o) { openAt = j; openLen = o.len; openChar = o.char; }
      } else if (isClosingFence(lines[j], openChar, openLen)) {
        openAt = -1; openLen = 0; openChar = '';
      }
    }
    const c2 = openAt; // -1 when the body's fence structure closes cleanly
    if (c1 !== -1 && (c2 === -1 || c1 <= c2)) return { line: c1, reason: 'reserved-opener-in-fold' };
    if (c2 !== -1) return { line: c2, reason: 'unpaired-fence-in-fold' };
    return null;
  };

  /**
   * Where a collapsed block opened at `open` with a close at `close` may actually
   * end. Shrinks the candidate body until the guard is satisfied — a cut that only
   * moves the ambiguity earlier is not good enough, so this iterates to a fixed
   * point. Returns `{ end, why }`; `why` is null when the authored close stands.
   */
  const certainFoldEnd = (open, close) => {
    let end = close;
    let why = null;
    for (;;) {
      const u = foldUncertainty(open + 1, end);
      if (!u) return { end, why };
      why = u;
      end = u.line;
      if (end <= open + 1) return { end: open + 1, why };
    }
  };

  /**
   * Last line of the INERT HTML region opened at `start` (see the header). The
   * extent is the HTML kind's own end condition — a terminator for types 1-5,
   * otherwise the line before the first blank one — with ONE addition that makes
   * the whole construct monotone: the region never ends while a fence opened
   * inside it is still open. Without that, a region could end EARLIER than the old
   * fence-only scan did and hand a still-open fence's tail back to the top level,
   * where it could become a fold — i.e. adding inertness could create hiding. With
   * it, the inert set only ever grows. Two-state, like the fence pairing itself:
   * `fence` is null or the single open fence. No depth anywhere.
   */
  const htmlRegionEnd = (start, kind, bound, stack, startRest) => {
    const term = kind.end;
    const last = bound === undefined ? lines.length - 1 : bound;
    for (let j = start; j <= last; j++) {
      const rest = j === start ? startRest
        : ((stack ? restOfLine(stack, lines[j]) : lines[j]) ?? '');
      if (term) { if (term.test(rest)) return j; }
      else if (j > start && !rest.trim()) return j - 1;
    }
    return last;
  };

  let i = 0;
  // The block-structure state CommonMark's start conditions need: the open
  // CONTAINER STACK plus whether a paragraph is open in the innermost container
  // (condition 7 may not interrupt a paragraph). NOT a depth counter and no
  // longer a stripped marker "chain" — round 8's defect was a list item whose
  // content was indented code, which a prefix regex cannot see. See
  // `advanceLineState`.
  //
  // EVERY line advances the state, including the opener of a construct this scan
  // consumes whole. A fence or an HTML region always leaves the paragraph closed
  // (its opener line classifies that way), and its BODY is literal, so the body
  // lines must NOT be fed to the classifier — a `- item` inside a code fence
  // would otherwise push a container that is not there. So the state after such a
  // construct is the state after its OPENER: the container stack the construct
  // sits in, paragraph closed. That is strictly better than the previous reset to
  // "no containers at all", which forgot the enclosing list or quote.
  let para = NO_PARAGRAPH;
  while (i < lines.length) {
    const line = lines[i];
    const prev = para;
    para = advanceLineState(prev, line);
    // ONE DETECTION, IN CONTAINER CONTEXT (round 9). This scan used to ask
    // `openerOf(line)` / `htmlStartOf(line, prev.open)` of the RAW line, i.e. it
    // recognised a construct only at 0-3 columns of raw indent. The classifier
    // meanwhile asked the same questions of the line with its CONTAINER PREFIX
    // consumed, and the two disagreeing is a hiding vector, not a nuance:
    //
    //     *     item
    //         <li a='1'/>
    //       ````orchard-notes
    //       ROUND-9-MUST-BE-VISIBLE
    //       ````
    //
    // The item's content column is 2, so the tag is an HTML block INSIDE the item
    // and the fence under it is an EXAMPLE — which is what the reference says. But
    // the tag sits at 4 raw columns, so the raw-line test missed it, while the
    // fence at 2 raw columns was recognised, and the authored content became a
    // real CLOSED fold with an empty `malformed`. The old note that constructs
    // inside containers are merely "UNDER-recognised, which cannot hide anything"
    // was therefore false: under-recognising the LITERALISER while still
    // recognising the FENCE hides content. So there is now exactly one detection —
    // the classifier's — and this scan reads its verdict.
    const open = para.opener;
    // A construct this scan consumes WHOLE must not leave its leaf open in the
    // classifier state — the next line the classifier sees is the one AFTER the
    // construct, not its content.
    const consumed = () => { para = { ...para, open: false, refContent: null, leaf: null }; };
    if (!open) {
      const kind = para.htmlKind;
      if (kind) {
        consumed();
        // A literal region. Its lines are fallback prose — visible, in order — and
        // if it swallowed something the author may have meant as a real block, say
        // so: uncertainty resolves visible AND reported, never silently.
        const end = htmlRegionEnd(i, kind, containerBoundOf(i, para.stack), para.stack, para.rest);
        const swallowed = firstReservedOpener(i, end + 1);
        if (swallowed !== -1) {
          malformed.push(`inert-html:${openerOf(lines[swallowed]).name}@line${swallowed + 1}`);
        }
        for (let j = i; j <= end; j++) pushFallbackLine(lines[j], j);
        i = end + 1;
        continue;
      }
      pushFallbackLine(line, i);
      i++;
      continue;
    }

    consumed();
    const fenceLen = open.len;
    // The NAME decides everything structural; the LABEL is inert free text that
    // only the metrics read. Flags are worded with the name, never the label, so
    // a label can never change what a flag means.
    const info = open.name;
    const label = open.label;
    // The fence's LAST possible line. An UNTERMINATED fence runs to the end of
    // its container, not to the end of the message: inside a list item, "the rest
    // of the message is prose" would swallow everything after the item — including
    // a fence the reference keeps live — as one literal run.
    const bound = containerBoundOf(i, para.stack);
    const close = findClose(i, open.char, fenceLen, bound, para.stack);

    // RECORD THE FENCE EXTENT, for every fence, before any block semantics run
    // (BUG-111). This is the ONE place in this module where a fence's extent is
    // decided, so recording it here — rather than re-deriving it in a second
    // scanner — is what lets `fenceSegments` give the renderer THIS scan's
    // verdict instead of its own. The extent is CommonMark's: opener to close, or
    // to the container bound when the fence is never closed. It is deliberately
    // NOT the `certainFoldEnd` shrink, which is an orchard-specific certainty
    // guard about what may be HIDDEN, not a statement about where the fence ends.
    fences.push({
      start: i,
      end: close === -1 ? bound : close,
      unterminated: close === -1,
      char: open.char,
      len: fenceLen,
      info: open.info,
      name: info,
      stack: para.stack,
      indent: spacesAt(para.rest ?? '', 0),
    });

    if (!info.startsWith(BLOCK_NAMESPACE)) {
      // An ordinary code fence. Opaque: nothing inside it is ever an opener, so a
      // documented ```orchard-answer example cannot be mistaken for a real block.
      if (close === -1) {
        // Unterminated plain fence: the rest of ITS CONTAINER is prose. Not our
        // malformed case (the author never claimed a block), just fallback.
        for (let j = i; j <= bound; j++) pushFallbackLine(lines[j], j);
        i = bound + 1;
      } else {
        for (let j = i; j <= close; j++) pushFallbackLine(lines[j], j);
        i = close + 1;
      }
      continue;
    }

    // An `orchard-*` fence.
    if (close === -1) {
      // DEGRADE TO FALLBACK, per spec: opener line included, content preserved.
      malformed.push(`unterminated:${info}@line${i + 1}`);
      for (let j = i; j <= bound; j++) pushFallbackLine(lines[j], j);
      i = bound + 1;
      continue;
    }

    // THE ONE GATE. A collapsed block may only fold a body the guard calls
    // certain; anything past the first doubt is re-scanned at top level, so it
    // lands visible or becomes its own block. Never silent: always reported.
    if (COLLAPSED_BLOCKS.includes(info)) {
      const { end, why } = certainFoldEnd(i, close);
      if (why) {
        malformed.push(`ambiguous-fold:${info}@line${i + 1}(${why.reason}@line${why.line + 1})`);
        flush();
        const cut = lines.slice(i + 1, end).join('\n');
        if (cut.trim()) {
          blocks.push({
            name: info,
            label,
            content: cut,
            startLine: i,
            endLine: end - 1,
            fence: fenceLen,
            fenceChar: open.char,
            chars: cut.length,
          });
        } else {
          // Nothing certain to fold: the doubt starts immediately. Emitting an
          // empty <details> would paint an affordance over nothing, so the opener
          // is consumed as structure (already reported) and the blank body — if
          // any — goes to fallback, where blank runs are dropped as they always are.
          for (let j = i + 1; j < end; j++) pushFallbackLine(lines[j], j);
        }
        i = end;
        continue;
      }
    }

    const content = lines.slice(i + 1, close).join('\n');
    if (KNOWN_BLOCKS.includes(info)) {
      // A VISIBLE block (answer/digest) holding a top-level `orchard-*` opener is
      // the same missing-close mistake, but harmless: the swallowed content still
      // renders expanded and in order, so restructuring would only move it INTO a
      // fold. Report it, do not change it — the author gets told, the reader loses
      // nothing. (Openers inside an ordinary code fence are skipped, as always.)
      // (Same depth-free predicate as the fold guard — one scanning primitive in
      // this module, so there is no second scanner to disagree with the first.)
      if (!COLLAPSED_BLOCKS.includes(info)
          && firstReservedOpener(i + 1, close) !== -1) {
        malformed.push(`nested-opener:${info}@line${i + 1}`);
      }
      flush();
      blocks.push({
        name: info,
        label,
        content,
        startLine: i,
        endLine: close,
        fence: fenceLen,
        fenceChar: open.char,
        chars: content.length,
      });
    } else {
      // Reserved namespace, unknown name: content still reaches the reader.
      unknownBlocks.push({ name: info, chars: content.length });
      malformed.push(`unknown-block:${info}@line${i + 1}`);
      for (let j = i + 1; j < close; j++) pushFallbackLine(lines[j], j);
    }
    i = close + 1;
  }
  flush();

  const firstBlockLine = blocks.length ? blocks[0].startLine : -1;
  const lastBlockLine = blocks.length ? blocks[blocks.length - 1].endLine : -1;

  const fallbackRuns = [];
  for (const run of runsRaw) {
    const runText = run.lines.join('\n');
    if (!runText.trim()) continue; // whitespace between blocks is not content
    let position;
    if (!blocks.length) position = 'whole-message';
    else if (run.startLine < firstBlockLine) position = 'before-blocks';
    else if (run.startLine > lastBlockLine) position = 'after-blocks';
    else position = 'between-blocks';
    fallbackRuns.push({ text: runText, startLine: run.startLine, position, ...characterise(runText) });
  }

  const counts = {};
  for (const name of KNOWN_BLOCKS) counts[name] = 0;
  for (const b of blocks) counts[b.name]++;

  // THE DECLARED FALLBACK. An `orchard-uncategorized` block is the author saying
  // "no category fits this", which is a different signal from prose left loose
  // outside every block, and the two must never be added together: one is a gap
  // in the VOCABULARY (read the label, add the missing name), the other is a gap
  // in COMPLIANCE (the author did not categorise). It is characterised exactly
  // like a fallback run so both sides of the report read the same way.
  const declaredUncategorized = blocks
    .filter((b) => b.name === UNCATEGORIZED_BLOCK)
    .map((b) => ({
      label: b.label || '',
      startLine: b.startLine,
      ...characterise(b.content),
    }));

  const fallbackChars = fallbackRuns.reduce((n, r) => n + r.chars, 0);
  const blockChars = blocks.reduce((n, b) => n + b.chars, 0);

  return {
    blocks,
    fences,
    fallbackRuns,
    counts,
    unknownBlocks,
    malformed,
    shape: blocks.length ? 'structured' : 'unstructured',
    declaredUncategorized,
    fallbackChars,
    blockChars,
    totalChars: src.length,
  };
}

/* ── the renderer's view of a fence (BUG-111) ───────────────────────────────── */

/**
 * `rawLine` with the container prefix of `stack` consumed AND up to `indent`
 * further leading spaces removed — the two prefixes a fenced code block's body
 * must not carry: the enclosing `>` or list indent, and the opener's own 0-3
 * columns. Returns null if the line does not sit in `stack` at all.
 *
 * The strip is measured in COLUMNS (tabs expanded, as everywhere in this module)
 * and then mapped back to an index in the ORIGINAL line, so a tab BEYOND the
 * prefix survives into the rendered code verbatim. Rendering `expandTabs(line)`
 * would silently rewrite the user's code, which is the class of change this
 * module exists to avoid.
 */
function stripFenceBodyPrefix(rawLine, stack, indent) {
  const line = expandTabs(rawLine);
  let idx = 0;
  if (stack.length) {
    const w = matchContainers(stack, line);
    if (w.matched !== stack.length) return null;
    idx = w.idx;
  }
  let n = 0;
  while (n < indent && line[idx + n] === ' ') n++;
  idx += n;
  const map = tabSourceMap(rawLine);
  return map ? rawLine.slice(map[Math.min(idx, map.length - 1)]) : rawLine.slice(idx);
}

/**
 * Split `text` into alternating prose and fenced-code segments, using THIS
 * module's fence scan — the same one `parseResponseBlocks` runs, not a second
 * model of the same grammar.
 *
 * This exists because `prose()` in public/lib/dom.js modelled a fence as
 * `src.split(/```/)` — a character-run splitter with no notion of a line, let
 * alone of the line's container. It could not see a tilde fence at all, so a
 * `~~~` block's contents rendered as LIVE markup (an inner `#` became a real
 * heading, a `|` row a real table), and it could not strip a `>` or a list
 * indent, so a quoted fence's body carried its quote markers into the `<pre>`
 * (BUG-111). Every rule the splitter lacked — both fence characters, a closer at
 * least as long as its opener, info strings, 0-3 columns of indent, container
 * continuation — is already implemented here, once, and differential-tested
 * against the reference implementation. So the renderer reads this scan's
 * verdict rather than holding an opinion of its own.
 *
 * Returns `[{ type: 'prose'|'code', text, info, lines: [start, end] }]`, in
 * source order. `lines` is the half-open source line range the segment came
 * from, and the ranges PARTITION the input exactly: every line lands in exactly
 * one segment, which is the property that makes it impossible for this split to
 * lose content. `text` of a prose segment is verbatim; `text` of a code segment
 * is the body with container and opener-indent prefixes removed.
 *
 * Fences do not nest, so overlapping records cannot both be real: a region that
 * starts inside one already emitted is a re-scan artefact of the fold-certainty
 * guard (which may re-read a shrunk fold's tail at top level) and is skipped —
 * the OUTER extent is the CommonMark one.
 */
export function fenceSegments(text) {
  const src = String(text ?? '').replace(LINE_ENDINGS_RE, '\n');
  const lines = src.split('\n');
  const segs = [];
  let at = 0;                                     // next unemitted line
  const pushProse = (from, until) => {
    if (until <= from) return;
    segs.push({ type: 'prose', text: lines.slice(from, until).join('\n'), info: '', lines: [from, until] });
  };
  for (const f of parseResponseBlocks(src).fences) {
    if (f.start < at) continue;                   // nested re-scan artefact
    pushProse(at, f.start);
    const bodyFrom = f.start + 1;
    const bodyUntil = f.unterminated ? f.end + 1 : f.end;   // exclude the closer
    const body = [];
    for (let j = bodyFrom; j < bodyUntil; j++) {
      body.push(stripFenceBodyPrefix(lines[j], f.stack, f.indent) ?? lines[j]);
    }
    // An UNTERMINATED fence runs to the last line of its container, and at top
    // level that is `split('\n')`'s phantom final element — the empty string
    // after a document's closing newline, which is not a line of the document.
    // Dropping it here, and ONLY here, keeps a code block that genuinely ENDS in
    // a blank line (`x`, ``, closer) intact: the old renderer's blanket
    // `.replace(/\n$/, '')` could not tell the two apart.
    if (f.unterminated && f.end === lines.length - 1 && body[body.length - 1] === '') body.pop();
    segs.push({ type: 'code', text: body.join('\n'), info: f.info, lines: [f.start, f.end + 1] });
    at = f.end + 1;
  }
  pushProse(at, lines.length);
  return segs;
}
