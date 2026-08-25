/**
 * FEAT-083 — structured response digest envelope.
 *
 * An assistant message MAY lead with a fenced code block whose info-string is
 * `orchard-digest`, holding JSON like:
 *
 *   ```orchard-digest
 *   { "items": [ { "text": "one sentence", "kind": "decision",
 *                  "importance": "high", "ref": "FEAT-082" } ] }
 *   ```
 *
 * When present, valid, and enabled for the project, the transcript renderer
 * lifts it OUT of the prose and paints a compact, importance-weighted, grouped
 * list ABOVE the remaining markdown. The raw JSON never shows.
 *
 * Hard contract — this must NEVER swallow content:
 *   - no block            -> render prose exactly as before
 *   - block, but unparseable / wrong shape / no usable items
 *                          -> DROP the digest, render the WHOLE original text as
 *                             prose (the fence just renders as a normal code
 *                             block). A parse error can never hide the message.
 *   - disabled for project -> never even parse; render the whole text as prose.
 *
 * Ephemeral by design: this is the render of ONE assistant turn. It does not
 * accumulate a cross-turn digest — durable decision tracking is the Needs-You
 * rail / ticket board, deliberately not duplicated here.
 */
import { el, prose } from './dom.js';
import { formatTicketsHash } from './route.js';
import { parseResponseBlocks, COLLAPSED_BLOCKS } from './response-blocks.js';

/* Kinds, in the fixed display order (Decisions first, then Done, In-flight, FYI). */
const KIND_ORDER = ['decision', 'done', 'in-flight', 'fyi'];
const KIND_LABEL = { decision: 'Decisions', done: 'Done', 'in-flight': 'In-flight', fyi: 'FYI' };
const KIND_ALIAS = {
  decision: 'decision', 'decision-needed': 'decision', 'needs-you': 'decision', 'needs-decision': 'decision',
  done: 'done', changed: 'done', completed: 'done', complete: 'done',
  'in-flight': 'in-flight', inflight: 'in-flight', 'in-progress': 'in-flight', wip: 'in-flight', running: 'in-flight',
  fyi: 'fyi', info: 'fyi', note: 'fyi',
};
const IMPORTANCE = { high: 'high', med: 'med', medium: 'med', normal: 'med', low: 'low' };

/* A ticket id like FEAT-083 / BUG-093 / CHORE-12 — deep-linkable. Anything else
   is treated as an inert label (a plain anchor/paragraph pointer). */
const TICKET_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/*
 * A leading orchard-digest fence. The block must be at the TOP of the message
 * (only blank lines may precede it). The info-string is matched
 * case-insensitively and tolerates trailing spaces.
 *
 * BOTH CommonMark fence characters, and the SAME pairing rule the block grammar
 * uses (public/lib/response-blocks.js): a fence closes on a run of the SAME
 * character, at least as long, alone on its line, indented 0-3 spaces. This used
 * to be one backtick-only regex, which meant layer 1 and layer 2 disagreed about
 * what a digest fence is — `~~~orchard-digest` was a digest block to the counter
 * and not a digest to the renderer. Two implementations of one grammar is the
 * failure mode this module exists to avoid, so it is a line scan, not a regex.
 */
