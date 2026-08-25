/**
 * FEAT-091 — the GENERATED corpus and the invariants that end the hidden-content
 * class. Pure data + pure functions, no I/O, so both the parser verifier
 * (scripts/verify-feat-091-response-blocks.mjs) and the browser verifier
 * (scripts/verify-feat-091-renderer.mjs) drive the SAME cases: a property that
 * held in node and failed in the browser is exactly the divergence FEAT-091 exists
 * to prevent, so the two must not each invent their own inputs.
 *
 * WHY GENERATED. Two hidden-content defects in a row were each fixed for the shape
 * that was demonstrated, and each time the next shape — one more layer of nesting —
 * was still broken. The input space is small and mechanical (a handful of block
 * names x fence lengths x opened/closed x nesting depth x ordering), so it is
 * enumerable rather than sampled. Every case is built from a TREE, so the authored
 * intent is known by construction and needs no second parser to recover — which
 * matters, because a second parser would just be a second thing to get wrong.
 *
 * WHAT THE THIRD ROUND ADDED, AND WHY. An independent pass found two more defects
 * that this generator could not have caught, because it did not VARY the dimension
 * they lived in — every generated case was LF-separated, unindented, closed by a
 * run of exactly the opener's length, at most 3 deep, at most 5 backticks wide. A
 * lone-CR reserved opener and a legal longer-than-opener close both sat outside
 * the generated space. So the space now varies, explicitly:
 *   - LINE ENDINGS: lf / crlf / lone cr / mixed within one message. The document
 *     is the SAME document under all four, so tokens, well-formedness and expected
 *     blocks are identical — which is exactly the assertion.
 *   - INDENTATION of openers and closers: 0-3 spaces (a fence), and TAB (not a
 *     fence at all — a tab is a 4-column stop, so a tab-indented run is indented
 *     content in CommonMark). Tab-indented nodes are INERT here: the oracle treats
 *     them as literal text, because that is what both the parser and the renderer
 *     must do, and they must do the same thing.
 *   - CLOSING FENCES LONGER THAN THEIR OPENERS — legal CommonMark, and the shape
 *     the old even-tally certainty guard falsely flagged.
 *   - DEPTH 4 and 5, and fence runs of 6-8 backticks.
 *   - NON-LINE-ENDING separators (U+2028/U+2029/form feed) that look like breaks
 *     and are not, to either side.
 *
 * WHAT THE FOURTH ROUND ADDED, AND WHY. Same lesson, fourth dimension: every case
 * above was written with BACKTICK fences, so CommonMark's OTHER fence character
 * was not in the generated space at all. A notes example inside a `~~~markdown`
 * fence was therefore parsed as a real fold and its content rendered invisible —
 * 10,715 cases could not have caught it. The FENCE CHARACTER is now a dimension
 * everywhere the length and closed-state dimensions are:
 *   - depth 1 and depth 2 take the FULL character cross product, so every
 *     containment pair exists in all four (`>`, `>~, ~>`, ~>~) orders.
 *   - a `mix3` stratum runs all eight character patterns at depth 3.
 *   - indent, closer-length, long-run and separator strata all carry the
 *     character, including CROSS-character pairs where the inner fence cannot
 *     close the outer one however long it is.
 *   - `icode` pins the second inert construct — INDENTED CODE (4+ columns) — with
 *     the strong assertion (exact parse AND silence), because it is the escape
 *     hatch the spec offers authors and "the escape hatch still works" is a
 *     promise, not an incidental.
 *   - `html` pins the BOUND on the third construct, HTML blocks, which are
 *     deliberately NOT modelled (see public/lib/response-blocks.js, "WHAT MAKES A
 *     REGION INERT"): an HTML-wrapped reserved opener still ends the fold, so an
 *     authored `orchard-answer` can never hide behind one.
 *   - `tsyn` pins the ONE asymmetry between the two characters, which is
 *     CommonMark's own: a backtick fence's info string may not contain a
 *     backtick; a tilde fence's info string may contain anything.
 *
 * THE ORACLE. Every text region is a unique token. For each token, walk its
 * ancestors innermost-outward and find the first whose name is in the reserved
 * `orchard-` namespace (INERT ancestors are skipped — they are not fences):
 *   - none, or a name other than `orchard-notes`  -> MUST BE VISIBLE.
 *   - `orchard-notes`                             -> may be folded.
 * That is the charter's first invariant stated positively: content authored
 * outside a notes block may never render inside a collapsed fold, including an
 * `orchard-answer` authored *inside* notes, which is precisely the defect shape.
 * The oracle is deliberately one-directional: folded content rendered VISIBLE is
 * always allowed, because degradation may only move content toward visible.
 */

/** Block names spanning every class the grammar distinguishes. */
export const CORPUS_NAMES = Object.freeze([
  'orchard-notes',        // collapsed — the only construct that can hide
  'orchard-answer',       // visible known
  'orchard-digest',       // visible known, special-cased by the renderer
  'orchard-futurething',  // reserved namespace, unknown name -> fallback
  'markdown',             // ordinary code fence with an info string
  '',                     // ordinary bare code fence
]);

/** Names used at depth 3, where the full cross product would be gratuitous. */
export const CORPUS_NAMES_DEEP = Object.freeze(['orchard-notes', 'orchard-answer', 'markdown']);

export const CORPUS_LENS = Object.freeze([3, 4, 5]);
export const CORPUS_CLOSED = Object.freeze([true, false]);

/**
 * CommonMark's TWO fence characters. This is a dimension, not a default: the
 * fourth round's hidden-content defect was a `~~~` fence that the grammar did not
 * model at all, and a generated suite only catches defects in the dimensions it
 * varies. A fence pairs only with its OWN character, at any length.
 */
export const CORPUS_CHARS = Object.freeze(['`', '~']);
const CHAR_TAG = { '`': 'b', '~': 't' };

/** Fence widths beyond the original 3-5, exercised by the long-run stratum. */
export const CORPUS_LENS_LONG = Object.freeze([6, 7, 8]);

/**
 * Line-ending regimes. A message is the SAME document under all four; anything
 * that changes with the regime is a line-splitting bug. `mixed` cycles the three
 * so one message carries all of them.
 */
export const CORPUS_EOLS = Object.freeze(['lf', 'crlf', 'cr', 'mixed']);
const EOL_SEQ = { lf: ['\n'], crlf: ['\r\n'], cr: ['\r'], mixed: ['\n', '\r\n', '\r'] };

/**
 * Fence indents. 0-3 spaces are all a fence; a TAB is not, because a tab advances
 * to the next 4-column stop and 4+ columns is indented content, not a fence.
 */
export const CORPUS_INDENTS = Object.freeze(['', ' ', '  ', '   ', '\t', ' \t']);

/** CommonMark indent width, tabs expanded to 4-column stops. */
function indentWidth(s) {
  let w = 0;
  for (const ch of s ?? '') w = ch === '\t' ? w + (4 - (w % 4)) : w + 1;
  return w;
}

const isReserved = (n) => n.startsWith('orchard-');

/**
 * An INERT node is one whose opener is indented 4+ columns: CommonMark does not
 * see a fence there at all, so it is literal text, it names no block, and it
 * cannot fold anything. Both the parser and the renderer must agree on this, so
 * the oracle encodes it rather than pretending a tab-indented `orchard-notes` is
 * a fold.
 */
const isInert = (node) => indentWidth(node.indentOpen ?? '') >= 4;

/* ── building a case ────────────────────────────────────────────────────────── */

/**
 * A node is `{ name, len, closed, body, char?, closeLen?, indentOpen?,
 * indentClose? }` where body entries are tokens (strings) or nested nodes.
 * Serialising a node emits its opener, its body, and — only if `closed` — a bare
 * closing run of `closeLen` of the SAME character (default: the opener's length;
 * a LONGER close is legal CommonMark and is deliberately generated). `char`
 * defaults to a backtick so every pre-round-4 case is unchanged.
 */
const charOf = (node) => node.char ?? '`';

function serialise(node, out) {
  const ch = charOf(node);
  out.push((node.indentOpen ?? '') + ch.repeat(node.len) + node.name);
  for (const item of node.body) {
    if (typeof item === 'string') out.push(item);
    else serialise(item, out);
  }
  if (node.closed) out.push((node.indentClose ?? '') + ch.repeat(node.closeLen ?? node.len));
}

/** Innermost reserved, NON-INERT ancestor decides whether a token may be folded. */
function walk(node, ancestors, tokens) {
  for (const item of node.body) {
    if (typeof item === 'string') {
      let fold = null;
      for (let k = ancestors.length - 1; k >= 0; k--) {
        if (isInert(ancestors[k])) continue;
        if (isReserved(ancestors[k].name)) { fold = ancestors[k].name; break; }
      }
      tokens.push({ tok: item, mustBeVisible: fold !== 'orchard-notes' });
    } else {
      walk(item, [...ancestors, item], tokens);
    }
  }
}

/**
 * A case is WELL-FORMED iff a literal reading of the grammar reproduces the
 * authored tree exactly: every node closed by a run at least as long as its own
 * opener, reserved blocks only at top level, no inert (4+ indented) node, and
 * every inner fence — opener AND closer — strictly shorter than its parent, so it
 * cannot be mistaken for the parent's close. Well-formed cases carry the
 * anti-vacuity assertions — an exact parse and an EMPTY malformed list — so a
 * parser that simply flagged everything would fail the suite rather than pass it.
 *
 * The length constraint applies ONLY between fences of the SAME character — a
 * `~~~` run of any length cannot close a ``` fence — but it applies to EVERY
 * same-character ANCESTOR, not just the immediate parent. Fences do not nest: a
 * tilde fence written inside a backtick one is literal content, not a container,
 * so it does not shield a wide backtick run from closing the backtick fence two
 * levels up. (This is not a hypothetical: it is what the mixed-character stratum
 * found the moment the character became a dimension.)
 */
function wellFormed(doc) {
  let ok = true;
  const visit = (node, ancestors) => {
    const closeLen = node.closeLen ?? node.len;
    if (!node.closed) ok = false;
    if (closeLen < node.len) ok = false;
    if (isInert(node)) ok = false;
    if (indentWidth(node.indentClose ?? '') >= 4) ok = false;
    if (isReserved(node.name) && ancestors.length) ok = false;
    for (const anc of ancestors) {
      if (charOf(anc) !== charOf(node)) continue;
      if (node.len >= anc.len || closeLen >= anc.len) ok = false;
    }
    const next = [...ancestors, node];
    for (const item of node.body) if (typeof item !== 'string') visit(item, next);
  };
  for (const item of doc) if (typeof item !== 'string') visit(item, []);
  return ok;
}

/** The blocks a faithful parse must produce for a well-formed document. */
function expectedBlocks(doc) {
  const KNOWN = ['orchard-answer', 'orchard-notes', 'orchard-digest'];
  const out = [];
  for (const item of doc) {
    if (typeof item === 'string' || !KNOWN.includes(item.name) || isInert(item)) continue;
    const lines = [];
    for (const b of item.body) {
      if (typeof b === 'string') lines.push(b);
      else serialise(b, lines);
    }
    out.push({ name: item.name, content: lines.join('\n') });
  }
  return out;
}

/** Join authored lines under a line-ending regime. */
function joinLines(lines, eol = 'lf') {
  const seq = EOL_SEQ[eol] ?? EOL_SEQ.lf;
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    out += lines[k];
    if (k < lines.length - 1) out += seq[k % seq.length];
  }
  return out;
}

function docLines(doc) {
  const lines = [];
  for (const item of doc) {
    if (typeof item === 'string') lines.push(item);
    else serialise(item, lines);
  }
  return lines;
}

function makeCase(id, shape, doc, eol = 'lf') {
  const tokens = [];
  walk({ name: '', len: 0, closed: true, body: doc }, [], tokens);
  return {
    id,
    shape,
    eol,
    text: joinLines(docLines(doc), eol),
    tokens,
    wellFormed: wellFormed(doc),
    expected: expectedBlocks(doc),
  };
}

/* ── the enumeration ────────────────────────────────────────────────────────── */

/**
 * The full combination space, in three strata:
 *   depth 1 — every name x length x closed state, with prose before and after.
 *   depth 2 — that cross product against itself: every containment pair.
 *   depth 3 — the shape both shipped defects had, over a reduced name set.
 * Plus the two REAL defect inputs verbatim, so the generated suite can never
 * "pass while the actual reported bug regresses".
 */
