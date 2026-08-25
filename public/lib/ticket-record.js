/**
 * The ticket VIEW MODEL — one normalised shape for both ticket formats.
 *
 * WHY THIS EXISTS. The board is migrating (docs/analysis/ticket-board-redesign-plan.md)
 * from prose tickets to tickets that carry a leading fenced ```orchard-ticket JSON
 * block holding the whole human layer. The migration runs ticket-by-ticket, so the
 * board is MIXED for as long as it takes — and a renderer that only understands one
 * of the two formats is a renderer that lies about half the board.
 *
 * So the view builds ONE model from whichever format it is handed:
 *
 *   · migrated — every human-layer field comes straight off the record, verbatim.
 *   · legacy   — the fields that genuinely exist are carried over (title, status,
 *     severity, area, reported, the server-parsed decision). The human-layer
 *     fields do not exist in that format, so they are `null` and the renderer
 *     prints the literal words "Not recorded"; the ticket's original body renders
 *     beneath, whole and expanded.
 *
 * NO SYNTHESISED SUMMARY, and this is the load-bearing rule. An earlier round of
 * this file quoted the first 60 words of a legacy ticket's opening section into
 * the summary slot with a caption saying so. The user's objection killed it, and
 * it generalises: a machine cut of a section is neither a summary nor the
 * content. It stops mid-sentence, it saves the reader nothing, and its own
 * caption admits they must scroll down and read the same words again. A summary
 * is an AUTHORED value; no tracker manufactures one by truncation. So absence is
 * stated, never papered over — and never elided with an ellipsis anywhere: if a
 * field is missing it says "Not recorded", and if content is long the deep layer
 * collapses it WHOLE. Collapsing is legitimate; truncating is not.
 *
 * WHY THE PARSE IS DUPLICATED. `scripts/lib/ticket-schema.mjs` owns the format and
 * is the single parser for every NODE consumer. It is not reachable from the
 * browser (only `public/` is served), and copying the whole module into the client
 * would mean two validators. So this file duplicates exactly one thing — the block
 * EXTRACTOR, ~10 lines — and duplicates no rule: it validates nothing, defaults
 * nothing, and treats an unreadable block as unreadable rather than guessing.
 * Keep `RECORD_FENCE_RE` byte-identical to `extractTicketBlock()` there.
 */

/** What a `null` human-layer field renders as. Never "", never "—", never silence. */
export const NOT_RECORDED = 'Not recorded';

/** The leading fenced block — must be the FIRST non-blank content in the file, so
 *  a fenced example deeper in a body can never be mistaken for the record.
 *  (Mirror of scripts/lib/ticket-schema.mjs `extractTicketBlock`.) */
const RECORD_FENCE_RE = /^\s*```orchard-ticket[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/;

/** The FIRST non-blank line, when it OPENS a record fence. `RECORD_FENCE_RE` is
 *  a single anchored match: if the block is never closed — the shape a partial
 *  write leaves, because losing the tail loses the closing fence — the regex does
 *  not match at all and the file used to fall through to the LEGACY path, where
 *  the page announced "Not migrated" and drew a state pill off the board index
 *  about a file that is visibly a half-written migration. Detecting the opener is
 *  a DIAGNOSIS, not a second parser: it validates nothing, defaults nothing, and
 *  reads no JSON. `RECORD_FENCE_RE` above stays byte-identical to
 *  scripts/lib/ticket-schema.mjs's, which is the rule that matters.
 *
 *  IT IS NEVERTHELESS A SECOND GRAMMAR for "what opens a record", and that
 *  duplication is filed as ARCH-008 and awaits a human decision. Exported so
 *  verify-ticket-view-redesign can ask BOTH grammars the same question and
 *  report where they disagree — evidence for that decision, not a fix for it. */
const RECORD_OPENER_RE = /^```orchard-ticket$/;

export function openerIndex(src) {
  let at = 0;
  for (const line of src.split('\n')) {
    if (line.trim()) return RECORD_OPENER_RE.test(line.trim()) ? at + line.indexOf('`') : -1;
    at += line.length + 1;
  }
  return -1;
}