const DIGEST_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*orchard-digest[ \t]*$/i;
const DIGEST_CLOSE_RES = { '`': /^ {0,3}(`{3,})[ \t]*$/, '~': /^ {0,3}(~{3,})[ \t]*$/ };

/** The leading digest fence's body and the text after it, or null. */
function sliceDigestFence(lines) {
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  const om = DIGEST_OPEN_RE.exec(lines[at] ?? '');
  if (!om) return null;
  const run = om[1];
  const closeRe = DIGEST_CLOSE_RES[run[0]];
  for (let j = at + 1; j < lines.length; j++) {
    const cm = closeRe.exec(lines[j]);
    if (cm && cm[1].length >= run.length) {
      return { json: lines.slice(at + 1, j).join('\n'), rest: lines.slice(j + 1).join('\n') };
    }
  }
  return null; // unterminated -> not a digest; the caller renders the whole message
}

/**
 * Pull a leading orchard-digest envelope out of an assistant message.
 *
 * @returns {null | { items: Array, rest: string }}
 *   null  -> no leading orchard-digest fence at all (caller renders prose as-is)
 *   object with a NON-EMPTY items array -> a valid digest; `rest` is the prose
 *            below with the fence removed.
 *   If a fence is present but the JSON is malformed or yields no usable items,
 *   this returns null too — so the caller falls back to rendering the FULL
 *   original text (fence included) as ordinary prose. Content is never lost.
 */
export function parseDigest(text) {
  // Same boundary rule: a lone-CR transcript must find the leading digest fence
  // exactly as an LF one does, and `rest` must hand normalised text downstream.
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const m = sliceDigestFence(src.split('\n'));
  if (!m) return null;

  let parsed;
  try {
    parsed = JSON.parse(m.json);
  } catch {
    return null; // malformed JSON -> fall back to plain prose (fence shows as code)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null;

  const items = [];
  for (const raw of parsed.items) {
    if (!raw || typeof raw !== 'object') continue;
    const t = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!t) continue; // an item with no sentence carries nothing — skip it
    const kind = KIND_ALIAS[String(raw.kind ?? '').toLowerCase()] ?? 'fyi';
    const importance = IMPORTANCE[String(raw.importance ?? '').toLowerCase()] ?? 'med';
    const ref = typeof raw.ref === 'string' && raw.ref.trim() ? raw.ref.trim() : null;
    items.push({ text: t, kind, importance, ref });
  }
  if (!items.length) return null; // nothing usable -> plain prose, nothing hidden

  return { items, rest: m.rest };
}

/** One reference: a ticket id becomes a deep link; anything else is an inert label. */
function refNode(ref, projectId) {
  if (TICKET_RE.test(ref)) {
    return el('a', {
      class: 'digest-ref digest-ref-link',
      href: formatTicketsHash({ ticketId: ref, projectId: projectId ?? null }),
      text: ref,
    });
  }
  return el('span', { class: 'digest-ref digest-ref-label', text: ref });
}

/**
 * Build the structured digest node from parsed items. Grouped by kind in the
 * fixed order. Each item is a bounded row: the statement text, then (if any) its
 * ref chip appended INLINE right after the sentence so it reads as attached, not
 * a right-pinned floating column (BUG-095). Importance rides a CSS class only
 * (`imp-*` → ink contrast, never font-weight); kind rides the group class
 * (`digest-<kind>` → a tinted left rail + a hue-traced eyebrow). NO emojis, ever.
 */
export function renderDigest(items, { projectId = null } = {}) {
  const box = el('div', { class: 'digest', role: 'note', 'aria-label': 'Response digest' });
  for (const kind of KIND_ORDER) {
    const group = items.filter((it) => it.kind === kind);
    if (!group.length) continue;
    const section = el('div', { class: `digest-group digest-${kind}` });
    section.append(el('div', { class: 'digest-group-label', text: KIND_LABEL[kind] }));
    const list = el('ul', { class: 'digest-items' });
    for (const it of group) {
      const li = el('li', { class: `digest-item imp-${it.importance}` });
      li.append(el('span', { class: 'digest-text', text: it.text }));
      if (it.ref) li.append(refNode(it.ref, projectId));
      list.append(li);
    }
    section.append(list);
    box.append(section);
  }
  return box;
}

/* ════════════════════════════ FEAT-091 — layer 2 ══════════════════════════════
 *
 * Layer 2 types the PROSE of a reply. Every part declares WHAT IT IS, and this
 * file derives the presentation from that category — it never makes a
 * per-passage display choice:
 *
 *   outcome / ask / judgment / status
 *                   -> expanded, always, with a quiet category label so the
 *                      reader can find the kind of thing they came for.
 *   finding         -> collapsed behind a one-line affordance that CARRIES ITS
 *                      FIRST SENTENCE, so it can be skipped or opened on the
 *                      strength of what it says (round 13).
 *   narration       -> collapsed behind the same affordance with a bare label
 *                      (legacy alias: orchard-notes).
 *   uncategorized   -> expanded, and deliberately NOT styled as an error: the
 *                      reader loses nothing, and the label the author gave it is
 *                      what the metrics cluster.
 *   anything else   -> FALLBACK: ordinary prose, in document order, in place.
 *                      Never hidden, never dropped, never styled as an error.
 *
 * WHICH CATEGORIES FOLD, and why (the list itself lives in the grammar module —
 * see COLLAPSED_BLOCKS there for the rule and its history). A category folds if
 * the reader does not have to read it to know WHERE THEY STAND: the ask, the
 * outcome, the status and the call I made are addressed to them; the finding and
 * the narration are the supporting record behind those.
 *
 * WHY A FOLDED FINDING GETS A PREVIEW AND A FOLDED NARRATION DOES NOT. `finding`
 * is 34.7% of characters in the labelled sample and `narration` is 3.5%. Folding
 * narration hides a footnote; folding findings hides a THIRD of the reply, and
 * behind a caption reading only "Finding" the reader has to open every one to
 * discover whether it mattered — strictly more work than reading it was. The
 * preview is the first sentence of the block, one line, clamped: enough to skip
 * on, never enough to become the noise the fold removes.
 *
 * The grammar is the SAME module the Stop hook uses (public/lib/response-blocks.js)
 * so the UI and the enforcement half can never disagree about what a message
 * contains. This renderer only decides HOW each parsed piece is shown.
 *
 * Design decisions (charter asked these be justified):
 *   - Collapse state is PER-BLOCK, via a native <details>. This is what the
 *     renderer contract pins ("Collapse state is per-block"), and it is the least
 *     surprising: expanding one turn's notes must not expand another's. A native
 *     <details> gives independent per-instance state, keyboard + screen-reader
 *     support, and needs no global preference plumbing. An already-expanded block
 *     stays expanded as new messages arrive because each is its own DOM node with
 *     its own open state — nothing re-renders it.
 *   - A message that is ONLY notes still renders its <details> affordance, so a
 *     turn that was pure narration collapses to a visible, labelled, expandable
 *     line — it shows a turn happened rather than vanishing.
 *
 * ── THE RENDERER SIDE OF "THE FOLD IS THE ONLY GATE"
 * renderFold() is the ONE place in this file that can put content where the
 * reader and the accessibility tree cannot see it, and it is reached from exactly
 * ONE branch: a parsed block whose name is in COLLAPSED_BLOCKS — the same list
 * the grammar's certainty guard is driven by, so the two cannot disagree about
 * which names can hide. Every other branch — every visible category, a stray
 * digest, a fallback run, and every degradation path — produces
 * ordinary expanded prose. That is deliberate and load-bearing: it means the
 * "no content is ever hidden" invariant is fully delegated to the grammar's
 * certainty guard (public/lib/response-blocks.js, "THE FOLD IS THE ONLY GATE"),
 * and this file cannot reintroduce the defect independently. Adding a second
 * collapsing branch here would reopen the class — if a future block needs to
 * collapse, add it to COLLAPSED_BLOCKS so the guard covers it, never by folding
 * something here that the parser did not classify as collapsed.
 */

/* The twisty glyph the rest of the transcript uses for collapsibles (see .ran). */
const NOTES_TWISTY = '▸';

/**
 * The presentation table. One row per known name, and it is the ONLY place a
 * display decision is made — which is the point of the semantic vocabulary: the
 * author declares what a passage IS, never how it should look.
 *
 * `key` is the CSS modifier (kept short); `label` is what the reader sees.
 * Legacy names map onto the presentation they shipped with, so an archived
 * transcript renders byte-for-byte as it did before round 12.
 */
const BLOCK_PRESENTATION = {
  'orchard-ask': { key: 'ask', label: 'Needs you' },
  // `preview` is the one presentation flag that is not a constant: a folded
  // finding shows its own first sentence in the summary. See the header for why
  // this category gets it and narration does not.
  'orchard-finding': { key: 'finding', label: 'Finding', preview: true },
  'orchard-outcome': { key: 'outcome', label: 'Changed' },
  'orchard-status': { key: 'status', label: 'Where things stand' },
  'orchard-judgment': { key: 'judgment', label: 'My call' },
  'orchard-uncategorized': { key: 'uncat', label: 'Uncategorised' },
  'orchard-narration': { key: 'narration', label: 'Narration', hint: 'what I did this turn' },
  // LEGACY. `answer` shipped undecorated, and it stays undecorated: adding a
  // label to it now would re-caption every archived message with a category its
  // author never chose.
  'orchard-answer': { key: 'answer', label: '' },
  'orchard-notes': { key: 'notes', label: 'Notes', hint: 'internal narration' },
};

/**
 * THE PREVIEW LINE of a folded block: its first SENTENCE, as plain text.
 *
 * Three rules, and each exists because of what a real finding actually looks
 * like (docs/bugs/FEAT-093 sampled them from this project's own transcript):
 *
 *  - CODE IS NOT A SENTENCE. A finding that opens with a fenced snippet would
 *    otherwise preview as "```js", which is worse than no preview. Fenced blocks
 *    are skipped whole, either fence character, closing on a run at least as long
 *    — the same rule the grammar uses, so the two agree on where a block ends.
 *  - MARKUP IS NOT WORDS. The summary is a text node, so `**bold**`, a link, a
 *    heading marker or a list bullet would show as literal syntax. They are
 *    stripped for display only; nothing about the block's content changes.
 *  - A PREVIEW IS NOT A PARAGRAPH. One sentence, and never more than PREVIEW_MAX
 *    characters — cut at a word boundary with an ellipsis so the reader can see
 *    it was cut. CSS clamps it to one line as well (the string bound is what
 *    keeps a screen reader from hearing a paragraph where the eye sees a line).
 *
 * A sentence end is `.`/`!`/`?` followed by whitespace or the end of the text.
 * The minimum length guard is what stops "e.g." and "cf." ending a preview after
 * four characters; a decimal point ("$23.58") is not followed by whitespace and
 * was never a candidate.
 */
const PREVIEW_MAX = 170;
const PREVIEW_MIN_SENTENCE = 24;

function stripMarkupForPreview(line) {
  return line
    .replace(/^\s*>+\s*/, '')                        // block quote marker
    .replace(/^\s*#{1,6}\s+/, '')                    // ATX heading
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')     // list marker
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')       // links / images -> their text
    .replace(/`+/g, '')                              // code spans
    .replace(/(\*\*|__|\*|_|~~)/g, '')               // emphasis
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')   // backslash escapes
    .replace(/\s+/g, ' ')
    .trim();
}

export function foldPreview(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  let first = '';
  for (let i = 0; i < lines.length && !first; i++) {
    const fence = /^ {0,3}((`{3,})|(~{3,}))/.exec(lines[i]);
    if (fence) {
      const run = fence[1];
      const close = new RegExp(`^ {0,3}\\${run[0]}{${run.length},}[ \\t]*$`);
      i++;
      while (i < lines.length && !close.test(lines[i])) i++;
      continue;                                      // i++ from the for-loop skips the closer
    }
    first = stripMarkupForPreview(lines[i]);
  }
  if (!first) return '';
  for (const m of first.matchAll(/[.!?](?=\s|$)/g)) {
    if (m.index + 1 >= PREVIEW_MIN_SENTENCE) { first = first.slice(0, m.index + 1); break; }
  }
  if (first.length <= PREVIEW_MAX) return first;
  const cut = first.slice(0, PREVIEW_MAX);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > PREVIEW_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * A COLLAPSED category -> a <details>. Closed by default; per-instance open
 * state. The summary always reads as a real, labelled control (never a blank line
 * that looks like an empty message) and stays quiet enough not to reintroduce the
 * noise the feature removes.
 *
 * The legacy `orchard-notes` class is kept on the element alongside the generic
 * one so the stylesheet, and anything that ever queried it, keep working.
 */
function renderFold(content, pres) {
  const box = el('details', { class: `orchard-fold orchard-notes ob-${pres.key}` });
  const summary = el('summary', { class: 'orchard-notes-sum' });
  summary.append(el('span', { class: 'orchard-notes-tw', text: NOTES_TWISTY, 'aria-hidden': 'true' }));
  summary.append(el('span', { class: 'orchard-notes-lbl', text: pres.label || 'Narration' }));
  if (pres.hint) summary.append(el('span', { class: 'orchard-notes-hint', text: pres.hint }));
  if (pres.preview) {
    const p = foldPreview(content);
    if (p) summary.append(el('span', { class: 'orchard-notes-prev', text: p }));
  }
  box.append(summary);
  const body = el('div', { class: 'orchard-notes-body' });
  body.append(prose(content));
  box.append(body);
  return box;
}

/**
 * A VISIBLE category -> ordinary prose under a quiet category label. The label is
 * the whole reader-facing payoff of the semantic vocabulary: it is how someone
 * skimming finds the ask without reading the narration. It is a real text node,
 * not a ::before, so it reaches the accessibility tree and a text search.
 *
 * `orchard-answer` (legacy) and an unlabelled entry render with no caption at
 * all — undecorated prose, exactly as they always did.
 */
function renderVisible(content, pres, label) {
  const box = el('div', { class: `orchard-blk orchard-answer ob-${pres.key}` });
  if (pres.label) {
    const cap = el('div', { class: 'ob-cap' }, el('span', { class: 'ob-cap-lbl', text: pres.label }));
    // The author's free-text label on an `orchard-uncategorized` block: shown,
    // because a reader deserves to know what the agent thought this was when it
    // could not name a category for it.
    if (label) cap.append(el('span', { class: 'ob-cap-note', text: label }));
    box.append(cap);
  }
  box.append(prose(content));
  return box;
}

/**
 * Turn a parsed message (blocks + fallback runs) into an ordered array of render
 * nodes. Blocks and fallback runs are interleaved by their source line, so the
 * document order the author wrote — answer, then notes, then more answer — is
 * exactly what renders. Only a KNOWN category gets special treatment; everything
 * else (fallback runs, a stray digest, an unknown name) is ordinary prose.
 *
 * `parsed` is assumed to carry at least one KNOWN block or one unknown-block run
 * (the caller handles the truly-structureless case as byte-for-byte prose).
 */
function blocksToNodes(parsed, projectId) {
  const items = [];
  for (const b of parsed.blocks) items.push({ line: b.startLine, block: b });
  for (const r of parsed.fallbackRuns) items.push({ line: r.startLine, run: r });
  items.sort((a, z) => a.line - z.line);

  const nodes = [];
  for (const it of items) {
    if (it.run) { if (it.run.text.trim()) nodes.push(prose(it.run.text)); continue; }
    const b = it.block;
    const pres = BLOCK_PRESENTATION[b.name];
    // THE ONE HIDING BRANCH, and it is gated on the grammar's own collapsed list
    // rather than on a name written here — a second list could disagree with the
    // certainty guard, and that disagreement is the whole hidden-content class.
    if (pres && COLLAPSED_BLOCKS.includes(b.name)) nodes.push(renderFold(b.content, pres));
    else if (pres) nodes.push(renderVisible(b.content, pres, b.label));
    // A stray orchard-digest in the BODY (spec: digest is once, first, and is
    // lifted above). Render its content as ordinary prose so nothing is lost; we
    // never paint a second structured digest.
    else if (b.content.trim()) nodes.push(prose(b.content));
  }
  return nodes;
}

/**
 * Is `parsed` led by a (necessarily malformed) orchard-digest block? Reached only
 * after parseDigest() has already returned null, so a leading digest block here
 * means the fence is present but its JSON is unusable — FEAT-083 says render the
 * WHOLE message as ordinary prose in that case, and layer 2 must preserve it.
 */
function leadingDigestBlock(parsed) {
  const first = parsed.blocks[0];
  if (!first || first.name !== 'orchard-digest') return false;
  return !parsed.fallbackRuns.some((r) => r.startLine < first.startLine);
}

/**
 * Render the BODY of a message (everything below any lifted digest) as its
 * layer-2 blocks. Returns an array of nodes. A body with NO orchard-* structure
 * at all renders byte-for-byte as today — one prose() over the whole text — so a
 * plain reply and every degradation case gains zero ceremony.
 */
function renderBody(text, projectId) {
  // Idempotent: the caller normalises, but this is the other public-ish entry to
  // the prose path and it must not depend on who called it.
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  let parsed;
  try { parsed = parseResponseBlocks(src); }
  catch { return src.trim() ? [prose(src)] : []; } // a parse error can never swallow a message

  // Truly structureless -> plain prose, byte-for-byte. This is BOTH the expected
  // short-reply path AND every degradation case: an unterminated fence, a fence
  // inside a code block, a lone unterminated orchard-* fence — the parser leaves
  // all of them as fallback with no known blocks and no recorded unknown block.
  if (!parsed.blocks.length && !parsed.unknownBlocks.length) {
    return src.trim() ? [prose(src)] : [];
  }
  const nodes = blocksToNodes(parsed, projectId);
  return nodes.length ? nodes : (src.trim() ? [prose(src)] : []);
}

/**
 * The digest-aware render of a single assistant text block — the drop-in the
 * transcript renderer uses in place of a bare prose(). Returns ONE node.
 *
 *   - disabled for the project        -> prose(text), no parsing at all.
 *   - valid leading digest            -> a wrapper: the structured digest, then
 *                                        the body's layer-2 blocks below it.
 *   - malformed leading digest        -> prose(text) whole message (FEAT-083).
 *   - no digest, has answer/notes     -> the body's layer-2 blocks.
 *   - no blocks at all                -> prose(text), byte-for-byte the old path.
 *
 * @param {string} text
 * @param {{ enabled?: boolean, projectId?: string|null }} [opts]
 */
export function renderAssistantText(text, opts = {}) {
  const { enabled = true, projectId = null } = opts;
  // NORMALISE LINE ENDINGS ONCE, AT THIS BOUNDARY — the render half of the rule
  // parseResponseBlocks() applies to the parse half (see its header). Everything
  // below is a line-shaped rule: the block grammar, the digest fence regex, and
  // prose()'s fence splitting. If they disagree about where lines are, content
  // moves between regions or disappears — prose() strips a code chunk's first
  // line as its info string, so a lone CR right after a fence run silently ate
  // the next region. One replace here and every downstream rule inherits it,
  // rather than each having to remember. (CRLF / lone CR / LF are CommonMark's
  // three line endings; nothing else is one to either half.)
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!enabled) return prose(src);

  const d = parseDigest(src);
  if (d) {
    const wrap = el('div', { class: 'msg-with-digest' });
    wrap.append(renderDigest(d.items, { projectId }));
    // The body below the digest. Skip entirely for a digest-only message.
    if (d.rest.trim()) for (const n of renderBody(d.rest, projectId)) wrap.append(n);
    return wrap;
  }

  // No VALID leading digest. Distinguish a MALFORMED leading digest (whole
  // message as prose, per FEAT-083) from a message with no leading digest fence.
  let parsed;
  try { parsed = parseResponseBlocks(src); } catch { return prose(src); }
  if (leadingDigestBlock(parsed)) return prose(src);
  if (!parsed.blocks.length && !parsed.unknownBlocks.length) return prose(src);

  const nodes = blocksToNodes(parsed, projectId);
  if (!nodes.length) return prose(src);
  if (nodes.length === 1) return nodes[0];
  const wrap = el('div', { class: 'msg-layer2' });
  for (const n of nodes) wrap.append(n);
  return wrap;
}