export function generateCorpus() {
  const cases = [];
  let n = 0;
  const T = () => `Tok${++n}z`; // z terminator: no token is a substring of another

  for (const name of CORPUS_NAMES) {
    for (const ch of CORPUS_CHARS) {
      for (const len of CORPUS_LENS) {
        for (const closed of CORPUS_CLOSED) {
          const a = T(), b = T(), c = T();
          cases.push(makeCase(`d1/${CHAR_TAG[ch]}/${name || 'bare'}/${len}/${closed ? 'closed' : 'open'}`, 'depth1',
            [a, { name, char: ch, len, closed, body: [b] }, c]));
        }
      }
    }
  }

  for (const n1 of CORPUS_NAMES) {
    for (const h1 of CORPUS_CHARS) {
      for (const l1 of CORPUS_LENS) {
        for (const c1 of CORPUS_CLOSED) {
          for (const n2 of CORPUS_NAMES) {
            for (const h2 of CORPUS_CHARS) {
              for (const l2 of CORPUS_LENS) {
                for (const c2 of CORPUS_CLOSED) {
                  const a = T(), b = T(), c = T(), d = T(), e = T();
                  cases.push(makeCase(
                    `d2/${n1 || 'bare'}:${CHAR_TAG[h1]}${l1}${c1 ? 'C' : 'O'}>${n2 || 'bare'}:${CHAR_TAG[h2]}${l2}${c2 ? 'C' : 'O'}`, 'depth2',
                    [a, { name: n1, char: h1, len: l1, closed: c1, body: [b, { name: n2, char: h2, len: l2, closed: c2, body: [c] }, d] }, e]));
                }
              }
            }
          }
        }
      }
    }
  }

  for (const n1 of CORPUS_NAMES_DEEP) {
    for (const l1 of CORPUS_LENS) {
      for (const c1 of CORPUS_CLOSED) {
        for (const n2 of CORPUS_NAMES_DEEP) {
          for (const l2 of CORPUS_LENS) {
            for (const c2 of CORPUS_CLOSED) {
              for (const n3 of CORPUS_NAMES_DEEP) {
                for (const l3 of CORPUS_LENS) {
                  for (const c3 of CORPUS_CLOSED) {
                    const a = T(), b = T(), c = T(), d = T();
                    cases.push(makeCase(
                      `d3/${n1}:${l1}${c1 ? 'C' : 'O'}>${n2}:${l2}${c2 ? 'C' : 'O'}>${n3}:${l3}${c3 ? 'C' : 'O'}`, 'depth3',
                      [a, {
                        name: n1, len: l1, closed: c1,
                        body: [b, {
                          name: n2, len: l2, closed: c2,
                          body: [c, { name: n3, len: l3, closed: c3, body: [d] }],
                        }],
                      }]));
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /* ── MIXED FENCE CHARACTERS at depth 3, in both orders ───────────────────
   * The depth-3 cross product above is backtick-only (it is already 5,832 cases).
   * Mixing is where the fourth round's defect lived — a backtick fence inside a
   * tilde one — so all EIGHT character patterns are enumerated over the reduced
   * name set, at both a strictly-decreasing width assignment (well-formed when the
   * characters repeat) and a strictly-INCREASING one (which is well-formed only
   * where the characters differ, because a longer run of the other character still
   * cannot close the outer fence). */
  for (const n1 of CORPUS_NAMES_DEEP) {
    for (const n2 of CORPUS_NAMES_DEEP) {
      for (const n3 of CORPUS_NAMES_DEEP) {
        for (const h1 of CORPUS_CHARS) {
          for (const h2 of CORPUS_CHARS) {
            for (const h3 of CORPUS_CHARS) {
              for (const lens of [[5, 4, 3], [3, 4, 5]]) {
                const a = T(), b = T(), c = T(), d = T();
                const tag = `${CHAR_TAG[h1]}${CHAR_TAG[h2]}${CHAR_TAG[h3]}`;
                cases.push(makeCase(`mix3/${tag}/${n1}>${n2}>${n3}/${lens.join('-')}`, 'mix3',
                  [a, {
                    name: n1, char: h1, len: lens[0], closed: true,
                    body: [b, {
                      name: n2, char: h2, len: lens[1], closed: true,
                      body: [c, { name: n3, char: h3, len: lens[2], closed: true, body: [d] }],
                    }],
                  }]));
              }
            }
          }
        }
      }
    }
  }

  /* ── line endings ────────────────────────────────────────────────────────
   * The dimension that hid a whole reserved opener from a per-LF-line predicate.
   * Every case above is re-emitted under CRLF, lone CR and mixed endings; the
   * oracle is untouched, because it is the same document. A stride keeps the
   * suite proportionate while still covering all three strata and every name,
   * length and closed-state, and the FULL depth-2 notes-bearing set is re-emitted
   * unstrided, because that is where hiding lives. */
  const base = cases.slice();
  const notesBearing = (c) => c.text.includes('orchard-notes');
  for (const eol of ['crlf', 'cr', 'mixed']) {
    for (const [k, c] of base.entries()) {
      const dense = c.shape === 'depth2' && notesBearing(c);
      if (!dense && k % 17 !== 0) continue;
      cases.push({ ...c, id: `eol/${eol}/${c.id}`, shape: 'eol', eol, text: joinLines(c.text.split('\n'), eol) });
    }
  }

  /* ── indentation ─────────────────────────────────────────────────────────
   * 0-3 spaces are a fence and must parse identically to indent 0; a tab is 4
   * columns and is NOT a fence, so the oracle marks those nodes inert. Opener and
   * closer indents vary INDEPENDENTLY, because CommonMark allows that. */
  for (const io of CORPUS_INDENTS) {
    for (const ic of CORPUS_INDENTS) {
      for (const inner of ['orchard-answer', 'markdown']) {
        for (const len of [4, 5]) {
          for (const [ho, hi] of [['`', '`'], ['~', '~'], ['`', '~'], ['~', '`']]) {
            const a = T(), b = T(), c = T(), d = T();
            cases.push(makeCase(
              `ind/${CHAR_TAG[ho]}${CHAR_TAG[hi]}/${JSON.stringify(io)}:${JSON.stringify(ic)}/${inner}/${len}`, 'indent',
              [a, {
                name: 'orchard-notes', char: ho, len, closed: true, indentOpen: io, indentClose: ic,
                body: [b, { name: inner, char: hi, len: 3, closed: true, indentOpen: io, indentClose: ic, body: [c] }],
              }, d]));
          }
        }
      }
    }
  }

  /* ── closing fences LONGER than their openers ────────────────────────────
   * Legal CommonMark, and precisely what the even-tally certainty guard read as
   * two unpaired lengths. Sweeps inner opener x inner closer x outer width, so
   * both the legal (closer < outer) and the genuinely ambiguous (closer >= outer,
   * where the inner close would also close the fold) sides are generated. */
  for (const outer of ['orchard-notes', 'orchard-answer']) {
    for (const [ho, hi] of [['`', '`'], ['~', '~'], ['`', '~'], ['~', '`']]) {
      for (const ol of [4, 5, 6, 7]) {
        for (const inner of ['markdown', '', 'orchard-answer']) {
          for (const il of [3, 4]) {
            for (const bump of [0, 1, 2]) {
              // A CROSS-character inner fence may legally be WIDER than the outer
              // one — it still cannot close it — so the same-character-only guard
              // on this skip is itself part of what is being asserted.
              if (ho === hi && il + bump > ol) continue;
              const a = T(), b = T(), c = T(), d = T();
              cases.push(makeCase(
                `clen/${CHAR_TAG[ho]}${CHAR_TAG[hi]}/${outer}:${ol}>${inner || 'bare'}:${il}+${bump}`, 'closelen',
                [a, {
                  name: outer, char: ho, len: ol, closed: true,
                  body: [b, { name: inner, char: hi, len: il, closed: true, closeLen: il + bump, body: [c] }, d],
                }]));
            }
          }
        }
      }
      // A close SHORTER than its opener does not close anything — the inner fence
      // runs on and (when the characters match) the outer's close is the first run
      // that can end it. When they differ, the inner fence never closes at all.
      for (const il of [4, 5]) {
        const a = T(), b = T(), c = T();
        cases.push(makeCase(`clen/${CHAR_TAG[ho]}${CHAR_TAG[hi]}/${outer}/short-close:${il}`, 'closelen',
          [a, {
            name: outer, char: ho, len: 6, closed: true,
            body: [b, { name: 'markdown', char: hi, len: il, closed: true, closeLen: 3, body: [c] }],
          }]));
      }
    }
  }

  /* ── depth 4 and 5 ───────────────────────────────────────────────────────
   * Both shipped defects were "one more layer than the fix considered". Depth 3
   * was the previous ceiling, so the ceiling moves; widths run 8..3 so the strictly
   * decreasing (well-formed) assignments are reachable at every depth. */
  const DEEP = ['orchard-notes', 'orchard-answer', 'markdown'];
  const nest = (names, lens, closed) => {
    let node = null;
    for (let k = names.length - 1; k >= 0; k--) {
      node = { name: names[k], len: lens[k], closed: closed[k], body: node ? [T(), node] : [T()] };
    }
    return node;
  };
  for (const n1 of DEEP) for (const n2 of DEEP) for (const n3 of DEEP) for (const n4 of DEEP) {
    for (const lens of [[6, 5, 4, 3], [4, 5, 3, 6], [8, 7, 5, 3]]) {
      for (const closed of [[true, true, true, true], [true, false, true, true], [true, true, true, false]]) {
        const names = [n1, n2, n3, n4];
        cases.push(makeCase(`d4/${names.join('>')}/${lens.join('-')}/${closed.map((x) => (x ? 'C' : 'O')).join('')}`,
          'depth4', [T(), nest(names, lens, closed), T()]));
      }
    }
  }
  for (const n2 of DEEP) for (const n3 of DEEP) for (const n5 of DEEP) {
    for (const lens of [[8, 7, 6, 5, 4], [7, 4, 8, 3, 5]]) {
      const names = ['orchard-notes', n2, n3, 'markdown', n5];
      cases.push(makeCase(`d5/${names.join('>')}/${lens.join('-')}`, 'depth5',
        [T(), nest(names, lens, [true, true, true, true, true]), T()]));
      cases.push(makeCase(`d5o/${names.join('>')}/${lens.join('-')}`, 'depth5',
        [T(), nest(names, lens, [true, true, false, true, true]), T()]));
    }
  }

  /* ── fence runs of 6-8 backticks ─────────────────────────────────────────
   * The original space stopped at 5, so an 8-backtick fold — and a 6-backtick
   * fold closed by an 8-backtick run — were never generated at all. */
  for (const name of CORPUS_NAMES) {
    for (const ch of CORPUS_CHARS) {
      for (const len of CORPUS_LENS_LONG) {
        for (const closed of CORPUS_CLOSED) {
          const a = T(), b = T(), c = T();
          cases.push(makeCase(`long/${CHAR_TAG[ch]}/${name || 'bare'}/${len}/${closed ? 'closed' : 'open'}`, 'longrun',
            [a, { name, char: ch, len, closed, body: [b] }, c]));
        }
      }
      for (const [ho, hi] of [['`', ch], ['~', ch]]) {
        for (const len of CORPUS_LENS_LONG) {
          const a = T(), b = T(), c = T(), d = T();
          cases.push(makeCase(`long/${CHAR_TAG[ho]}${CHAR_TAG[hi]}/${name || 'bare'}/${len}/inner`, 'longrun',
            [a, {
              name: 'orchard-notes', char: ho, len: 9, closed: true,
              body: [b, { name, char: hi, len, closed: true, closeLen: len + 1, body: [c] }, d],
            }]));
        }
      }
    }
  }

  /* ── separators that LOOK like line breaks and are not ────────────────────
   * U+2028, U+2029 and form feed are not line endings in CommonMark and are not
   * normalised by the renderer either, so a fence "after" one is not a fence to
   * EITHER side. The case is here so that stays a tested agreement rather than an
   * assumption: the region is authored inside notes and may be folded, but it must
   * never split into a block on one side and not the other. */
  for (const [tag, sep] of [['ls', ' '], ['ps', ' '], ['ff', '\f']]) {
    for (const ch of CORPUS_CHARS) {
      const a = T(), b = T(), c = T();
      const F = ch.repeat(4);
      cases.push({
        id: `sep/${CHAR_TAG[ch]}/${tag}`,
        shape: 'separator',
        eol: 'lf',
        text: `${a}\n${F}orchard-notes\n${b}${sep}${F}orchard-answer${sep}${c}\n${F}\n`,
        tokens: [
          { tok: a, mustBeVisible: true },
          { tok: b, mustBeVisible: false },
          { tok: c, mustBeVisible: false },
        ],
        // WELL-FORMED: there is exactly one fence pair here. The `orchard-answer`
        // run is mid-line to both sides, so it is notes prose, and the parse must be
        // silent about it — flagging it would be the false-positive class again.
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: `${b}${sep}${F}orchard-answer${sep}${c}` }],
      });
    }
  }

  /* ── INERT CONSTRUCT 2: INDENTED CODE (4+ columns) ────────────────────────
   * The documented escape hatch for an `orchard-*` example inside notes, and the
   * one inert construct the grammar gets for free (an opener is only recognised at
   * 0-3 columns, and an indented code block contains no line at 0-3 columns). "For
   * free" is exactly the kind of claim that turns out to be false one round later,
   * so these carry the STRONG assertion: an exact parse AND an empty malformed
   * list, for both fence characters and for a reserved inner name. */
  for (const ch of CORPUS_CHARS) {
    for (const inner of ['orchard-answer', 'orchard-notes', 'markdown']) {
      for (const ind of ['    ', '\t']) {
        const a = T(), b = T(), c = T(), d = T(), e = T();
        const F3 = ch.repeat(3);
        const body = [b, `${ind}${F3}${inner}`, `${ind}${c}`, `${ind}${F3}`, d];
        cases.push({
          id: `icode/${CHAR_TAG[ch]}/${inner}/${ind === '\t' ? 'tab' : 'sp4'}`,
          shape: 'icode',
          eol: 'lf',
          text: [a, '````orchard-notes', ...body, '````', e].join('\n'),
          tokens: [
            { tok: a, mustBeVisible: true },
            { tok: b, mustBeVisible: false },
            { tok: c, mustBeVisible: false },
            { tok: d, mustBeVisible: false },
            { tok: e, mustBeVisible: true },
          ],
          wellFormed: true,
          expected: [{ name: 'orchard-notes', content: body.join('\n') }],
        });
      }
    }
    // The same construct at TOP level: a whole indented `orchard-*` example is
    // literal text, so it yields NO blocks and no flags at all.
    const a = T(), b = T(), c = T();
    cases.push({
      id: `icode/${CHAR_TAG[ch]}/top-level`,
      shape: 'icode',
      eol: 'lf',
      text: [a, '', `    ${ch.repeat(4)}orchard-notes`, `    ${b}`, `    ${ch.repeat(4)}`, '', c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [],
    });
  }

  /* ── INERT CONSTRUCT 3: HTML BLOCKS — THE SEVEN START CONDITIONS ──────────
   * Round 4 shipped these unmodelled with the argument that "the residual is
   * bounded by C1". It was bounded in the direction that does not hide (an
   * `orchard-answer` inside an existing fold) and wide open in the direction that
   * does: an HTML wrapper CREATING a fold that should not exist. Round 5 modelled
   * them with ONE loose predicate (`<` then `! ? / letter`) and called the
   * resulting over-recognition free. Round 6 found what that costs: a bare `<b` on
   * its own line — ordinary prose, satisfying no start condition — inerted the
   * `orchard-notes` block written under it. Well-formed input got a false
   * `inert-html:` flag and the block vanished from `blocks` entirely.
   *
   * So the dimension is now the SEVEN CONDITIONS THEMSELVES, each with its start
   * and its end asserted rather than assumed:
   *   - `html5/wrap/*`  — a notes/answer example wrapped in each HTML-block kind
   *     that really spans lines (types 1,2,3,5,6,7) must NOT become a fold, under
   *     both fence characters, and must be REPORTED (`inert-html:`), never silent.
   *   - `html5/end/*` — each condition's OWN terminator ends the region there and
   *     not later: the block written after the close line is LIVE.
   *   - `html5/precise/*` — the other direction, which is what stops the fix from
   *     degenerating into "inert everything after a `<`": a one-line `<!DOCTYPE>`
   *     or `<!-- x -->`, and a type-6 block ENDED by a blank line, leave the block
   *     written under them LIVE. Well-formed, exact parse, total silence.
   *   - `html5/prose/*` — THE ROUND-6 STRATUM. Ordinary prose that merely LOOKS
   *     like HTML: incomplete tags (`<b`, `<div ` mid-sentence), comparisons
   *     (`<= 5`, `x < y`), arrows (`<-`), generics (`Array<string>`), autolinks,
   *     inline tags with trailing text. Every one of these must leave a genuine
   *     notes block intact and report NOTHING. Each line here was checked against
   *     the CommonMark 0.31.2 reference implementation, which agrees it is not an
   *     HTML block start.
   *   - `html5/para7/*` — condition 7 is the only one that may not interrupt a
   *     paragraph. A complete tag alone on a line after a blank IS inert; the same
   *     line directly under paragraph text is NOT. Both pinned, since honouring
   *     the clause is what keeps `<b>` in a sentence-continuation from inerting.
   *   - `html5/dangle` — an HTML region whose blank-line end would land inside a
   *     still-open fence. The region must extend to the fence's close; ending
   *     early would let inertness CREATE a fold, which is the whole failure mode.
   *   - `html/opener`, `html/plain` — kept from round 4: C1 still fires on an
   *     HTML-wrapped reserved opener INSIDE a fold (the guard stays construct-
   *     blind), and HTML around ordinary notes narration still folds with it. */
  {
    // Wrappers that genuinely span lines. `[tag, open, close, blankFirst]`; the
    // close line is part of the region for terminator kinds and irrelevant for
    // blank-line kinds. `blankFirst` is condition 7's paragraph rule: a complete
    // tag alone on a line only starts a block when no paragraph is open, so the
    // type-7 wrapper is preceded by a blank line. That is not a workaround, it is
    // the condition — `html5/para7/*` below pins the other side of it.
    const WRAPPERS = [
      ['t6-div', '<div>', '</div>', false],
      ['t6-table', '<table>', '</table>', false],
      ['t6-attrs', '<section class="x" data-y="z">', '</section>', false],
      ['t6-close', '</div>', '<div>', false],
      ['t7-custom', '<my-widget>', '</my-widget>', true],
      ['t7-attrs', '<x-y a=1 b="2" c=\'3\'>', '</x-y>', true],
      ['t1-pre', '<pre>', '</pre>', false],
      ['t1-script', '<script type="text/plain">', '</script>', false],
      ['t2-comment', '<!--', '-->', false],
      ['t3-pi', '<?php', '?>', false],
      ['t5-cdata', '<![CDATA[', ']]>', false],
    ];
    for (const [tag, open, close, blankFirst] of WRAPPERS) {
      for (const ch of CORPUS_CHARS) {
        for (const inner of ['orchard-notes', 'orchard-answer', 'orchard-futurething']) {
          const a = T(), b = T(), c = T();
          const F = ch.repeat(4);
          const lead = blankFirst ? [a, ''] : [a];
          cases.push({
            id: `html5/wrap/${tag}/${CHAR_TAG[ch]}/${inner}`,
            shape: 'html5',
            eol: 'lf',
            // No blank lines INSIDE: the wrapper is what must make this literal.
            text: [...lead, open, `${F}${inner}`, b, F, close, c].join('\n'),
            tokens: [
              { tok: a, mustBeVisible: true },
              { tok: b, mustBeVisible: true },  // THE DEFECT: this folded, round 4.
              { tok: c, mustBeVisible: true },
            ],
            wellFormed: false, // an inert-html report is expected, and asserted below
            expected: [],
            expectedFlags: [`inert-html:${inner}@line${lead.length + 2}`],
          });
        }
      }
    }

    // EACH CONDITION'S END, asserted separately from its start. The region must
    // stop at the kind's own terminator (types 1-5) or the first blank line
    // (types 6-7), so a block written AFTER the close line is live. Round 5
    // asserted this only for the two one-line kinds; a terminator that never fired
    // would have swallowed the rest of the message unnoticed.
    for (const [tag, open, close] of [
      ['t1-pre', '<pre>', '</pre>'],
      ['t1-script', '<script>', '</script>'],
      ['t1-style', '<style>', '</style>'],
      ['t1-textarea', '<textarea>', '</textarea>'],
      ['t2-comment', '<!--', '-->'],
      ['t3-pi', '<?php', '?>'],
      ['t4-decl', '<!ENTITY foo', '"bar">'],
      ['t5-cdata', '<![CDATA[', ']]>'],
      ['t6-blank', '<div>', ''],
      ['t7-blank', '<my-widget>', ''],
    ]) {
      const a = T(), b = T(), c = T();
      cases.push({
        id: `html5/end/${tag}`,
        shape: 'html5',
        eol: 'lf',
        // A blank line before the opener so condition 7 is legal for every kind.
        text: [a, '', open, 'inert body', close, '````orchard-notes', b, '````', c].join('\n'),
        tokens: [
          { tok: a, mustBeVisible: true },
          { tok: b, mustBeVisible: false }, // the region ENDED: this is a real fold
          { tok: c, mustBeVisible: true },
        ],
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: b }],
        expectedFlags: [],
      });
    }

    // PRECISION, the other direction. An HTML construct that does NOT span must
    // not sterilise what follows it — otherwise "model HTML blocks" quietly became
    // "give up on any message containing a `<`", and a real notes block would stop
    // folding. Exact parse AND silence.
    for (const [tag, lead] of [['doctype', '<!DOCTYPE html>'], ['comment-1line', '<!-- an aside -->'],
      ['cdata-1line', '<![CDATA[x]]>'], ['pi-1line', '<?xml version="1.0"?>'],
      ['blankline-ends-t6', '<div>\n'], ['not-a-tag-lt', '<= 5 items'], ['not-a-tag-arrow', '<- see above']]) {
      const a = T(), b = T(), c = T();
      cases.push({
        id: `html5/precise/${tag}`,
        shape: 'html5',
        eol: 'lf',
        text: [a, lead, '````orchard-notes', b, '````', c].join('\n'),
        tokens: [
          { tok: a, mustBeVisible: true },
          { tok: b, mustBeVisible: false }, // a REAL fold: nothing made this literal
          { tok: c, mustBeVisible: true },
        ],
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: b }],
        expectedFlags: [],
      });
    }

    /* ── ORDINARY PROSE THAT MERELY RESEMBLES HTML (round 6) ────────────────
     * The stratum the over-recognition defect walked straight through. Every line
     * below is prose a person actually writes, and NONE of them is a CommonMark
     * HTML-block start — checked against the 0.31.2 reference implementation, not
     * asserted. Each must leave the notes block under it intact and flag NOTHING.
     * Run at the very start of the message AND directly under paragraph text,
     * because condition 7's paragraph clause makes those two different contexts. */
    const PROSE_LOOKALIKES = [
      ['bare-lt-letter', '<b'],                            // THE round-6 defect
      ['bare-lt-word', '<div'],                            // ...but `<div` alone IS type 6
      ['lt-letter-sentence', '<b in a sentence about HTML'],
      ['two-comparisons', 'a <b and b <c'],
      ['generic', 'Array<string>'],
      ['generic-two-args', 'Map<string, number> is the type'],
      ['comparison', 'if x < y then swap them'],
      ['lte', '<= 5 items'],
      ['arrow', '<- see above'],
      ['heart', '<3'],
      ['lone-lt', '<'],
      ['empty-tag', '<>'],
      ['space-then-tag', '< div>'],
      ['digit-name', '<1abc>'],
      ['autolink-url', '<https://example.com/docs>'],
      ['autolink-mail', '<foo@example.com>'],
      ['inline-tag-then-text', '<b>bold</b> inline'],
      ['inline-tag-trailing', '<b> and then more text'],
      ['open-tag-trailing', '<my-widget>tail'],
      ['bad-attr', '<a href=>'],
      ['bang-alone', '<!'],
      ['double-slash', '<//'],
      ['underscore-name', '<_x>'],
    ];
    for (const [tag, lead] of PROSE_LOOKALIKES) {
      for (const [ctx, pre] of [['fresh', []], ['para', ['Ordinary paragraph text.']]]) {
        // `<div` bare is condition 6 (tag name then end of line), so it is the one
        // entry here that IS inert. Kept in the list on purpose: the boundary
        // between `<div` and `<b` is exactly the thing the loose predicate blurred.
        const inert = tag === 'bare-lt-word';
        const a = T(), b = T(), c = T();
        const flagLine = pre.length + 3;
        cases.push({
          id: `html5/prose/${tag}/${ctx}`,
          shape: 'html5',
          eol: 'lf',
          text: [...pre, a, lead, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [
            { tok: a, mustBeVisible: true },
            // Not inert -> the notes block is REAL, so `b` folds (correctly).
            // Inert -> the fence was literal text, so `b` renders visible.
            { tok: b, mustBeVisible: inert },
            { tok: c, mustBeVisible: true },
          ],
          wellFormed: !inert,
          expected: inert ? [] : [{ name: 'orchard-notes', content: b }],
          expectedFlags: inert ? [`inert-html:orchard-notes@line${flagLine}`] : [],
        });
      }
    }

    /* ── CONDITION 7 MAY NOT INTERRUPT A PARAGRAPH ──────────────────────────
     * The one asymmetry among the seven, and the reason a stray `<b>` closing a
     * sentence does not sterilise the rest of the message. After a blank line the
     * same tag IS a block start. Both directions pinned, since dropping the clause
     * would have been the convenient choice and is the over-recognising one. */
    for (const [tag, tagLine] of [['open-custom', '<my-widget>'], ['close-custom', '</my-widget>'],
      ['open-span', '<span>'], ['open-attr', '<a href="x">'], ['selfclose', '<img src="a" />']]) {
      {
        const a = T(), b = T(), c = T();
        cases.push({
          id: `html5/para7/after-blank-is-inert/${tag}`,
          shape: 'html5',
          eol: 'lf',
          text: [a, '', tagLine, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
          wellFormed: false,
          expected: [],
          expectedFlags: ['inert-html:orchard-notes@line4'],
        });
      }
      {
        const a = T(), b = T(), c = T();
        cases.push({
          id: `html5/para7/in-paragraph-is-live/${tag}`,
          shape: 'html5',
          eol: 'lf',
          text: [a, tagLine, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: [{ name: 'orchard-notes', content: b }],
          expectedFlags: [],
        });
      }
    }

    /* ── PARAGRAPH CONTEXT: EVERY KIND OF BLOCK ABOVE A CONDITION-7 TAG ─────
     * THE ROUND-7 STRATUM, and the one the previous round could not have had.
     * Condition 7 is the only start condition that may not interrupt a paragraph,
     * so whether a complete tag on its own line is LITERAL depends entirely on
     * what is above it. Round 6 modelled "above it" as one boolean set by any
     * non-blank line, and called the resulting under-recognition of condition 7
     * the safe side because it errs toward not-inert. It is not the safe side: an
     * `# ATX heading` above a complete tag kept the flag set, the region was not
     * treated as literal, and the `orchard-notes` EXAMPLE inside it became a real
     * CLOSED fold — invisible in the render and in the accessibility tree, with an
     * EMPTY malformed list. The round-6 `para7` stratum had exactly two contexts
     * (a blank line, and paragraph text), so nine further shapes were open.
     *
     * The dimension is therefore the CONTEXT ITSELF: every construct that can
     * precede the tag, crossed with the tag kinds. `paragraphOpen` below is not
     * asserted from the grammar — it is the CommonMark 0.31.2 REFERENCE
     * IMPLEMENTATION's verdict for that exact context, read off the reference AST
     * (does an html_block cover the fence line), so this table is an oracle
     * transcript and not a restatement of the parser's own opinion. */
    const PARA_CONTEXTS = [
      ['none', [], false],
      ['paragraph', ['Ordinary paragraph text.'], true],
      ['paragraph-two-lines', ['Line one of prose.', 'Line two of prose.'], true],
      ['blank', [''], false],
      ['prose-then-blank', ['Prose.', ''], false],
      ['atx-h1', ['# Completed heading'], false],   // THE ROUND-7 DEFECT
      ['atx-h2', ['## Completed heading'], false],
      ['atx-h3', ['### h'], false],
      ['atx-h4', ['#### h'], false],
      ['atx-h5', ['##### h'], false],
      ['atx-h6', ['###### h'], false],
      ['atx-closed-seq', ['## Done ##'], false],
      ['atx-empty', ['#'], false],
      ['atx-indent3', ['   # h'], false],
      ['atx-after-prose', ['Prose.', '# h'], false],
      ['not-atx-7hashes', ['####### seven'], true],   // 7 hashes is not a heading
      ['not-atx-hashtag', ['#hashtag'], true],        // no space: not a heading
      ['tbreak-dash', ['---'], false],
      ['tbreak-star', ['***'], false],
      ['tbreak-underscore', ['___'], false],
      ['tbreak-spaced', ['* * *'], false],
      ['tbreak-long', ['-----'], false],
      ['tbreak-indent3', ['   ***'], false],
      ['tbreak-after-prose', ['Prose.', '***'], false],
      ['setext-h1', ['Title', '==='], false],
      ['setext-h2', ['Title', '---'], false],
      ['setext-single-eq', ['Title', '='], false],
      ['setext-single-dash', ['Title', '-'], false],
      ['fence-backtick-closed', ['```js', 'x', '```'], false],
      ['fence-tilde-closed', ['~~~', 'x', '~~~'], false],
      ['fence-info-closed', ['```markdown', 'x', '```'], false],
      ['fence-after-prose', ['Prose.', '```', 'x', '```'], false],
      ['html-t6-closed', ['<div>', 'x', '</div>', ''], false],
      ['html-t6-blankended', ['<div>', 'x', ''], false],
      ['html-comment-1line', ['<!-- an aside -->'], false],
      ['html-doctype', ['<!DOCTYPE html>'], false],
      ['html-cdata-1line', ['<![CDATA[x]]>'], false],
      ['html-pi-1line', ['<?xml version="1.0"?>'], false],
      ['html-pre-closed', ['<pre>', 'x', '</pre>'], false],
      ['icode-4sp', ['    code line'], false],
      ['icode-tab', ['\tcode line'], false],
      ['icode-after-blank', ['', '    code line'], false],
      // Indented code CANNOT interrupt a paragraph: this is continuation text.
      ['icode-after-prose', ['Prose.', '    continuation'], true],
      // LAZY CONTINUATION: an unprefixed line continues a container's paragraph.
      ['quote-text', ['> quoted text'], true],
      ['quote-empty', ['>'], false],
      ['quote-tight', ['>quoted'], true],
      ['quote-nested', ['> > deep'], true],
      ['quote-heading', ['> # quoted heading'], false],
      ['quote-blank-after', ['> quoted', ''], false],
      ['list-dash-text', ['- item text'], true],
      ['list-star-text', ['* item text'], true],
      ['list-plus-text', ['+ item text'], true],
      ['list-ordered-text', ['1. item text'], true],
      ['list-ordered-paren', ['1) item text'], true],
      ['list-empty-dash', ['-'], false],
      ['list-empty-star', ['*'], false],
      ['list-empty-ordered', ['1.'], false],
      ['list-then-blank', ['- item', ''], false],
      ['list-nested', ['- - deep item'], true],
      ['list-heading', ['- # listed heading'], false],
      // A link reference definition is extracted FROM a paragraph, so a type-7
      // line under one is continuation text, not a block start.
      ['linkref', ['[ref]: /url'], true],
      ['linkref-title', ['[ref]: /url "t"'], true],
      // ROUND 10 — a definition may span LINES: label, destination and title may
      // each sit on its own. The reference resolves the whole thing out of the
      // paragraph at a setext underline, leaving nothing to underline, so no
      // heading is made and the paragraph stays OPEN. Reading a definition one
      // line at a time made `===` a heading, closed the paragraph, let condition
      // 7 fire, and LOST a well-formed fold while flagging valid input.
      ['linkref-multiline-dest', ['[ref]:', '/url'], true],
      ['linkref-multiline-dest-setext', ['[ref]:', '/url', '==='], true],
      ['linkref-multiline-title-setext', ['[ref]: /url', '"t"', '==='], true],
      ['linkref-all-three-lines', ['[ref]:', '/url', '"t"', '==='], true],
      ['linkref-multiline-label', ['[a', 'b]: /url', '==='], true],
      ['linkref-title-over-two-lines', ['[ref]: /url "a', 'b"', '==='], true],
      // ...and the other direction, which must NOT become all-refs: a title that
      // does not end its line is discarded, text after the definition remains,
      // and the underline IS a heading — so the paragraph closes and the fence
      // below is literal. Getting this wrong would HIDE content.
      ['linkref-title-not-at-line-end', ['[ref]: /url', '"t" x', '==='], false],
      ['linkref-dest-then-text', ['[ref]:', '/url', 'text', '==='], false],
      ['linkref-incomplete-setext', ['[ref]:', '==='], false],
      ['linkref-blank-breaks-it', ['[ref]:', '', '/url', '==='], false],
      ['linkref-tab-before-dest', ['[ref]:\t/url', '==='], false],
      ['linkref-two-multiline', ['[a]:', '/u1', '[b]:', '/u2', '==='], true],
      ['table-row', ['| a | b |', '| - | - |'], true],
      ['trailing-spaces-prose', ['Prose with trailing spaces.   '], true],
      ['hardbreak-prose', ['Prose with a hard break.\\'], true],
      ['prose-then-quote', ['Prose.', '> quoted'], true],
      ['prose-then-list', ['Prose.', '- item'], true],
      ['prose-then-icode', ['Prose.', '    code'], true],
      ['prose-then-fence', ['Prose.', '```', 'x', '```'], false],
      ['prose-then-html-t6', ['Prose.', '<div>', 'x', '</div>', ''], false],
      ['heading-then-prose', ['# h', 'Prose.'], true],
      ['heading-then-blank', ['# h', ''], false],
      ['tbreak-then-prose', ['***', 'Prose.'], true],
    ];
    /* Tag lines. `kind` is what decides inertness GIVEN the context:
     *   'p7'   — a complete tag alone on the line: inert iff no paragraph is open.
     *   'any'  — condition 6, which MAY interrupt a paragraph: always inert.
     *   'none' — prose that merely resembles HTML: never inert, in any context.
     * All three kinds run against all 73 contexts, so the paragraph clause is
     * asserted to apply to condition 7 ONLY — a fix that dropped the clause, or
     * applied it to every condition, fails on a different third of this stratum. */
    const PARA_TAGS = [
      ['t7-open-custom', '<my-widget>', 'p7'],
      ['t7-close-custom', '</my-widget>', 'p7'],
      ['t7-open-span', '<span>', 'p7'],
      ['t7-attr', '<a href="x">', 'p7'],
      ['t7-selfclose', '<img src="a" />', 'p7'],
      ['t6-div', '<div>', 'any'],
      ['prose-generic', 'Array<string>', 'none'],
    ];
    for (const [ctxId, ctx, paragraphOpen] of PARA_CONTEXTS) {
      for (const [tagId, tagLine, kind] of PARA_TAGS) {
        const inert = kind === 'any' || (kind === 'p7' && !paragraphOpen);
        const b = T(), c = T();
        const fenceLine = ctx.length + 2; // 1-based line of the notes opener
        cases.push({
          id: `para/${ctxId}/${tagId}`,
          shape: 'para',
          eol: 'lf',
          // No leading token: a token line ABOVE the context would change the
          // context, which is the entire variable under test.
          text: [...ctx, tagLine, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [
            // Inert -> the fence was an EXAMPLE inside a literal region, so the
            // body must reach the reader. Live -> a genuine fold.
            { tok: b, mustBeVisible: inert },
            { tok: c, mustBeVisible: true },
          ],
          wellFormed: !inert,
          expected: inert ? [] : [{ name: 'orchard-notes', content: b }],
          expectedFlags: inert ? [`inert-html:orchard-notes@line${fenceLine}`] : [],
        });
      }
    }

    /* ── CONTAINER CONTEXT: THE SAME QUESTION, INSIDE QUOTES AND LISTS ──────
     * THE ROUND-8 STRATUM. Round 7 fixed the paragraph rule for TOP-LEVEL
     * contexts and recorded that its container handling was "one level deep" and
     * approximate — the fourth round running in which a documented limitation was
     * the next verdict. It was:
     *
     *     -     code
     *     <my-widget>
     *     ````orchard-notes
     *     ADVERSARIAL-MUST-BE-VISIBLE
     *     ````
     *     </my-widget>
     *
     * A list marker followed by FIVE spaces makes the item's content INDENTED
     * CODE, not a paragraph, so nothing is open when `<my-widget>` arrives and the
     * region is literal. Round 7's prefix-stripping regex ate the spaces greedily,
     * saw a paragraph, suppressed condition 7, and folded the authored example
     * away with an EMPTY malformed list.
     *
     * So the CONTAINER STACK is a dimension: quote and list markers at depth 1-3,
     * every content indentation from 1 space to past the indented-code threshold,
     * continuation by indentation, lazy continuation, blank lines inside a
     * container, and setext / heading / thematic-break / fence / HTML leaves
     * inside one. `paragraphOpen` is again the CommonMark 0.31.2 REFERENCE
     * IMPLEMENTATION's verdict for that exact context, read off its AST, so this
     * table is an oracle transcript and not the parser's opinion of itself. The
     * live differential over a much wider container space (with the reference as
     * oracle rather than this transcript) is the `[1d]` leg of the verifier. */
    const CONTAINER_CONTEXTS = [
      ['li-content-icode-5sp', ['-     code'], false],       // THE ROUND-8 DEFECT
      ['li-content-icode-6sp', ['-      code'], false],
      ['li-content-icode-ord', ['1.     code'], false],
      ['li-content-icode-star', ['*     code'], false],
      ['li-content-1sp', ['- item text'], true],
      ['li-content-2sp', ['-  item text'], true],
      ['li-content-4sp', ['-    item text'], true],
      ['li-tab-marker', ['-\titem text'], true],
      ['li-cont-indented', ['- item', '  more text'], true],
      ['li-cont-icode', ['- item', '      code'], true],
      ['li-lazy-cont', ['- item', 'lazy text'], true],
      ['li-blank-then-cont', ['- item', '', '  more text'], true],
      ['li-nested-2', ['- - deep item'], true],
      ['li-nested-3', ['- - - deepest item'], true],
      ['li-nested-icode', ['- -     code'], false],
      ['li-indent3-marker', ['   - item text'], true],
      ['li-setext-inside', ['- Title', '  ==='], false],
      ['li-fence-inside', ['- item', '  ```', '  x', '  ```'], false],
      ['li-html-inside', ['- <div>', '  x', ''], false],
      ['li-heading-inside', ['- item', '  # h'], false],
      ['li-tbreak-inside', ['- item', '  ***'], false],
      ['q-icode', ['>     code'], false],
      ['q-text', ['> quoted text'], true],
      ['q-nested-2', ['> > deep quote'], true],
      ['q-nested-3', ['> > > deepest quote'], true],
      ['q-nested-icode', ['> >     code'], false],
      ['q-blank-marker', ['> quoted', '>'], false],
      ['q-setext-inside', ['> Title', '> ==='], false],
      ['q-heading-inside', ['> # h'], false],
      ['q-fence-inside', ['> ```', '> x', '> ```'], false],
      ['q-lazy-cont', ['> quoted', 'lazy text'], true],
      ['q-in-list', ['- > listed quote'], true],
      ['list-in-q', ['> - quoted item'], true],
      ['list-in-q-icode', ['> -     code'], false],
      ['q-list-deep', ['> - > - deep mix'], true],
      ['li-ord-9digit', ['123456789. item'], true],
      // A non-1 ordered marker may not interrupt a paragraph: continuation text.
      ['li-ord-not-1-after-prose', ['Prose.', '2. item'], true],
      // ...and `-` alone under a paragraph is a SETEXT UNDERLINE, not an empty
      // list item, so it CLOSES the paragraph. Both interrupt rules, both ways.
      ['li-empty-after-prose', ['Prose.', '-'], false],
      ['q-after-prose', ['Prose.', '> quoted'], true],
    ];
    for (const [ctxId, ctx, paragraphOpen] of CONTAINER_CONTEXTS) {
      for (const [tagId, tagLine, kind] of PARA_TAGS) {
        const inert = kind === 'any' || (kind === 'p7' && !paragraphOpen);
        const b = T(), c = T();
        const fenceLine = ctx.length + 2;
        cases.push({
          id: `container/${ctxId}/${tagId}`,
          shape: 'container',
          eol: 'lf',
          text: [...ctx, tagLine, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [
            { tok: b, mustBeVisible: inert },
            { tok: c, mustBeVisible: true },
          ],
          wellFormed: !inert,
          expected: inert ? [] : [{ name: 'orchard-notes', content: b }],
          expectedFlags: inert ? [`inert-html:orchard-notes@line${fenceLine}`] : [],
        });
      }
    }

    /* ── THE TAG GRAMMAR ITSELF, per condition ─────────────────────────────
     * ROUND 8's SECOND DEFECT, found by the reference differential rather than by
     * a clean room. Condition 7 carried a `reject` for the four type-1 tag names
     * in EITHER form, on a reading of the spec prose that the reference does not
     * share: the conditions are tried IN ORDER, so `<pre>` is already condition 1
     * and never reaches 7, and what the reject actually removed was the COMPLETE
     * CLOSING TAGS `</pre>` `</script>` `</style>` `</textarea>` and the
     * self-closing `<pre/>` — every one of which the reference makes a condition-7
     * HTML block. A message opening with a lone `</pre>` therefore had a literal
     * region this module called LIVE, and an example under it became a real fold.
     * The hiding direction; fixed, not documented.
     *
     * The other half is `<source>`, which 0.31.2 removed from condition 6's tag
     * list: this module carried a 0.30/0.31.2 UNION, so `<source>` under a
     * paragraph was inert here and live to the reference — over-recognition, the
     * round-6 class. Now one pinned revision, asserted in BOTH contexts.
     * Every verdict below is the reference's, read off its AST. */
    const TAG_CONDITION_CASES = [
      // [tagLine, inert-when-fresh, inert-under-a-paragraph]
      ['</pre>', true, false],           // condition 7, both ways: THE FIX
      ['</script>', true, false],
      ['</style>', true, false],
      ['</textarea>', true, false],
      ['</PRE>', true, false],           // case-insensitive, same verdict
      ['<pre/>', true, false],           // not condition 1 (no ws/`>` after name)
      ['<pre>', true, true],             // condition 1: interrupts a paragraph
      ['<pre a="1">', true, true],
      ['<script>', true, true],
      ['<source>', true, false],         // 0.31.2: NOT condition 6 -> condition 7
      ['<source src="a">', true, false],
      ['</source>', true, false],
      ['<search>', true, true],          // 0.31.2 ADDED this one to condition 6
      ['<a\fhref="x">', true, false],    // `\s` in the attribute grammar, not [ \t]
      ['<a href="x"\f>', true, false],
      ['<my-widget >', true, false],
      ['<my-widget> ', true, false], // condition 7's trailing `\s*$`
    ];
    TAG_CONDITION_CASES.forEach(([tagLine, inertFresh, inertPara], tagIdx) => {
      for (const [ctxId, ctx, inert] of [['fresh', [], inertFresh],
        ['para', ['Ordinary paragraph text.'], inertPara]]) {
        const b = T(), c = T();
        const fenceLine = ctx.length + 2;
        cases.push({
          id: `tagcond/${ctxId}/${tagIdx}-${tagLine.replace(/[^\w-]/g, '_')}`,
          shape: 'tagcond',
          eol: 'lf',
          text: [...ctx, tagLine, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [{ tok: b, mustBeVisible: inert }, { tok: c, mustBeVisible: true }],
          wellFormed: !inert,
          expected: inert ? [] : [{ name: 'orchard-notes', content: b }],
          expectedFlags: inert ? [`inert-html:orchard-notes@line${fenceLine}`] : [],
        });
      }
    });

    /* THE DELIBERATE OMISSIONS, each pinned so it cannot hide.
     * The header enumerates what the container model does NOT implement. An
     * omission is only allowed to exist if a test shows it cannot fold authored
     * content away, so each one is a case here rather than a sentence in a doc. */
    {
      // (a) LIST TIGHTNESS / two blank lines closing a list, and (b) a list-type
      // change starting a new list. Neither is modelled; both must leave the notes
      // block LIVE (nothing literal is involved), which is what the reference says.
      for (const [id, ctx] of [
        ['two-blanks-in-list', ['- item', '', '', '  after two blanks']],
        ['list-type-change', ['- dash item', '* star item']],
        ['ordered-restart', ['1. one', '1. one again']],
      ]) {
        const b = T(), c = T();
        cases.push({
          id: `container/omission/${id}`,
          shape: 'container',
          eol: 'lf',
          text: [...ctx, '````orchard-notes', b, '````', c].join('\n'),
          tokens: [{ tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: [{ name: 'orchard-notes', content: b }],
          expectedFlags: [],
        });
      }
      // (c) A LINK REFERENCE DEFINITION can end a paragraph; it is treated as
      // paragraph text, so a paragraph stays OPEN — the not-inert direction, which
      // leaves the fence LIVE. Pinned inside a container, where it is new.
      for (const [id, ctx] of [
        ['linkref-in-list', ['- [ref]: /url']],
        ['linkref-in-quote', ['> [ref]: /url "t"']],
        // ROUND 10 — the MULTI-LINE form inside a container, including the LAZY
        // one, where the destination line does not carry the quote marker at all
        // and is still part of the same definition.
        ['linkref-multiline-in-quote', ['> [ref]:', '> /url', '> ===']],
        ['linkref-multiline-lazy-in-quote', ['> [ref]:', '/url', '> ===']],
        ['linkref-multiline-in-list', ['- [ref]:', '  /url', '  ===']],
      ]) {
        const b = T(), c = T();
        cases.push({
          id: `container/omission/${id}`,
          shape: 'container',
          eol: 'lf',
          text: [...ctx, '<my-widget>', '````orchard-notes', b, '````', c].join('\n'),
          tokens: [{ tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: [{ name: 'orchard-notes', content: b }],
          expectedFlags: [],
        });
      }
      // (d) A FENCE INSIDE A CONTAINER. Round 8 recorded these as the
      // under-recognition that was left ("a fence behind a `>` marker or at 4+
      // raw columns is not an opener to this module at all... that cannot hide
      // anything"). Round 9's randomised differential falsified the reasoning:
      // the top-level scan recognised fences and HTML starts at 0-3 RAW columns,
      // so inside a list item whose content column is 2 it saw the FENCE and
      // missed the HTML block ABOVE it — under-recognising the LITERALISER while
      // still recognising the fence, which folds authored content away. There is
      // now ONE detection, in container context, so:
      //   - a fence behind `>` markers, or at the content column of a list item,
      //     IS an opener — which is exactly what the reference says (`> ````
      //     orchard-notes` parses to a fenced code block with that info string);
      //   - a fence at 4+ columns of its container's OWN content indent is
      //     indented code to both sides, so it is still not an opener.
      for (const [id, pre, live] of [
        ['fence-behind-quote-marker', '> ', true],
        ['fence-behind-nested-quote', '> > ', true],
        ['fence-at-4-columns', '    ', false],
        ['fence-at-6-columns', '      ', false],
      ]) {
        const b = T(), c = T();
        cases.push({
          id: `container/omission/${id}`,
          shape: 'container',
          eol: 'lf',
          text: [`${pre}\`\`\`\`orchard-notes`, `${pre}${b}`, `${pre}\`\`\`\``, c].join('\n'),
          tokens: [{ tok: b, mustBeVisible: !live }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: live ? [{ name: 'orchard-notes', content: `${pre}${b}` }] : [],
          expectedFlags: [],
        });
      }
    }

    // The region's blank-line end lands INSIDE an open fence. Round 5 extended the
    // region past the blank line in that case, reasoning that inertness must be
    // monotone. The reference says otherwise and round 9 follows it: a type-6 HTML
    // block ends at the FIRST BLANK LINE, full stop — a ``` inside it is literal
    // text, not an open fence — so the `orchard-notes` fence after the blank IS a
    // real block and folding its body is what the author asked for. Keeping the
    // extension made a false `inert-html:` on legal input (round 6's class), which
    // is what the randomised differential caught. The case stays, with the
    // reference's verdict.
    for (const ch of CORPUS_CHARS) {
      const a = T(), b = T(), c = T();
      const F3 = ch.repeat(3), F4 = ch.repeat(4);
      cases.push({
        id: `html5/dangle/${CHAR_TAG[ch]}`,
        shape: 'html5',
        eol: 'lf',
        text: [a, '<div>', `${F3}text`, '', `${F4}orchard-notes`, b, F4, F3, c].join('\n'),
        tokens: [
          { tok: a, mustBeVisible: true },
          { tok: b, mustBeVisible: false },
          { tok: c, mustBeVisible: true },
        ],
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: b }],
        expectedFlags: [],
      });
    }
  }
  {
    const a = T(), b = T(), c = T(), d = T(), e = T();
    cases.push(makeCase('html/opener', 'html', [
      a,
      {
        name: 'orchard-notes', len: 4, closed: true,
        body: [b, '<div>', { name: 'orchard-answer', len: 3, closed: true, body: [c] }, '</div>', d],
      },
      e,
    ]));
  }
  {
    const a = T(), b = T(), c = T(), d = T();
    cases.push({
      id: 'html/plain',
      shape: 'html',
      eol: 'lf',
      text: [a, '````orchard-notes', b, '<div>', c, '</div>', '````', d].join('\n'),
      tokens: [
        { tok: a, mustBeVisible: true },
        { tok: b, mustBeVisible: false },
        { tok: c, mustBeVisible: false },
        { tok: d, mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: [b, '<div>', c, '</div>'].join('\n') }],
    });
  }

  /* ── THE ROUND-5 OVER-RECOGNITION, NOW A REGRESSION TEST ──────────────────
   * Round 5 kept these two cases to state its over-recognition out loud: an
   * autolink line inerted the notes block under it, and the case asserted the
   * false flag as EXPECTED behaviour, on the argument that over-recognition is the
   * safe direction. It is safe against hiding and unsafe against everything else,
   * and asserting it made the corpus agree with the defect instead of catching it.
   * They are inverted here: an autolink is NOT an HTML block in CommonMark (the
   * reference implementation agrees), so the notes block is real, folds, and is
   * reported as nothing — with or without the blank line. If the loose predicate
   * ever comes back, these fail first. (`html5/prose/*` above generalises them.) */
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'html5/overreach/autolink-no-blank',
      shape: 'html5',
      eol: 'lf',
      text: [a, '<https://example.com/docs>', '````orchard-notes', b, '````', c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: b }],
      expectedFlags: [],
    });
  }
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'html5/overreach/autolink-blank-restores',
      shape: 'html5',
      eol: 'lf',
      text: [a, '<https://example.com/docs>', '', '````orchard-notes', b, '````', c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: b }],
      expectedFlags: [],
    });
  }

  /* ── CONTAINER CONTEXT 1: BLOCKQUOTES ─────────────────────────────────────
   * Carried as "not attempted" for three rounds, then pinned as deliberate
   * UNDER-recognition: a `>`-prefixed fence was not an opener to this module at
   * all. Round 9 retired that: the top-level scan now asks the SAME question the
   * line classifier does, of the line with its container prefix consumed, because
   * the two disagreeing is a hiding vector (see the module header). So a quoted
   * `orchard-notes` fence IS a block — which is what the reference says it is —
   * and its body keeps the authored `>` prefix verbatim, exactly as a fence inside
   * a list item keeps the item's indent. The quoted INERT WRAPPER case is the
   * control: a quoted ```markdown fence around a quoted example still makes it
   * literal, so recognising quoted fences did not turn documentation into folds. */
  for (const [qtag, q] of [['d1', '> '], ['d1tight', '>'], ['d2', '> > ']]) {
    for (const ch of CORPUS_CHARS) {
      const F4 = ch.repeat(4);
      {
        const a = T(), b = T(), c = T();
        cases.push({
          id: `bq/${qtag}/${CHAR_TAG[ch]}/quoted-notes`,
          shape: 'bq',
          eol: 'lf',
          text: [a, `${q}${F4}orchard-notes`, `${q}${b}`, `${q}${F4}`, c].join('\n'),
          tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: [{ name: 'orchard-notes', content: `${q}${b}` }],
          expectedFlags: [],
        });
      }
      {
        const a = T(), b = T(), c = T();
        const F3 = ch.repeat(3);
        cases.push({
          id: `bq/${qtag}/${CHAR_TAG[ch]}/quoted-inert-wrapper`,
          shape: 'bq',
          eol: 'lf',
          text: [a, `${q}${F3}markdown`, `${q}${F4}orchard-notes`, `${q}${b}`, `${q}${F4}`, `${q}${F3}`, c].join('\n'),
          tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
          wellFormed: true,
          expected: [],
          expectedFlags: [],
        });
      }
    }
  }
  {
    // The other direction: a quote does NOT sterilise what follows it. A fence at
    // column 0 after a quoted line is a real fence to CommonMark (a fenced block
    // interrupts a paragraph, so there is no lazy continuation) and to us.
    const a = T(), b = T(), c = T(), d = T();
    cases.push({
      id: 'bq/quote-then-top-level-fence-is-live',
      shape: 'bq',
      eol: 'lf',
      text: [a, `> ${b}`, '````orchard-notes', c, '````', d].join('\n'),
      tokens: [
        { tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true },
        { tok: c, mustBeVisible: false }, { tok: d, mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: c }],
      expectedFlags: [],
    });
  }

  /* ── CONTAINER CONTEXT 2: LIST ITEMS ──────────────────────────────────────
   * The other three-round carry-over, and the harder one, because a fence inside a
   * list item is PREFIXED by the item's content indent and its extent is easy to
   * get wrong. Three regimes, all enumerated rather than argued:
   *   - content indent 0-3 -> a REAL fence, to us and to CommonMark. It folds, and
   *     its content keeps the authored indent verbatim.
   *   - content indent 4+  -> not a fence to this module (an opener is recognised
   *     only at 0-3 columns). CommonMark, which measures indent relative to the
   *     item, would call it one; we UNDER-recognise, the whole example renders
   *     visible, and nothing can hide. Pinned, not assumed.
   *   - a fence run on the MARKER line, and an inert wrapper inside an item. */
  for (const marker of ['-', '*', '+', '1.', '10)']) {
    for (const ind of ['', ' ', '  ', '   ']) {
      const a = T(), b = T(), c = T();
      cases.push({
        id: `list/${marker}/ind${ind.length}/live-fence`,
        shape: 'list',
        eol: 'lf',
        text: [`${marker} ${a}`, `${ind}\`\`\`\`orchard-notes`, `${ind}${b}`, `${ind}\`\`\`\``, c].join('\n'),
        tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: `${ind}${b}` }],
        expectedFlags: [],
      });
    }
    {
      const a = T(), b = T(), c = T();
      // FOUR RAW COLUMNS INSIDE AN ITEM IS NOT INDENTED CODE. Round 8 read the
      // indent from column 0, called this an opener it does not recognise, and
      // pinned the under-recognition. The reference measures from the ITEM's
      // content column — 2 here — so `    ````orchard-notes` is a fence indented
      // two columns inside the item, i.e. a real block. Round 9 measures the same
      // way (see `restOfLine`), and the id is kept so the reversal is visible in
      // the diff rather than silent.
      cases.push({
        id: `list/${marker}/ind4/live-in-item`,
        shape: 'list',
        eol: 'lf',
        text: [`${marker} ${a}`, '    ````orchard-notes', `    ${b}`, '    ````', c].join('\n'),
        tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
        wellFormed: true,
        expected: [{ name: 'orchard-notes', content: `    ${b}` }],
        expectedFlags: [],
      });
    }
    {
      const b = T(), c = T();
      // A fence opened ON a list-marker line is a fence at the item's content
      // column — and its close, at column 0, is OUTSIDE the item, so it does not
      // close it. The reference agrees: the item's code block ends with the item
      // (empty), and the body token is a visible top-level paragraph. Round 8
      // reached the same visible outcome by not seeing the fence at all and
      // therefore said nothing; round 9 sees it and REPORTS the unterminated
      // fence, which is the whole point of the flag.
      cases.push({
        id: `list/${marker}/fence-on-the-marker-line`,
        shape: 'list',
        eol: 'lf',
        text: [`${marker} \`\`\`\`orchard-notes`, b, '````', c].join('\n'),
        tokens: [{ tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
        wellFormed: false,
        expected: [],
        expectedFlags: ['unterminated:orchard-notes@line1'],
      });
    }
  }
  for (const ch of CORPUS_CHARS) {
    const a = T(), b = T(), c = T();
    const F3 = ch.repeat(3), F4 = ch.repeat(4);
    cases.push({
      id: `list/inert-wrapper-in-item/${CHAR_TAG[ch]}`,
      shape: 'list',
      eol: 'lf',
      text: [`- ${a}`, `  ${F3}markdown`, `  ${F4}orchard-notes`, `  ${b}`, `  ${F4}`, `  ${F3}`, c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [],
      expectedFlags: [],
    });
  }

  /* ── INLINE CONSTRUCTS ARE NOT LITERALISERS — the proof, as tests ─────────
   * CommonMark settles BLOCK structure before any inline parsing, so a code span,
   * a raw inline tag or a link-reference-definition title cannot contain a fenced
   * code block: the fence wins, in every conforming renderer. That is a proof, and
   * the standing rule for this lane says a proof ships as a test. Each case
   * asserts the FENCE IS LIVE — the opposite of the inert strata — so a future
   * "make everything inert" over-correction fails here. A BACKSLASH-escaped run is
   * the one inline-ish shape that really does neutralise a fence, on both sides,
   * and it is pinned too. */
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'inline/code-span-cannot-swallow-a-fence',
      shape: 'inline',
      eol: 'lf',
      text: [`${a} \`\``, '````orchard-notes', b, '````', `\`\` ${c}`].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: b }],
      expectedFlags: [],
    });
  }
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'inline/link-ref-definition-title-cannot-swallow-a-fence',
      shape: 'inline',
      eol: 'lf',
      text: [a, '[ref]: /url "', '````orchard-notes', b, '````', '"', c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: false }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: b }],
      expectedFlags: [],
    });
  }
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'inline/backslash-escaped-run-is-not-a-fence',
      shape: 'inline',
      eol: 'lf',
      text: [a, '\\````orchard-notes', b, '\\````', c].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }, { tok: c, mustBeVisible: true }],
      wellFormed: true,
      expected: [],
      expectedFlags: [],
    });
  }

  /* ── THE ONE ASYMMETRY BETWEEN THE TWO FENCE CHARACTERS ───────────────────
   * CommonMark's, not ours: a BACKTICK fence's info string may not contain a
   * backtick (so ```` ```js `x` ```` is a paragraph, not a fence), while a TILDE
   * fence's info string may contain anything — backticks included. Both directions
   * are asserted, because a parser that used one regex for both characters would
   * get one of them wrong and nothing else in the corpus would notice. */
  {
    const a = T(), b = T();
    cases.push({
      id: 'tsyn/backtick-info-carries-a-backtick',
      shape: 'tsyn',
      eol: 'lf',
      text: [a, '```js `x` = 1', b].join('\n'),
      tokens: [{ tok: a, mustBeVisible: true }, { tok: b, mustBeVisible: true }],
      wellFormed: true,
      expected: [],
    });
  }
  {
    const a = T(), b = T(), c = T();
    cases.push({
      id: 'tsyn/tilde-info-carries-a-reserved-looking-run',
      shape: 'tsyn',
      eol: 'lf',
      text: [a, '~~~ ```orchard-answer', b, '~~~', c].join('\n'),
      tokens: [
        { tok: a, mustBeVisible: true },
        { tok: b, mustBeVisible: true },
        { tok: c, mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [],
    });
  }

  return cases;
}

/**
 * The REAL reported inputs, kept verbatim and graded by the same invariants.
 * A generated space that drifted away from the actual bug would still pass; these
 * make that impossible.
 */
export function reportedDefectCases() {
  return [
    {
      id: 'reported/BUG-108-nested-notes-swallows-answer',
      shape: 'reported',
      text: ['`````orchard-notes', 'OUTER-NOTES', '````orchard-notes', 'INNER-NOTES',
        '````orchard-answer', 'SECRET-ANSWER', '````', '`````'].join('\n'),
      tokens: [
        { tok: 'OUTER-NOTES', mustBeVisible: false },
        { tok: 'INNER-NOTES', mustBeVisible: false },
        { tok: 'SECRET-ANSWER', mustBeVisible: true },
      ],
      wellFormed: false,
      expected: null,
    },
    {
      id: 'reported/FEAT-091-unclosed-notes-swallows-answer',
      shape: 'reported',
      text: ['````orchard-notes', 'NARRATION', '````orchard-answer', 'DECISION', '````'].join('\n'),
      tokens: [
        { tok: 'NARRATION', mustBeVisible: false },
        { tok: 'DECISION', mustBeVisible: true },
      ],
      wellFormed: false,
      expected: null,
    },
    {
      // ROUND 3, DEFECT 1 — the reserved opener separated by a LONE CR. C1 was a
      // per-LF-line predicate, so the whole `orchard-answer` opener sat mid-"line"
      // and was invisible to it; the decision rendered inside a CLOSED fold with an
      // empty malformed list. Same hiding class, reached by line splitting.
      id: 'reported/round3-lone-cr-reserved-opener',
      shape: 'reported',
      eol: 'cr',
      text: '````orchard-notes\nNARRATION-R3\r````orchard-answer\rMUST-SEE-DECISION\r````\r\n````\nVISIBLE-TAIL-R3\n',
      tokens: [
        { tok: 'NARRATION-R3', mustBeVisible: false },
        { tok: 'MUST-SEE-DECISION', mustBeVisible: true },
        { tok: 'VISIBLE-TAIL-R3', mustBeVisible: true },
      ],
      wellFormed: false,
      expected: null,
    },
    {
      // ROUND 3, DEFECT 2 — a 3-backtick code fence closed by FOUR backticks inside
      // a 6-backtick notes fence. Legal CommonMark; the even-tally guard counted a
      // 3-run and a 4-run as two unpaired lengths, flagged well-formed input and cut
      // the fold early. WELL-FORMED, so this asserts SILENCE and an exact parse.
      id: 'reported/round3-longer-close-false-flag',
      shape: 'reported',
      eol: 'lf',
      text: ['``````orchard-notes', 'AUTHORED-NOTES-BEFORE', '```js',
        'const x = "AUTHORED-NOTES-CODE";', '````', 'AUTHORED-NOTES-AFTER',
        '``````', 'VISIBLE-TAIL-CLEN'].join('\n'),
      tokens: [
        { tok: 'AUTHORED-NOTES-BEFORE', mustBeVisible: false },
        { tok: 'AUTHORED-NOTES-CODE', mustBeVisible: false },
        { tok: 'AUTHORED-NOTES-AFTER', mustBeVisible: false },
        { tok: 'VISIBLE-TAIL-CLEN', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{
        name: 'orchard-notes',
        content: ['AUTHORED-NOTES-BEFORE', '```js', 'const x = "AUTHORED-NOTES-CODE";',
          '````', 'AUTHORED-NOTES-AFTER'].join('\n'),
      }],
    },
    {
      // ROUND 4 — the clean-room input, character for character. A notes example
      // quoted inside a CommonMark TILDE fence. The grammar modelled backticks
      // only, so the outer fence did not exist to it and the inner one became a
      // real fold: MUST-BE-READER-VISIBLE was in the DOM, absent from the rendered
      // text and absent from the real accessibility tree, while the shared counter
      // reported one clean `orchard-notes` block and an EMPTY malformed list.
      //
      // WELL-FORMED, deliberately: this is legal CommonMark whose faithful parse is
      // "one inert code fence, no blocks", so it asserts an EXACT parse AND total
      // silence — the strongest grading in the suite, on the actual reported input.
      id: 'reported/round4-tilde-fence-hides-a-notes-example',
      shape: 'reported',
      eol: 'lf',
      text: '~~~markdown\n````orchard-notes\nMUST-BE-READER-VISIBLE\n````\n~~~',
      tokens: [{ tok: 'MUST-BE-READER-VISIBLE', mustBeVisible: true }],
      wellFormed: true,
      expected: [],
    },
    {
      // The MIRROR order, which the same one-character grammar also got wrong in
      // the other direction: a tilde-fenced example quoted inside a BACKTICK code
      // fence. Both orders, because "we fixed the shape that was demonstrated" is
      // how this grammar reached round four.
      id: 'reported/round4-mirror-backtick-fence-quotes-a-tilde-notes',
      shape: 'reported',
      eol: 'lf',
      text: '```markdown\n~~~~orchard-notes\nMIRROR-MUST-BE-VISIBLE\n~~~~\n```',
      tokens: [{ tok: 'MIRROR-MUST-BE-VISIBLE', mustBeVisible: true }],
      wellFormed: true,
      expected: [],
    },
    {
      // A REAL tilde-fenced notes block, with a real backtick code fence inside it.
      // The fix must not be "treat tildes as never-a-block": `~~~orchard-notes` is
      // a legitimate opener, folds its own narration, and pairs with `~~~` only.
      id: 'reported/round4-tilde-notes-is-a-real-block',
      shape: 'reported',
      eol: 'lf',
      text: ['~~~~orchard-notes', 'TILDE-NARRATION', '```js', 'run()', '```',
        '~~~~', 'TILDE-VISIBLE-TAIL'].join('\n'),
      tokens: [
        { tok: 'TILDE-NARRATION', mustBeVisible: false },
        { tok: 'TILDE-VISIBLE-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: ['TILDE-NARRATION', '```js', 'run()', '```'].join('\n') }],
    },
    {
      // ...and the hiding invariant still holds INSIDE a tilde fold: a backtick
      // `orchard-answer` in a tilde notes body must be promoted and reported, the
      // same as it is under backticks. The guard is character-blind by construction
      // (one `openerOf`), and this is the case that says so out loud.
      // ROUND 5 — the clean-room input, character for character. A notes example
      // wrapped in a top-level CommonMark HTML block, which makes its contents
      // LITERAL. HTML blocks were deliberately unmodelled on the argument that the
      // residual was "bounded by C1"; C1 bounds what can be hidden inside a fold
      // that already exists, and this wrapper CREATED one. MUST-BE-READER-VISIBLE-
      // HTML was in the DOM, absent from the rendered innerText and from the real
      // accessibility tree, while the shared counter reported one clean
      // `orchard-notes` block, 11 fallback chars and an EMPTY malformed list.
      //
      // NOT well-formed, deliberately, and the opposite call from round 4's tilde
      // case: a `~~~markdown` fence is an unambiguous "this is an example" marker,
      // so silence was right there. A raw `<div>` is not — the start predicate here
      // is deliberately wider than CommonMark's — so this asserts an exact parse
      // (no blocks) AND the exact report, via expectedFlags.
      id: 'reported/round5-html-block-hides-a-notes-example',
      shape: 'reported',
      eol: 'lf',
      text: '<div>\n````orchard-notes\nMUST-BE-READER-VISIBLE-HTML\n````\n</div>',
      tokens: [{ tok: 'MUST-BE-READER-VISIBLE-HTML', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line2'],
    },
    {
      // The MIRROR: the same wrapper around an `orchard-answer`. This is the half
      // round 4's bound DID cover, and it must keep working — the fix must not be
      // "notes are special", it must be "the region is literal".
      id: 'reported/round5-html-block-around-an-answer',
      shape: 'reported',
      eol: 'lf',
      text: '<div>\n````orchard-answer\nHTML-WRAPPED-ANSWER\n````\n</div>',
      tokens: [{ tok: 'HTML-WRAPPED-ANSWER', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-answer@line2'],
    },
    {
      // ROUND 8 — the clean-room input, character for character. A list item whose
      // content is INDENTED CODE (`-` then five spaces) leaves NO paragraph open,
      // so the `<my-widget>` under it is a condition-7 HTML block and the whole
      // region is LITERAL. Round 7's prefix-stripping container model ate the five
      // spaces greedily, saw the paragraph `code`, called the tag lazy paragraph
      // continuation, suppressed condition 7 — and the authored example became a
      // real CLOSED fold with an EMPTY malformed list. Same hiding class as rounds
      // 1-7, reached through container geometry.
      //
      // NOT well-formed: like round 5's `<div>` wrapper, a raw tag is not an
      // unambiguous "this is an example" marker, so this asserts the exact parse
      // (no blocks) AND the exact report.
      id: 'reported/round8-list-icode-hides-a-notes-example',
      shape: 'reported',
      eol: 'lf',
      text: '-     code\n<my-widget>\n````orchard-notes\nADVERSARIAL-MUST-BE-VISIBLE\n````\n</my-widget>',
      tokens: [{ tok: 'ADVERSARIAL-MUST-BE-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line3'],
    },
    {
      // The MIRROR: the same container geometry around an `orchard-answer`. The fix
      // must be "the region is literal", never "notes are special".
      id: 'reported/round8-list-icode-around-an-answer',
      shape: 'reported',
      eol: 'lf',
      text: '-     code\n<my-widget>\n````orchard-answer\nR8-ANSWER-MUST-BE-VISIBLE\n````\n</my-widget>',
      tokens: [{ tok: 'R8-ANSWER-MUST-BE-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-answer@line3'],
    },
    {
      // THE OTHER DIRECTION, which is what makes the fix a fix and not a retreat:
      // ONE space after the marker is a list item whose content is a PARAGRAPH, so
      // the tag under it is lazy continuation, the region is NOT literal, and the
      // notes block is a GENUINE fold. Well-formed: an exact parse and silence.
      // A model that "solved" round 8 by never trusting a list would fail here.
      id: 'reported/round8-list-paragraph-is-still-a-real-fold',
      shape: 'reported',
      eol: 'lf',
      text: '- code\n<my-widget>\n````orchard-notes\nR8-REAL-FOLD\n````\nR8-VISIBLE-TAIL',
      tokens: [
        { tok: 'R8-REAL-FOLD', mustBeVisible: false },
        { tok: 'R8-VISIBLE-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: 'R8-REAL-FOLD' }],
      expectedFlags: [],
    },
    {
      // ROUND 9 — the clean-room input, character for character, from the
      // RANDOMISED differential. Every line of it is a place the implementation
      // was narrower than the spec, and the one that mattered is `===`:
      //
      //     999999999. item
      //     ===
      //     2.     code
      //     <x data-a:b_c.d-e=1>
      //
      // `===` cannot become a setext HEADING here (the paragraph it would
      // underline is inside a list item this line does not match), but it IS
      // ordinary LAZY continuation text — the reference's setext start requires
      // the deepest MATCHED container to be that paragraph. Reading "a setext
      // underline cannot be a lazy continuation line" as "the line starts a new
      // block" closed the paragraph, restarted one at `2.     code`, suppressed
      // condition 7 on the tag, and folded the authored content into a CLOSED
      // `orchard-notes` with an EMPTY malformed list. The nine-digit marker and
      // the `:`/`_`/`.`/`-` attribute name are the other two width/character-class
      // dimensions the fuzz varied; both are handled, and both stay pinned here.
      //
      // NOT well-formed: a raw tag is not an unambiguous "this is an example"
      // marker, so this asserts the exact parse (no blocks) AND the exact report.
      id: 'reported/round9-lazy-setext-hides-a-notes-example',
      shape: 'reported',
      eol: 'lf',
      text: ['2.     code', '# heading', '999999999. item', '===', '2.     code',
        '<x data-a:b_c.d-e=1>', '````orchard-notes', 'RANDOM-MUST-BE-VISIBLE',
        '````', 'TAIL'].join('\n'),
      tokens: [{ tok: 'RANDOM-MUST-BE-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line7'],
    },
    {
      // The MIRROR: the same geometry around an `orchard-answer`. The fix must be
      // "the region is literal", never "notes are special".
      id: 'reported/round9-lazy-setext-around-an-answer',
      shape: 'reported',
      eol: 'lf',
      text: ['2.     code', '# heading', '999999999. item', '===', '2.     code',
        '<x data-a:b_c.d-e=1>', '````orchard-answer', 'R9-ANSWER-MUST-BE-VISIBLE',
        '````', 'TAIL'].join('\n'),
      tokens: [{ tok: 'R9-ANSWER-MUST-BE-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-answer@line7'],
    },
    {
      // THE CONTROL FOR THE FIX, so it is not a retreat to "never close a
      // paragraph". When the paragraph IS the matched container, `===` is a real
      // setext heading, the paragraph closes, condition 7 fires, and the region is
      // literal — exactly as before.
      id: 'reported/round9-setext-in-its-own-container-still-closes',
      shape: 'reported',
      eol: 'lf',
      text: ['Title', '===', '<my-widget>', '````orchard-notes',
        'R9-SETEXT-HEADING-VISIBLE', '````', 'R9-TAIL-SETEXT'].join('\n'),
      tokens: [
        { tok: 'R9-SETEXT-HEADING-VISIBLE', mustBeVisible: true },
        { tok: 'R9-TAIL-SETEXT', mustBeVisible: true },
      ],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line4'],
    },
    {
      // ...and the other direction: a LAZY `===` keeps the paragraph open, and a
      // fence interrupts a paragraph, so the notes block below it is a GENUINE
      // fold. Well-formed: exact parse and silence.
      id: 'reported/round9-lazy-setext-keeps-a-real-fold-real',
      shape: 'reported',
      eol: 'lf',
      text: ['> quoted para', '===', '````orchard-notes', 'R9-LAZY-REAL-FOLD',
        '````', 'R9-LAZY-TAIL'].join('\n'),
      tokens: [
        { tok: 'R9-LAZY-REAL-FOLD', mustBeVisible: false },
        { tok: 'R9-LAZY-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: 'R9-LAZY-REAL-FOLD' }],
      expectedFlags: [],
    },
    {
      // ROUND 9's SECOND CLASS, also from the randomised differential: a leaf block
      // OPEN INSIDE A CONTAINER. The `===` is CODE CONTENT of the quoted fence, but
      // the line classifier had no leaf state, called it a paragraph, and the tag
      // below looked like it was interrupting one.
      id: 'reported/round9-quoted-fence-content-is-not-a-paragraph',
      shape: 'reported',
      eol: 'lf',
      text: ['>```', '>===', '<my-widget>', '````orchard-notes',
        'R9-QUOTED-FENCE-VISIBLE', '````', '</my-widget>'].join('\n'),
      tokens: [{ tok: 'R9-QUOTED-FENCE-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line4'],
    },
    {
      // ROUND 9's THIRD CLASS: "a list item can begin with at most one blank line".
      // Matching the blank kept the empty item open, put the tag INSIDE it, and the
      // fence at column 0 — outside the item — became a real fold.
      id: 'reported/round9-blank-closes-an-empty-list-item',
      shape: 'reported',
      eol: 'lf',
      text: ['-', '', '   <p x>', '````orchard-notes', 'R9-EMPTY-ITEM-VISIBLE',
        '````', 'R9-EMPTY-ITEM-TAIL'].join('\n'),
      tokens: [{ tok: 'R9-EMPTY-ITEM-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line4'],
    },
    {
      // ROUND 9's FOURTH CLASS, and the one that retires the "under-recognition
      // cannot hide" argument: the top-level scan looked for constructs at 0-3 RAW
      // columns, so inside an item whose content column is 2 it MISSED the HTML
      // block at 4 raw columns and still SAW the fence at 2. Under-recognising the
      // literaliser while recognising the fence hides content.
      id: 'reported/round9-html-at-an-item-content-column',
      shape: 'reported',
      eol: 'lf',
      text: ['*     item', "    <li a='1'/>", '  ````orchard-notes',
        '  R9-ITEM-COLUMN-VISIBLE', '  ````', 'R9-ITEM-COLUMN-TAIL'].join('\n'),
      tokens: [{ tok: 'R9-ITEM-COLUMN-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line3'],
    },
    {
      // ROUND 9's FIFTH CLASS: a fence may not take its CLOSE from outside the
      // container it was opened in. Unbounded, the fold swallowed a line the
      // reference keeps as a visible top-level paragraph. Bounded, the fence is
      // unterminated inside the item, degrades to fallback, and is REPORTED.
      id: 'reported/round9-fence-close-outside-its-container',
      shape: 'reported',
      eol: 'lf',
      text: ['-', '  ````orchard-notes', '  narration-r9',
        'R9-OUTSIDE-ITEM-VISIBLE', '  ````'].join('\n'),
      tokens: [{ tok: 'R9-OUTSIDE-ITEM-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['unterminated:orchard-notes@line2'],
    },
    {
      // ROUND 10 — the clean-room input, character for character. A LINK REFERENCE
      // DEFINITION whose destination is on the NEXT line:
      //
      //     [ref]:
      //     /url
      //     ===
      //     <my-widget>
      //     ````orchard-notes
      //
      // The reference resolves the two-line definition OUT of the paragraph when
      // `===` arrives, so nothing is left to underline, no heading is made, the
      // paragraph stays OPEN, condition 7 is suppressed on `<my-widget>` and the
      // fence below is a LIVE `orchard-notes` block. Round 9 recognised only the
      // ONE-LINE form, so it saw no definition, made `===` a setext heading,
      // closed the paragraph, let condition 7 fire — and the well-formed authored
      // fold DISAPPEARED: `blocks: []`, its narration exposed as prose in the real
      // accessibility tree, and `inert-html:orchard-notes@line5` reported as
      // uncertainty on VALID input. The wrongly-LITERAL direction, which loses a
      // block rather than hiding one, and the standing rule covers both.
      //
      // WELL-FORMED, deliberately: this asserts the EXACT parse AND total silence.
      id: 'reported/round10-multiline-linkref-loses-a-notes-fold',
      shape: 'reported',
      eol: 'lf',
      text: ['[ref]:', '/url', '===', '<my-widget>', '````orchard-notes',
        'R10-NARRATION', '````', 'R10-VISIBLE-TAIL'].join('\n'),
      tokens: [
        { tok: 'R10-NARRATION', mustBeVisible: false },
        { tok: 'R10-VISIBLE-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: 'R10-NARRATION' }],
      expectedFlags: [],
    },
    {
      // The MIRROR, around an `orchard-answer`: the fix is "the region is LIVE",
      // never "notes are special".
      id: 'reported/round10-multiline-linkref-around-an-answer',
      shape: 'reported',
      eol: 'lf',
      text: ['[ref]:', '/url', '===', '<my-widget>', '````orchard-answer',
        'R10-ANSWER-BODY', '````', 'R10-ANSWER-TAIL'].join('\n'),
      tokens: [
        { tok: 'R10-ANSWER-BODY', mustBeVisible: true },
        { tok: 'R10-ANSWER-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-answer', content: 'R10-ANSWER-BODY' }],
      expectedFlags: [],
    },
    {
      // The TITLE may also span lines, and it is still one definition.
      id: 'reported/round10-multiline-linkref-title-keeps-the-fold',
      shape: 'reported',
      eol: 'lf',
      text: ['[ref]: /url "a', 'b"', '===', '<my-widget>', '````orchard-notes',
        'R10-TITLE-NARRATION', '````', 'R10-TITLE-TAIL'].join('\n'),
      tokens: [
        { tok: 'R10-TITLE-NARRATION', mustBeVisible: false },
        { tok: 'R10-TITLE-TAIL', mustBeVisible: true },
      ],
      wellFormed: true,
      expected: [{ name: 'orchard-notes', content: 'R10-TITLE-NARRATION' }],
      expectedFlags: [],
    },
    {
      // THE OTHER DIRECTION, which is what makes the fix a fix and not a retreat.
      // One more line of PROSE after the definition and the paragraph is no longer
      // all-definitions: `===` underlines `text`, the heading closes the paragraph,
      // condition 7 fires, and the region really IS literal — so the token must be
      // VISIBLE and the uncertainty REPORTED. A model that "solved" round 10 by
      // never closing a paragraph under a `[` would hide content here.
      id: 'reported/round10-linkref-then-prose-still-closes',
      shape: 'reported',
      eol: 'lf',
      text: ['[ref]:', '/url', 'text', '===', '<my-widget>', '````orchard-notes',
        'R10-CONTROL-VISIBLE', '````', '</my-widget>'].join('\n'),
      tokens: [{ tok: 'R10-CONTROL-VISIBLE', mustBeVisible: true }],
      wellFormed: false,
      expected: [],
      expectedFlags: ['inert-html:orchard-notes@line6'],
    },
    {
      id: 'reported/round4-answer-inside-a-tilde-fold',
      shape: 'reported',
      eol: 'lf',
      text: ['~~~~orchard-notes', 'TILDE-NARRATION-2', '````orchard-answer',
        'TILDE-FOLD-DECISION', '````', '~~~~'].join('\n'),
      tokens: [
        { tok: 'TILDE-NARRATION-2', mustBeVisible: false },
        { tok: 'TILDE-FOLD-DECISION', mustBeVisible: true },
      ],
      wellFormed: false,
      expected: null,
    },
  ];
}

/* ── the invariants ─────────────────────────────────────────────────────────── */

/**
 * Grade one case against a PARSE. Returns an array of violation strings (empty is
 * a pass). `parsed` is the real parseResponseBlocks() result.
 *
 *   I1  no must-be-visible token lands inside a collapsed (orchard-notes) block.
 *   I2  every authored token appears exactly once, in authored order.
 *   I3  a parse that deviates from the authored structure says so — malformed or
 *       uncategorised — and a well-formed case flags NOTHING (anti-vacuity).
 */
/**
 * THE NAMES THAT CAN HIDE. Round 12 replaced the presentation-era vocabulary with
 * a semantic one, and `orchard-notes` — which every case in this file is written
 * with — became a frozen LEGACY alias of `orchard-narration`. Both fold, so both
 * are graded as folds here. Round 13 (FEAT-093) added `orchard-finding`, at the
 * user's request: findings are now the supporting record behind a reply, folded
 * with a preview of their first sentence. This is deliberately a local set rather
 * than an import of COLLAPSED_BLOCKS: an oracle that reads the implementation's
 * own list would agree with a parser that silently stopped collapsing, which is
 * the failure this corpus exists to catch. It is pinned by a check in the suite
 * instead.
 */
export const CORPUS_FOLD_NAMES = Object.freeze(['orchard-notes', 'orchard-narration', 'orchard-finding']);

/**
 * REMAP a generated case onto the round-12 semantic names, input AND expectations
 * together. This is what proves the grammar is driven by the vocabulary tables
 * rather than by two hard-coded strings: the entire enumerated corpus — every
 * inert construct, container stack, line-ending regime and fold-guard shape — is
 * re-graded under `orchard-narration` / `orchard-ask` with identical
 * expectations. Whole-token only (`\b`), so an unknown name like
 * `orchard-futurething` is untouched and stays unknown.
 *
 * THE VISIBLE STAND-IN CHANGED IN ROUND 13, and the reason is the point of the
 * whole remap. It was `orchard-answer` -> `orchard-finding`, chosen when `finding`
 * was the archetypal VISIBLE category. FEAT-093 made findings fold, so that arrow
 * silently turned every `MUST-BE-VISIBLE` token in the corpus into content the
 * grammar was now right to hide, and the I1 leg went red across the board — not a
 * regression, a stale oracle. The stand-in must be a category that is visible BY
 * THE RULE ("addressed to the reader"), and `ask` is the least foldable of those:
 * a decision that is the user's is the one thing that can never be put behind a
 * click. Pick the stand-in by the rule, and this cannot go stale again the next
 * time a category's presentation moves.
 */
const REMAP = [
  [/orchard-notes\b/g, 'orchard-narration'],
  [/orchard-answer\b/g, 'orchard-ask'],
];
const remapText = (t) => REMAP.reduce((acc, [re, to]) => acc.replace(re, to), String(t));
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let remapTokenSeq = 0;
export function remapCorpus(cases) {
  return cases.map((c) => {
    // TOKENS MUST STAY GLOBALLY UNIQUE. The render leg reads ONE accessibility
    // tree over many cases rendered onto one page, so a token appearing in two
    // cases makes "hidden here, visible there" look like a leak. (The round-6
    // lesson, from the other end: a duplicate id silently mis-grades this leg.)
    // So every token is re-minted alongside the rename, longest-first so
    // `TK1` cannot eat the front of `TK10`.
    const src = Array.isArray(c.tokens) ? c.tokens.map((t) => t.tok) : [];
    // A fresh, FIXED-WIDTH, terminated name per token. Fixed width plus a
    // terminator is what makes the family substring-free in both directions:
    // a prefix scheme would have left the original token a substring of its
    // replacement (`MUST-BE-VISIBLE` inside `R12-MUST-BE-VISIBLE`), and a bare
    // counter would have let `RM12T5Z`-style names nest inside each other the
    // way `TK1` nests inside `TK10`.
    const mint = new Map(src.map((t) => [t, `RM12T${String(remapTokenSeq++).padStart(6, '0')}Z`]));
    const ordered = src.slice().sort((a, b) => b.length - a.length);
    const tokRe = ordered.length ? new RegExp(ordered.map(escapeRe).join('|'), 'g') : null;
    const conv = (t) => {
      const named = remapText(t);
      return tokRe ? named.replace(tokRe, (m) => mint.get(m) ?? m) : named;
    };
    return {
      ...c,
      id: `rm/${c.id}`,
      text: conv(c.text),
      expected: Array.isArray(c.expected)
        ? c.expected.map((b) => ({ ...b, name: remapText(b.name), content: conv(b.content) }))
        : c.expected,
      expectedFlags: Array.isArray(c.expectedFlags) ? c.expectedFlags.map(remapText) : c.expectedFlags,
      tokens: Array.isArray(c.tokens) ? c.tokens.map((t) => ({ ...t, tok: mint.get(t.tok) ?? t.tok })) : c.tokens,
    };
  });
}

export function gradeParse(c, parsed) {
  const bad = [];
  const ordered = [
    ...parsed.blocks.map((b) => ({ line: b.startLine, text: b.content, fold: CORPUS_FOLD_NAMES.includes(b.name) })),
    ...parsed.fallbackRuns.map((r) => ({ line: r.startLine, text: r.text, fold: false })),
  ].sort((x, y) => x.line - y.line);

  // I1 — the hiding invariant.
  for (const t of c.tokens) {
    if (!t.mustBeVisible) continue;
    for (const region of ordered) {
      if (region.fold && region.text.includes(t.tok)) bad.push(`I1 ${t.tok} folded into a collapsed block`);
    }
  }

  // I2 — coverage and order over the concatenated regions.
  const joined = ordered.map((r) => r.text).join('\n');
  for (const t of c.tokens) {
    const hits = joined.split(t.tok).length - 1;
    if (hits !== 1) bad.push(`I2 ${t.tok} appears ${hits}x (want exactly 1)`);
  }
  const seen = c.tokens.map((t) => [t.tok, joined.indexOf(t.tok)]).filter(([, at]) => at >= 0);
  for (let k = 1; k < seen.length; k++) {
    if (seen[k][1] < seen[k - 1][1]) bad.push(`I2 order: ${seen[k][0]} precedes ${seen[k - 1][0]}`);
  }

  // I3a — EXACT reporting, where the case declares it. `wellFormed` only asserts
  // "flagged nothing"; the inert-HTML strata need the stronger statement, because
  // "resolves visible AND reported" is two claims and a suite that only checked
  // the first would pass a parser that hid the report instead of the content.
  if (Array.isArray(c.expectedFlags)) {
    const got = parsed.malformed.slice().sort().join(',');
    const want = c.expectedFlags.slice().sort().join(',');
    if (got !== want) bad.push(`I3 flags differ\n      want [${want}]\n      got  [${got}]`);
  }

  // I3 — uncertainty is reported; certainty is not over-reported.
  if (c.wellFormed) {
    // `unknown-block:` is not a deviation report — it is the reserved-namespace
    // forward-compatibility advisory, raised for a perfectly well-formed use of a
    // name this spec version has not defined yet. Everything else must be silent.
    const flagged = parsed.malformed.filter((m) => !m.startsWith('unknown-block:'));
    if (flagged.length) bad.push(`I3 well-formed case flagged: ${flagged.join(',')}`);
    const got = parsed.blocks.map((b) => `${b.name}:${b.content}`).join('|');
    const want = (c.expected || []).map((b) => `${b.name}:${b.content}`).join('|');
    if (got !== want) bad.push(`I3 well-formed parse differs\n      want ${want}\n      got  ${got}`);
  } else if (!parsed.malformed.length && !parsed.fallbackRuns.length) {
    bad.push('I3 non-well-formed case silently absorbed (no malformed, no fallback)');
  }
  return bad;
}

/**
 * Grade one case against a RENDER, given `{ visible, hidden }` text extracted from
 * the real DOM (hidden = the body of every CLOSED <details>, which is what the
 * reader and the accessibility tree do not have). Same invariants, asserted on
 * text rather than structure, because content inside a closed fold is hidden no
 * matter how present it is in the markup.
 */
export function gradeRender(c, { visible, hidden }) {
  const bad = [];
  // R3's scope: the tokens a WELL-FORMED case says belong inside a real
  // `orchard-notes` fold. Only these are graded for LOSING the fold — for a
  // not-well-formed case, degrading narration to visible prose is the correct,
  // deliberate behaviour, and R1/R2 already cover it.
  const mustFold = new Set();
  if (c.wellFormed && Array.isArray(c.expected)) {
    for (const b of c.expected) {
      if (!CORPUS_FOLD_NAMES.includes(b.name)) continue;
      for (const t of c.tokens) if (!t.mustBeVisible && String(b.content).includes(t.tok)) mustFold.add(t.tok);
    }
  }
  for (const t of c.tokens) {
    const inHidden = hidden.includes(t.tok);
    const inVisible = visible.includes(t.tok);
    if (t.mustBeVisible && inHidden) bad.push(`R1 ${t.tok} rendered inside a CLOSED fold`);
    if (t.mustBeVisible && !inVisible) bad.push(`R1 ${t.tok} missing from the visible render`);
    if (!inHidden && !inVisible) bad.push(`R2 ${t.tok} rendered nowhere at all`);
    // R3 — THE OTHER DIRECTION, added round 10. R1/R2 only ever asked whether
    // content ESCAPED; they could not see a fold being LOST. The round-10 defect
    // is exactly that: a multi-line link reference definition made a well-formed
    // `orchard-notes` block classify as literal prose, so its narration rendered
    // in the open with `exposedInFullAXTree: true` — and the render leg was
    // silent, because nothing was hidden and nothing had vanished. A fold the
    // author authored and the grammar confirms must BE a fold in the browser.
    if (mustFold.has(t.tok) && !inHidden) bad.push(`R3 ${t.tok} was authored inside a collapsed block but is NOT in a closed fold (the fold was lost)`);
  }
  return bad;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * THE RANDOMISED (FUZZ) SPACE — hoisted here in round 12.
 *
 * WHY IT MOVED. This generator was written in
 * scripts/verify-feat-091-commonmark-diff.mjs and lived there alone, which meant
 * the ~480,000 documents it produces per suite run were graded in NODE ONLY,
 * against the CommonMark reference — never rendered. The eleventh independent
 * pass named exactly that as its one residual, and it is not a small one: the
 * TENTH defect passed every parser-level check and was caught only when a
 * verifier rendered input in a real browser and read the accessibility tree. A
 * huge randomised space explored only where the reader is NOT is the same blind
 * spot one level up.
 *
 * So the generator moved to the shared corpus module — the same module, and for
 * the same reason, that the enumerated corpus already lives in: the parser leg
 * and the render leg must not each invent their own inputs, or a property that
 * holds in node and fails in the browser is invisible by construction. The
 * differential (`verify:feat-091-commonmark-diff`) now imports it from here; the
 * renderer's [R] leg samples the SAME function with the SAME shape.
 *
 * NOTHING ABOUT THE SPACE CHANGED IN THE MOVE. Same PRNG, same pools, same
 * probabilities: a fixed seed produces byte-identical documents before and after,
 * which is how the move was verified rather than asserted.
 * ════════════════════════════════════════════════════════════════════════════ */

/** mulberry32 — a small, seeded, dependency-free PRNG. */
export function rngFrom(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FUZZ_LEAVES = [
  'text', 'more prose', '', '# heading', '## h', '===', '---', '***', '___',
  '    code', '\tcode', '```', '~~~', '```js', '<div>', '</div>', '<!-- c -->',
  '<!DOCTYPE h>', '<pre>', '[ref]: /url', '| a | b |', '#hashtag', '>', 'item',
  '1', '<b', 'Array<string>', '    ', '  ',
];
const FUZZ_WS = [' ', '  ', '\t', '\f', ' ', ' '];
const FUZZ_TAG_NAMES = ['my-widget', 'div', 'span', 'pre', 'script', 'style',
  'textarea', 'source', 'search', 'a', 'x', 'h1', 'p', 'li', 'custom-el', 'X-Y', 'b'];
const FUZZ_NON_TAGS = ['<!--', '<?php', '<!ENTITY f', '<![CDATA[', '<b',
  'Array<string>', '<= 5', '<https://e.com/d>', '<b>bold</b> t', '<my-widget>tail',
  'plain prose', ''];
const FUZZ_PREFIXES = ['', '  ', '   ', '    ', '      ', '> ', '>', '- ', '  - ', '> > '];

/* ── MULTI-LINE CONSTRUCTS (round 10) ──────────────────────────────────────
 * Every leaf above was ONE line, so the generator could never produce a
 * construct whose EXTENT spans lines — and the round-10 clean-room defect was
 * exactly that: a LINK REFERENCE DEFINITION whose destination sits on the next
 * line. The reference resolves it out of the paragraph at a setext underline,
 * keeping the paragraph open and the fence below LIVE; a one-line-at-a-time
 * notion of a definition made `===` a heading, closed the paragraph, let
 * condition 7 fire, and LOST a well-formed fold. So the generator now emits, at
 * random, whole multi-line constructs: definitions split across up to three
 * lines with tab / newline separators and titles that may or may not sit at a
 * line end, multi-line HTML blocks of conditions 2-5, an unterminated fence, and
 * indented code interrupted by a blank line. Continuation lines carry the
 * container prefix only SOMETIMES, so lazy continuation is exercised too.
 */
const FUZZ_REF_LABELS = ['ref', 'a', 'a b', 'foo\nbar', ' ', '', 'a\\]b', 'x[y', '1', 'A B  C'];
const FUZZ_REF_DESTS = ['/url', '<>', '<a b>', 'u(1)', 'u(1', 'a\\(b', '/u#f', ')', '/url)', '<a', 'x'];
const FUZZ_REF_TITLES = ['"t"', "'t'", '(t)', '"t\nu"', '"unclosed', '"t" x', '()', "'a(b'"];
const FUZZ_REF_SEP1 = ['', ' ', '  ', '\n', '\n  ', '\t', ' \t', '\n\t'];
const FUZZ_REF_SEP2 = [' ', '\n', '\n ', '\t', '  ', '\n   '];
const FUZZ_UNDERLINES = ['===', '=', '---', '-', '==  ', '   ==='];

/** One random link reference definition, as an array of 1-3 lines. */
function fuzzRefDef(rnd, pick) {
  let s = `[${pick(FUZZ_REF_LABELS)}]:${pick(FUZZ_REF_SEP1)}${pick(FUZZ_REF_DESTS)}`;
  if (rnd() < 0.5) s += pick(FUZZ_REF_SEP2) + pick(FUZZ_REF_TITLES);
  if (rnd() < 0.12) s += pick([' trailing', ' x', '  ', ' "z"']);
  return s.split('\n');
}

/** 1-3 definitions, optionally underlined — the reported defect's exact shape. */
function fuzzRefBlock(rnd, pick, forceUnderline) {
  const out = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < n; k++) out.push(...fuzzRefDef(rnd, pick));
  if (forceUnderline || rnd() < 0.5) out.push(pick(FUZZ_UNDERLINES));
  return out;
}

/** A random construct whose extent spans lines, as an array of lines. */
function fuzzMultiLeaf(rnd, pick) {
  const k = rnd();
  if (k < 0.40) return fuzzRefBlock(rnd, pick, false);
  if (k < 0.50) return ['<!-- start', 'mid', 'end -->'];
  if (k < 0.58) return ['<?php', 'x', '?>'];
  if (k < 0.66) return ['<!X', 'y', '>'];
  if (k < 0.74) return ['<![CDATA[', 'z', ']]>'];
  if (k < 0.82) return [pick(['```', '~~~', '```js']), 'unterminated body'];
  if (k < 0.90) return ['    code', '', '    more code'];
  return ['prose', pick(FUZZ_UNDERLINES)];
}

/**
 * The token every fuzz document places inside the `orchard-notes` fence. Whether
 * it may be folded is decided by the CommonMark reference, not by this module —
 * the fuzz oracle is external, unlike the enumerated corpus's tree oracle.
 */
export const FUZZ_TOKEN = 'RANDOM-MUST-BE-VISIBLE';

/** One random document, plus where its fence and close lines are. */
export function fuzzDoc(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const marker = () => {
    let m;
    if (rnd() < 0.5) {
      const digits = 1 + Math.floor(rnd() * 10);
      let d = '';
      for (let k = 0; k < digits; k++) d += Math.floor(rnd() * 10);
      m = d + pick(['.', ')']);
    } else m = pick(['-', '*', '+']);
    return m + (rnd() < 0.9 ? ' '.repeat(Math.floor(rnd() * 8)) : '\t');
  };
  /** 0-N context lines: usually one single-line leaf, sometimes a whole
   *  multi-line construct whose continuation lines carry the container prefix
   *  only sometimes (blanking the markers to spaces is a list item's real
   *  continuation; dropping them entirely is LAZY continuation). */
  const ctxLines = () => {
    let prefix = ' '.repeat(Math.floor(rnd() * 5));
    const n = Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) prefix += rnd() < 0.4 ? pick(['> ', '>', '>  ']) : marker();
    if (rnd() >= 0.30) return [prefix + pick(FUZZ_LEAVES)];
    const blanked = prefix.replace(/[^\t ]/g, ' ');
    const conts = ['', ' ', '   ', prefix, blanked];
    return fuzzMultiLeaf(rnd, pick)
      .map((l, i) => (i === 0 ? prefix + l : pick(conts) + l));
  };
  const attrName = () => {
    let s = pick('abzABZ_:'.split(''));
    const n = Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) s += pick('abz09:._-'.split(''));
    return s;
  };
  const attrValue = () => {
    const k = rnd();
    if (k < 0.34) return pick(['1', 'x', 'a-b', 'é', 'v.1']);
    if (k < 0.67) return `'${pick(['a', 'a b', '', 'a>b'])}'`;
    return `"${pick(['a', 'a b', '', 'a<b'])}"`;
  };
  const tagLine = () => {
    if (rnd() < 0.08) return pick(FUZZ_NON_TAGS);
    const name = pick(FUZZ_TAG_NAMES);
    if (rnd() < 0.25) return `</${name}${rnd() < 0.5 ? pick(FUZZ_WS) : ''}>`;
    let s = `<${name}`;
    const n = Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      s += pick(FUZZ_WS) + attrName();
      if (rnd() < 0.7) s += `${rnd() < 0.5 ? '' : pick(FUZZ_WS)}=${rnd() < 0.5 ? '' : pick(FUZZ_WS)}${attrValue()}`;
    }
    if (rnd() < 0.5) s += pick(FUZZ_WS);
    if (rnd() < 0.3) s += '/';
    s += '>';
    return (rnd() < 0.06 ? s + 'tail' : s);
  };

  const ctx = [];
  const nctx = Math.floor(rnd() * 5);
  for (let k = 0; k < nctx; k++) ctx.push(...ctxLines());
  // ...and, one document in four, put a definition block ending in a setext
  // underline IMMEDIATELY above the tag line. That adjacency is what decides
  // whether condition 7 fires, and leaving it to chance made the round-10 defect
  // a needle: it is the difference between the fold surviving and vanishing.
  if (rnd() < 0.25) ctx.push(...fuzzRefBlock(rnd, pick, true));
  const ch = rnd() < 0.5 ? '`' : '~';
  const run = ch.repeat(3 + Math.floor(rnd() * 3));
  const pre = rnd() < 0.55 ? '' : pick(FUZZ_PREFIXES);
  const lines = [...ctx, pre + tagLine(), `${pre}${run}orchard-notes`,
    pre + FUZZ_TOKEN, pre + run, 'TAIL'];
  return { input: lines.join('\n'), fenceLine: ctx.length + 2, closeLine: ctx.length + 4 };
}

/* ── SAMPLING the fuzz space for the BROWSER ────────────────────────────────
 * The differential grades every generated document in node, because a node parse
 * costs microseconds. A browser render costs milliseconds — three orders of
 * magnitude — so rendering the whole space is not a choice anyone gets to make.
 * The choice that IS available is WHICH documents to render, and it is the whole
 * value of the leg: rendering three fixed shapes is what left the residual, and
 * rendering a round number chosen for its roundness would be the same mistake
 * with a bigger number.
 *
 * So the sample is STRATIFIED, and the strata are the places this grammar has
 * actually broken, not the places it might:
 *
 *   uncertain      the parser reported something in `malformed`. It resolved the
 *                  document, but not confidently; every clean-room verdict so far
 *                  has lived where the parser was unsure what a region was.
 *   linkref        a link reference definition and/or a setext underline in the
 *                  context — rounds 9 and 10, the two most recent defects, both
 *                  of which turned on that adjacency deciding condition 7.
 *   htmlblock      an HTML start condition above the fence — rounds 5, 6 and 7.
 *   container      block-quote / list markers stacked above the fence — round 8's
 *                  prefix-stripping container model.
 *   tilde          a `~~~` fence — round 4, the character that was not a
 *                  dimension until it shipped a defect.
 *   live           the reference says the fence is LIVE, i.e. the document really
 *                  does author a fold. Held as its own stratum on purpose: the
 *                  FOLD-LOST direction (R3/F3) can only be observed on a document
 *                  that is supposed to fold, and live documents are the minority
 *                  of the space, so an unstratified sample under-weights exactly
 *                  the direction round 9 broke.
 *   random         an unstratified remainder, so the strata above — which are a
 *                  list of what we already know — cannot themselves become the
 *                  blind spot. This is the part of the sample that can find the
 *                  twelfth defect in a place nobody has written down.
 *
 * Quotas are shares of the sample, filled in order, deduplicated by document, and
 * any shortfall in one stratum spills into `random` — so the sample is always the
 * requested size and never silently smaller.
 */
export const FUZZ_STRATA = Object.freeze([
  { tag: 'uncertain', share: 0.22 },
  { tag: 'linkref', share: 0.16 },
  { tag: 'htmlblock', share: 0.12 },
  { tag: 'container', share: 0.10 },
  { tag: 'tilde', share: 0.08 },
  { tag: 'live', share: 0.12 },
  { tag: 'random', share: 0.20 },
]);

/**
 * Which defect-adjacent constructs a fuzz document contains, read off the TEXT.
 * Deliberately syntactic and cheap: this decides what to render, not what is
 * correct, so a loose match costs a slightly less pointed sample and nothing else.
 */
export function fuzzDefectTags(input) {
  const tags = [];
  const ctx = input.split('\n');
  // The document is [...context, tagline, fence, token, close, TAIL]; only the
  // context can change what the fence line sits in.
  const head = ctx.slice(0, Math.max(0, ctx.length - 5)).join('\n');
  const tagLine = ctx[Math.max(0, ctx.length - 5)] ?? '';
  if (/\]:/.test(head) || /^[ \t>*+\-0-9.)]*(?:={1,}|-{1,})\s*$/m.test(head)) tags.push('linkref');
  if (/<[A-Za-z!?/]/.test(tagLine) || /<[A-Za-z!?/]/.test(head)) tags.push('htmlblock');
  if (/^[ \t]*(?:>|[-*+]\s|\d+[.)])/m.test(head)) tags.push('container');
  if (input.includes('~~~')) tags.push('tilde');
  return tags;
}

/**
 * Choose the browser sample. `annotated` is `[{ doc, live, uncertain, tags }]`;
 * `rnd` is a seeded PRNG, so the same seed renders the same sample and a failure
 * is replayable. Returns `{ picked, counts }` where `counts` reports how many
 * documents each stratum actually contributed — printed by the verifier, because
 * a stratum that quietly contributed nothing is a sample that is not what it says
 * it is.
 */
export function pickFuzzSample(annotated, { sample, rnd }) {
  const shuffled = (arr) => {
    const a = arr.slice();
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(rnd() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  };
  const memberOf = (tag, e) =>
    tag === 'random' ? true
      : tag === 'uncertain' ? e.uncertain
        : tag === 'live' ? e.live
          : e.tags.includes(tag);

  const chosen = new Set();
  const picked = [];
  const counts = {};
  let carry = 0;
  for (const { tag, share } of FUZZ_STRATA) {
    const want = Math.round(sample * share) + carry;
    const pool = shuffled(annotated
      .map((e, i) => i)
      .filter((i) => !chosen.has(i) && memberOf(tag, annotated[i])));
    let got = 0;
    for (const i of pool) {
      if (got >= want) break;
      if (chosen.has(i)) continue;
      chosen.add(i);
      picked.push({ ...annotated[i], stratum: tag });
      got++;
    }
    counts[tag] = got;
    carry = want - got; // a short stratum spills into the next (ending at random)
  }
  return { picked, counts };
}

/**
 * Grade ONE rendered fuzz document. `doc` is `{ input, live }` where `live` is
 * the CommonMark REFERENCE verdict — does a fenced code block with info
 * `orchard-notes` really open at the fence line, hold the token, and close? —
 * and `{ visible, hidden }` is text pulled out of the real DOM exactly as the
 * enumerated leg pulls it: `hidden` is the body of every CLOSED <details>, which
 * is what the reader and the accessibility tree do not have.
 *
 * The reference is the oracle here rather than a tree, because a fuzz document
 * has no authored structure to recover — the question "is this region literal?"
 * is a markdown question, and the spec editor's own implementation answers it.
 *
 *   F1  reference says LITERAL -> the token reaches the reader. It is not inside
 *       a closed fold (the HIDING direction: rounds 5, 6, 7, 8).
 *   F2  the token is rendered SOMEWHERE. Nothing is lost.
 *   F3  reference says LIVE -> the token IS inside a closed fold. The fold the
 *       author wrote is really a fold (the FOLD-LOST direction: round 9, the one
 *       R1/R2 structurally cannot see).
 *   F4  the trailing TAIL line, which is outside the fence under every reading,
 *       is visible with no interaction — a fold that runs away and swallows the
 *       rest of the message is the worst version of the hiding defect.
 */
export function gradeFuzzRender(doc, { visible, hidden }) {
  const bad = [];
  const inHidden = hidden.includes(FUZZ_TOKEN);
  const inVisible = visible.includes(FUZZ_TOKEN);
  if (!doc.live && inHidden) bad.push('F1 reference says the region is LITERAL, but the token rendered inside a CLOSED fold');
  if (!doc.live && !inVisible) bad.push('F1 reference says the region is LITERAL, but the token is not in the visible render');
  if (!inHidden && !inVisible) bad.push('F2 the token rendered nowhere at all');
  if (doc.live && !inHidden) bad.push('F3 reference says the region is a real orchard-notes fold, but the token is NOT in a closed fold (the fold was lost)');
  if (!visible.includes('TAIL')) bad.push('F4 the trailing TAIL line is not visible without interaction (a fold swallowed the rest of the message)');
  return bad;
}