/**
 * Split a ticket file into its record block and its markdown body.
 * `source` is the whole file as the splitter saw it, so a caller that must not
 * drop a byte can fall back to it rather than reassembling one from the parts.
 * `fence` is the matched region INCLUDING its fences, exactly as it appears in
 * the file — the byte-exact copy a renderer needs when it must show the block
 * itself rather than parse it.
 * @returns {{ block: string|null, body: string, source: string, fence: string|null,
 *   unterminated: boolean }}
 */
export function extractTicketBlock(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = RECORD_FENCE_RE.exec(src);
  if (!m) {
    const at = openerIndex(src);
    return at < 0
      ? { block: null, body: src, source: src, fence: null, unterminated: false }
      // Never closed: the block is everything from the opener to EOF. There is no
      // prose after it to separate out, because the file stops mid-record.
      : { block: src.slice(at), body: '', source: src, fence: src.slice(at).replace(/\r?\n$/, ''), unterminated: true };
  }
  // `^\s*` MATCHES NEWLINES, so `m[0]` starts at byte 0 of the file rather than
  // at the opening fence, and any blank lines or indentation before the block
  // rode into `fence` — and were printed inside a <pre> captioned "verbatim and
  // whole". Over-inclusion, not loss, and it takes a hand edit to produce
  // (formatTicket writes the fence at byte 0) — but a block that is not the block
  // is exactly what this <pre> exists not to be. The prefix is whitespace BY
  // CONSTRUCTION: `\s*` is the only thing the pattern can consume before the
  // backticks, so slicing it off can never drop content (asserted in
  // verify-ticket-view-redesign, not merely reasoned).
  const lead = /^\s*/.exec(m[0])[0].length;
  return {
    block: m[1],
    body: src.slice(m[0].length),
    source: src,
    // …and the trailing line terminator after the closing fence is body, not block
    fence: m[0].slice(lead).replace(/\r?\n$/, ''),
    unterminated: false,
  };
}

/**
 * Read the record, if there is one.
 *
 * A block that is present but unparseable is NOT silently degraded to "legacy":
 * that is a corrupt ticket and the reader is told so (`parseError`), because a
 * ticket that has been migrated and then broken is a different fact from a ticket
 * that was never migrated, and only one of them needs a human.
 *
 * AND ITS BYTES ARE NOT DROPPED. An earlier round returned the post-block `body`
 * here, exactly as it does for a healthy ticket — so the one text the reader
 * needs in order to FIX the file (the unparseable block itself) was the one text
 * the view could not show, while the view's own error note told them the original
 * was shown in full. That is the truncation defect one layer down: a fallback
 * that overstates itself. So on a parse failure `body` is the WHOLE FILE,
 * verbatim, fences and all — the renderer draws the block as a code block and
 * the claim becomes literally true. The raw block is also handed back on its own
 * (`rawBlock`) so the message can be specific about where it went.
 *
 * Returning the source rather than re-fencing the block is deliberate: a
 * reconstruction can differ from the file (line endings, trailing spaces on the
 * fence line, the info string), and a "verbatim" copy that is not byte-identical
 * is the same lie in a smaller font.
 *
 * AND `body` IS NOT WHAT THE RENDERER SHOULD DRAW. It is the completeness
 * guarantee — every byte of the file, reachable from the model, for any consumer
 * that must not lose one. But `prose()` models a fence as `src.split(/```/)`, a
 * character-run split (BUG-111), so handing it a file whose record block quotes
 * an inline ``` run — which a ticket ABOUT fenced code legitimately does; at
 * least six real ones do — terminates the <pre> mid-value and lets the
 * info-string strip eat the next line. A second clean-room round measured 16 of
 * 49 record lines still unreachable that way, `work_state` among them.
 *
 * So the two jobs are separated and named. `fence` is the block byte-exact, for
 * a renderer that must PRINT it and must not route it through a markdown parser
 * at all; `proseBody` is the markdown after the block, which is the only part
 * `prose()` should ever see. A renderer that keeps promising "verbatim, fences
 * included" has to be given something it can keep the promise with.
 *
 * @returns {{ record: object|null, body: string, proseBody: string,
 *   parseError: string|null, rawBlock: string|null, rawFence: string|null }}
 */
export function readTicketRecord(text) {
  const { block, body, source, fence, unterminated } = extractTicketBlock(text);
  const broken = (parseError) => ({
    record: null, body: source, proseBody: body, rawBlock: block, rawFence: fence, parseError,
  });
  if (block === null) {
    return { record: null, body, proseBody: body, parseError: null, rawBlock: null, rawFence: null };
  }
  // A block that was opened and never closed. This is what a PARTIAL WRITE leaves
  // behind, and it is the one corruption whose shape hides itself: losing the tail
  // loses the closing fence, so the extractor sees no record at all and the ticket
  // reads as one that was never migrated — complete with a state pill taken from
  // the board index. It is stated as what it is instead.
  if (unterminated) {
    return broken('the ticket\'s orchard-ticket block is opened but never closed — no closing ``` fence '
      + 'appears anywhere in the file, which is what a partly-written or truncated file looks like');
  }
  let record = null;
  try {
    record = JSON.parse(block);
  } catch (err) {
    return broken(`the ticket's orchard-ticket block is not valid JSON — ${err.message}`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return broken('the ticket\'s orchard-ticket block is not a JSON object');
  }
  return { record, body, proseBody: body, parseError: null, rawBlock: null, rawFence: null };
}

/**
 * Characters in a byte-exact block that a reader cannot correctly read off the
 * screen — CLASSIFIED, because they are not one hazard and one sentence cannot
 * be true of all of them.
 *
 * An earlier round of this ticket flagged the whole set and told the reader they
 * "can make the order you SEE differ from the order stored". That is true of a
 * bidi format control and FALSE of every other member: a NUL, a zero-width
 * space, a BOM and a line separator reorder nothing. It pointed a reader holding
 * a NUL-bearing record at display order and away from the actual hazard, which is
 * a byte they cannot see at all. It was the replacement for a false CSS claim,
 * so the correction traded one untrue sentence for another — which is why the
 * class travels with the character now, and why the suite asserts the sentence is
 * TRUE of the case rather than merely present.
 *
 *   bidi      — reorders what follows; the drawn order differs from the stored one
 *   separator — breaks the line where the surrounding text does not show a break
 *   zeroWidth — occupies no space; text can differ from what it appears to say
 *   control   — non-printing; a value can hold one and look ordinary
 *
 * The classes are built from CODE POINTS rather than literals, because a NUL or
 * an RTL override pasted into this file would be invisible to its next reader too.
 *
 * @returns {Array<{ cp: string, n: number, kind: string }>} sorted by code point
 */
const C = (a) => String.fromCharCode(a);
const R = (a, b) => C(a) + '-' + C(b);
const INVISIBLE_CLASSES = [
  // U+061C ALM, U+200E/200F LRM/RLM, U+202A-202E embeddings+overrides, U+2066-2069 isolates
  ['bidi', new RegExp('[' + C(0x061C) + C(0x200E) + C(0x200F) + R(0x202A, 0x202E) + R(0x2066, 0x2069) + ']')],
  ['separator', new RegExp('[' + C(0x2028) + C(0x2029) + ']')],
  // U+200B ZWSP, U+200C/200D joiners, U+2060-2064 word joiner family, U+FEFF BOM
  ['zeroWidth', new RegExp('[' + C(0x200B) + C(0x200C) + C(0x200D) + R(0x2060, 0x2064) + C(0xFEFF) + ']')],
  // C0 minus tab/LF/CR, plus DEL
  ['control', new RegExp('[' + R(0x00, 0x08) + C(0x0B) + C(0x0C) + R(0x0E, 0x1F) + C(0x7F) + ']')],
];

export function invisibleRuns(text) {
  const counts = new Map();
  for (const ch of String(text ?? '')) {
    const hit = INVISIBLE_CLASSES.find(([, re]) => re.test(ch));
    if (!hit) continue;
    const cp = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    const prev = counts.get(cp);
    if (prev) prev.n += 1;
    else counts.set(cp, { cp, n: 1, kind: hit[0] });
  }
  return [...counts.values()].sort((a, b) => (a.cp < b.cp ? -1 : 1));
}

/** The wording that is TRUE of each class. One sentence per class present —
 *  never one sentence over the union, which is how the false claim happened. */
export const INVISIBLE_CLAIM = {
  bidi: 'reorder the characters after them, so the order you SEE differs from the order stored',
  separator: 'break the line at a point the surrounding text does not show',
  zeroWidth: 'occupy no space at all, so the text can differ from what it appears to say',
  control: 'are non-printing, so a value can contain one and still look ordinary',
};

/* ────────────────────────────────────────────────────── the view model ── */

const TYPE_FROM_PREFIX = { BUG: 'bug', FEAT: 'feature', ARCH: 'architecture', DEPLOY: 'deploy' };
const TYPE_LABEL = { bug: 'BUG', feature: 'FEAT', architecture: 'ARCH', deploy: 'DEPLOY' };

/** Human wording for the enums. The UI never invents a second vocabulary. */
export const WORK_STATE_LABEL = {
  open: 'Open', in_progress: 'In progress', in_verification: 'In verification',
  verified: 'Verified', done: 'Done', blocked: 'Blocked', not_a_bug: 'Not a bug',
};
export const HUMAN_ACTION_LABEL = {
  none: null, decide: 'Decide', answer_question: 'Answer a question',
  review: 'Review', staged_decision: 'Decide (staged)', multi_select_decision: 'Decide (multi-select)',
};
/**
 * THE ONE RULE ABOUT PROOF (ARCH-009, option C + B's surviving content).
 *
 * There is no `verification_state` field any more. It was a fifth state enum
 * COMPUTED by a precedence sequence over `Verified-by:` lines regex-scanned out
 * of the whole ticket — an unattributed set (a QUOTED verdict is
 * indistinguishable from an asserted one), folded to its LAST element, under
 * rules ordered by the history of their own discovery. Three rounds, three
 * stop-everything defects, none found by the fixer. ARCH-009 removed the
 * derivation instead of adding a fourth guard, so nothing computes a state from
 * prose any more.
 *
 * `verification[]` is what survives: ATTRIBUTED data in the record block, each
 * entry a `{provider, run_id, verdict}` a migration transcribed from a line the
 * ticket asserts. Any consumer that wants "show me the broken tickets"
 * re-derives it from that array, and this is the rule — B's content, kept:
 *
 *   **an outstanding `broken` is a `broken` with no LATER `holds`** —
 *   never "the last record".
 *
 * That distinction is the whole of ARCH-009 round 3's live defect: `FEAT-061`
 * ends `broken,broken,broken,invalid,invalid,invalid,invalid` and `FEAT-062`
 * ends `broken,broken,invalid,broken,invalid`. `invalid` is a legal verdict —
 * the ordinary outcome of a clean-room run that fails its own contract — so
 * reading the last element reported both as proven while an unresolved defect
 * stood. A verdict that resolves nothing must not change the answer, which is
 * exactly what this fold does: only `holds` clears, only `broken` raises,
 * everything else is inert.
 *
 * It is a FOLD OVER THE WHOLE ARRAY and it lives in exactly one place. Grep
 * `outstandingBroken` — if a second rule about proof ever appears outside this
 * function, that is the class coming back.
 *
 * @param {Array<{verdict?: string}>} verification the record's `verification[]`
 * @returns {boolean} true iff a `broken` verdict stands unresolved
 */
export function outstandingBroken(verification) {
  let outstanding = false;
  for (const e of Array.isArray(verification) ? verification : []) {
    const v = typeof e?.verdict === 'string' ? e.verdict.toLowerCase() : null;
    if (v === 'broken') outstanding = true;
    else if (v === 'holds') outstanding = false;
  }
  return outstanding;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Build the view model for one ticket payload from `/api/projects/:id/tickets/:tid`.
 *
 * @param {object} t the server ticket payload (id, title, status, section, sev,
 *   area, markdown, decision, answer, statusError, statusWarning, lastActivity…)
 */
export function ticketView(t) {
  const r = readTicketRecord(t?.markdown ?? '');
  return r.record ? migratedView(t, r.record, r.body) : legacyView(t, r);
}

function migratedView(t, r, body) {
  const type = str(r.type) ?? TYPE_FROM_PREFIX[String(t?.id || '').split('-')[0]] ?? null;
  return {
    migrated: true,
    recordUnreadable: false,
    rawRecordBlock: null,
    rawRecordFence: null,
    rawRecordInvisibles: [],
    proseBody: body,
    parseError: null,
    id: str(r.id) ?? t?.id ?? null,
    type,
    typeLabel: TYPE_LABEL[type] ?? String(t?.id || '').split('-')[0] ?? '',
    title: str(r.title) ?? t?.title ?? null,
    summary: str(r.summary) ? { text: r.summary.trim(), from: null } : null,
    impact: str(r.impact_if_we_wait),
    need: str(r.current_need),
    severity: str(r.severity),
    area: str(r.area),
    reported: str(r.reported),
    reportedBy: str(r.reported_by),
    owner: str(r.owner),
    updated: str(r.updated) ?? str(t?.lastActivity),
    workState: str(r.work_state),
    humanAction: str(r.human_action),
    // ARCH-009: there is no derived proof STATE. `verification[]` below is the
    // attributed evidence and `outstandingBroken()` is the only rule over it.
    verificationClass: str(r.verification_class),
    decision: richDecision(r.decision),
    decisionHistory: list(r.decision_history),
    successCriteria: list(r.success_criteria),
    codeRefs: list(r.code_refs),
    related: list(r.related),
    recurrence: list(r.recurrence_evidence),
    verification: list(r.verification),
    bodySlots: (r.body_slots && typeof r.body_slots === 'object') ? r.body_slots : {},
    source: (r.source && typeof r.source === 'object') ? r.source : {},
    body,
  };
}

/**
 * A legacy ticket, carried into the same shape. Every value here is a real field
 * of the old format; the human-layer fields it has no equivalent for stay null
 * and render as "Not recorded", with the whole original body below them.
 *
 * A ticket whose record is BROKEN also lands here — it has no readable human
 * layer, so it renders like one that never had one. But `recordUnreadable` keeps
 * the two apart, because the renderer must not tell a reader that a migrated,
 * corrupt ticket "has not been migrated": that sends them to the migration
 * backlog for a file that needs its JSON repaired.
 */
function legacyView(t, r) {
  const { body, parseError, rawBlock, rawFence, proseBody } = r;
  const prefix = String(t?.id || '').split('-')[0];
  const type = TYPE_FROM_PREFIX[prefix] ?? null;
  const sev = String(t?.sev || '').toLowerCase();
  return {
    migrated: false,
    recordUnreadable: !!parseError,
    rawRecordBlock: rawBlock,
    // byte-exact, fences included — the only thing a renderer may print when it
    // says "verbatim", and never routed through prose() (BUG-111's fence model)
    rawRecordFence: rawFence,
    // characters that can make the rendered order differ from the byte order
    rawRecordInvisibles: invisibleRuns(rawFence),
    // the markdown AFTER the block: the only part prose() should ever parse
    proseBody,
    parseError,
    id: t?.id ?? null,
    type,
    typeLabel: TYPE_LABEL[type] ?? prefix,
    // THE TITLE OF A BROKEN RECORD. The server derives a legacy ticket's title
    // from the file's first heading — and the first line of a MIGRATED file is
    // ```orchard-ticket, so a ticket whose record will not parse arrived with the
    // fence marker as its title and printed it, 21px bold, at the top of the
    // page. The file's own H1 is real content sitting in the body; it is read
    // here rather than invented, and if there is none the title is simply absent.
    title: parseError ? (bodyTitle(body, t?.id) ?? cleanTitle(t?.title)) : str(t?.title),
    // The three human-layer fields the old format has no equivalent for. They are
    // null on purpose: see the "no synthesised summary" rule at the top.
    summary: null,
    impact: null,
    need: null,
    severity: sev.startsWith('hig') ? 'high' : sev.startsWith('med') ? 'medium' : sev.startsWith('low') ? 'low' : null,
    area: str(t?.area),
    reported: legacyField(body, 'Reported'),
    reportedBy: null,
    owner: t?.needsYou ? 'you' : (String(t?.owner || '').includes('🤖') ? 'agent' : null),
    updated: str(t?.lastActivity),
    // The legacy state is PROSE, and the server already told us whether it could
    // be read at all (statusError/statusWarning, ARCH-004). So the derived
    // done/open section is carried, and the raw sentence is carried beside it —
    // never merged, because one is a machine value and the other is a mood.
    workState: t?.section === 'done' ? 'done' : 'open',
    workStateDerived: true,
    statusProse: str(t?.status),
    humanAction: t?.needsYou ? (t?.decision ? 'decide' : 'review') : 'none',
    verificationClass: null,
    decision: null,           // the rich shape does not exist; the server's parse is used
    decisionHistory: [],
    successCriteria: [],
    codeRefs: [],
    related: [],
    recurrence: [],
    verification: [],
    bodySlots: {},
    source: {},
    body,
  };
}

/** The file's own first `# ` heading, minus a leading `ID — `. Real file content,
 *  not a synthesised value — the "no synthesised summary" rule bars manufacturing
 *  a field, not reading one the file states. */
function bodyTitle(body, id) {
  const m = /^#[ \t]+(.+)$/m.exec(String(body || ''));
  if (!m) return null;
  const head = m[1].trim();
  const esc = String(id ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rest = esc ? new RegExp(`^${esc}\\s*[—–-]\\s*(.*)$`).exec(head)?.[1] : null;
  return str(rest ?? head);
}

/** A title that is really a fence marker is not a title. */
function cleanTitle(t) {
  const v = str(t);
  return v && /^```/.test(v) ? null : v;
}

/** A `- **Field:** value` line from the legacy header. */
function legacyField(body, name) {
  const m = new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.*)$`, 'mi').exec(String(body || ''));
  return m ? (m[1].trim() || null) : null;
}

/**
 * The record's decision, normalised for the renderer. `mode` decides how it is
 * ANSWERED (radio / checkbox / staged), and it is carried explicitly rather than
 * inferred from the option shape — a single-option-looking multi decision is a
 * real thing and flattening it would silently drop the compose semantics.
 */
function richDecision(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const mode = ['single', 'multi', 'staged'].includes(d.mode) ? d.mode : 'single';
  const options = list(d.options).map((o) => ({
    key: str(o?.key) ?? '',
    label: str(o?.label) ?? '',
    what_changes: str(o?.what_changes),
    benefit: str(o?.benefit),
    cost: str(o?.cost),
    why_not_obvious: str(o?.why_not_obvious),
    combines_with: list(o?.combines_with),
    stage: Number.isInteger(o?.stage) ? o.stage : null,
  }));
  return {
    mode,
    question: str(d.question),
    options,
    recommendation: str(d.recommendation),
    recommendation_reason: str(d.recommendation_reason),
    prerequisite: str(d.prerequisite),
    stages: list(d.stages),
  };
}

/**
 * The keys a `multi` recommendation names ("1 + 2 + 4" → ['1','2','4']), or the
 * single key, or []. One parse, so the card and the option rows agree.
 */
export function recommendedKeys(decision) {
  const rec = decision?.recommendation ?? decision?.recommended ?? null;
  if (!rec) return [];
  return String(rec).split('+').map((k) => k.trim()).filter(Boolean);
}

/**
 * The stage a staged decision is currently ASKING about — the lowest stage that
 * has options. Later stages render as "then", and are not answerable: that is the
 * whole point of staging, and a UI that lets you answer stage 2 first has
 * flattened it.
 */
export function activeStage(decision) {
  if (decision?.mode !== 'staged') return null;
  const stages = decision.options.map((o) => o.stage).filter((s) => Number.isInteger(s));
  return stages.length ? Math.min(...stages) : null;
}
