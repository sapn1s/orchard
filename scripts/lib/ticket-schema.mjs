/**
 * ticket-schema.mjs — the ONE definition of a ticket.
 *
 * Step 1 + 2 of docs/analysis/ticket-board-redesign-plan.md §8.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The ticket format was parsed in five places with THREE different definitions
 * of "done":
 *
 *   scripts/board.mjs      VERIFIED | (RE-)FIXED | RESOLVED | <DONE anywhere>
 *   src/server/tickets.ts  VERIFIED | <DONE anywhere>
 *   scripts/arch-watch.mjs VERIFIED | <DONE anywhere>
 *
 * So `- **Status:** FIXED` (BUG-090, verbatim) was Done to the board tool and
 * Open to the ticket API AT THE SAME TIME. Measured over the real corpus on
 * 2026-08-19: 12 tickets were classified two ways (BUG-086/088/089/090/092/
 * 096/097/103/105/106, FEAT-073/078).
 *
 * WHICH RULE WON, AND WHY
 * -----------------------
 * board.mjs's, the broader one. Not arbitrarily:
 *
 *  - board.mjs's rule is the DELIBERATED one. FEAT-068 broadened it to FIXED
 *    and then to RESOLVED/RE-FIXED, each with a recorded rationale, and paired
 *    the broadening with a separate advisory warning for "done but not
 *    independently verified" so the nuance is surfaced rather than expressed as
 *    board placement.
 *  - tickets.ts's own comment claims it uses "the board tool's rule verbatim".
 *    It does not — it is a COPY that never received FEAT-068's broadening. The
 *    disagreement is copy drift, not a designed difference, so honouring
 *    tickets.ts would mean promoting a stale copy over the rule it meant to
 *    quote.
 *  - It is the rule the visible board already reflects: those 12 tickets sit in
 *    INDEX.md's Done table today. Adopting the narrow rule would have moved 12
 *    real tickets back to Open on the next `board:gen`.
 *
 * Adopting the broad rule changes NO ticket's board placement (proven by
 * scripts/verify-ticket-schema.mjs, which replays the pre-fix board.mjs rule
 * over all 183 real tickets and asserts byte-equality of the done set) and
 * changes the ticket API + arch-watch on exactly those 12.
 *
 * The nuance the broad rule used to lose is NOT lost here: it moves into a
 * second, orthogonal field. `FIXED` is `work_state: done` +
 * `verification_state: pending`; `VERIFIED` is `work_state: verified` +
 * `verification_state: holds`. Both are done for placement; only one claims
 * proof. That separation is the whole point of ARCH-004's enums.
 *
 * WHAT HAPPENS TO A STATUS THAT DOES NOT MAP (deliberate, not silent)
 * -------------------------------------------------------------------
 * `classifyLegacyStatus` returns `matched: false` and `workState: null`. It
 * NEVER guesses. Consumers must then:
 *   - `board:check` reports it as a hard ERROR naming the ticket and its raw
 *     status (see UNMAPPABLE STATUS), and
 *   - every done-test treats it as NOT done, so the ticket stays in Open where
 *     a human sees it.
 * Loud plus a fail-toward-human-attention default, rather than a coin flip. A
 * ticket that cannot be classified is a board defect; the previous behaviour —
 * two modules silently guessing differently — is exactly the defect being
 * fixed here, so replacing one silent guess with another would repeat it.
 * (Measured 2026-08-19: 0 of 183 real tickets are unmappable, so making this an
 * error costs nothing today and stops the 18th status word being invented.)
 *
 * …AND AN UNRECOGNISED STATE IS ONLY ONE WAY TO FAIL
 * --------------------------------------------------
 * A state can also be absent, empty, declared TWICE in agreement, or declared
 * twice in CONTRADICTION — and a contradiction is not an unrecognised word, so
 * handling only the latter left the first-line-silently-wins bug intact. All of
 * them are enumerated and routed through the one channel; see
 * `classifyStatusField` for the list and for which are made unrepresentable
 * versus merely reported.
 *
 * AMBIGUOUS STATUSES ARE NOW NAMED
 * --------------------------------
 * board.mjs matches a bare `DONE` ANYWHERE in the status line, on purpose (its
 * comment cites "IN PROGRESS — Phase R DONE; v1 … VERIFIED"). That behaviour is
 * preserved exactly, but it is no longer invisible: when a not-done leading
 * word is overridden to done by an incidental `DONE`, the result carries
 * `ambiguous: true` and a `reason`. This is ARCH-004's ONE recorded blind spot
 * — "a ticket mis-classified as done by an incidental word" — turned from an
 * unobservable event into a reportable one.
 *
 * PORTABILITY CONTRACT — DO NOT BREAK
 * -----------------------------------
 * This file is copied verbatim into onboarded repos alongside board.mjs and
 * arch-watch.mjs (onboard.mjs COPIED_TOOLS, fleet-sync.mjs SYNCED_TOOLS).
 * It must therefore stay:
 *   - a single file,
 *   - dependency-free (NO imports at all, not even node builtins — it is pure
 *     functions over strings, which is stronger than "builtins only"),
 *   - importable by both ESM .mjs and, via ticket-schema.d.mts, TypeScript.
 */

/* ─────────────────────────────────────────────────────────── enums (§2.3–2.5) */

/** Ticket type, derived from the id prefix but stored so no renderer re-derives. */
export const TICKET_TYPES = ['bug', 'feature', 'architecture', 'deploy'];

/** The machine work state. ARCH-004 option B: a fixed set, not prose. */
export const WORK_STATES = ['open', 'in_progress', 'in_verification', 'verified', 'done', 'blocked', 'not_a_bug'];

/** What, if anything, the ticket needs a HUMAN to do. */
export const HUMAN_ACTIONS = ['none', 'decide', 'answer_question', 'review', 'staged_decision', 'multi_select_decision'];

/**
 * THE LEGACY STATUS LINE'S proof half — the other thing a prose `- **Status:**`
 * word says besides the work state ("FIXED" is done-but-unproven, "VERIFIED" is
 * done-and-proven). It is a TRANSCRIPTION of one authored word by one fixed
 * table (`LEGACY_STATUS_TABLE`), which is why it survives ARCH-009.
 *
 * It is NOT a record field. ARCH-009 removed `verification_state` from the
 * ticket record because THAT value was derived — folded out of `Verified-by:`
 * lines regex-scraped from the whole file, an unattributed set read partially.
 * A migrated ticket has `verification[]` and nothing else; see RETIRED_KEYS.
 */
export const VERIFICATION_STATES = ['not_required', 'not_recorded', 'pending', 'holds', 'broken'];

export const SEVERITIES = ['low', 'medium', 'high', 'not_recorded'];
export const OWNERS = ['you', 'agent', 'unassigned'];
export const DECISION_MODES = ['single', 'multi', 'staged'];
export const VERDICTS = ['holds', 'broken', 'invalid'];
export const VERIFICATION_CLASSES = ['fix', 'plan+review', 'arch', 'trivial', 'docs-only', 'exempt'];
export const RELATIONS = ['supersedes', 'superseded_by', 'depends_on', 'blocks', 'duplicate_of', 'recurrence_of', 'see_also'];

/** The closed, ordered set of deep-layer H2 slots (§2.5). */
export const BODY_SLOTS = ['Diagnosis', 'Evidence', 'Implementation notes', 'Verification plan', 'Migration and rollback', 'Risks', 'Activity log'];

/**
 * `body_slots` — WHICH deep-layer sections a body actually contains, DERIVED
 * from the body and never asserted by whoever is writing the record.
 *
 * It lives here, next to `BODY_SLOTS` and next to the validator that grades it,
 * because two writers now compose records: the migration (`compose` in
 * scripts/migrate-tickets.mjs) and the board tool (`file` in
 * scripts/board-tool.mjs). A second copy of this loop is how the two would come
 * to disagree about whether a ticket has an Activity log — the ARCH-008 shape.
 *
 * `\b`, not `$`, on purpose: the real corpus's log heading carries a suffix
 * (`## Activity log (APPEND-ONLY — never edit or delete a prior entry)`) which is
 * copied verbatim and must still count as the slot being present.
 */
export function deriveBodySlots(body) {
  const src = String(body == null ? '' : body);
  const slots = {};
  for (const slot of BODY_SLOTS) {
    slots[slot] = new RegExp(`^## ${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(src);
  }
  return slots;
}

/**
 * THE definition of done, as a set over `work_state`. Every consumer asks this
 * question here and nowhere else.
 *
 * `not_a_bug` is deliberately NOT done: it still needs a human's eyes before it
 * leaves the Open table, which is how both pre-existing rules treated it.
 */
export const DONE_WORK_STATES = ['verified', 'done'];

/** Relation → its required back-edge (§2.5: both directions are written). */
export const RELATION_INVERSE = {
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  depends_on: 'blocks',
  blocks: 'depends_on',
  duplicate_of: 'duplicate_of',
  recurrence_of: 'recurrence_of',
  see_also: 'see_also',
};

/* ──────────────────────────────────────────────────────── shared expressions */

/** A ticket FILE name: `<ID>-<slug>.md`. Capture 1+2 join to the id. */
export const TICKET_FILE_RE = /^(ARCH|BUG|FEAT|DEPLOY)-(\d+)-.*\.md$/;
/**
 * A bare ticket id, LENIENTLY — `\d+`, matching what board.mjs and tickets.ts
 * have always accepted when reading today's files. Used by every reader.
 */
export const TICKET_ID_RE = /^(ARCH|BUG|FEAT|DEPLOY)-\d+$/;
/**
 * The id shape the NEW format requires (plan §2.3: `\d{3}`). Stricter than the
 * reader on purpose: a legacy file with a two-digit id must still be readable,
 * but nothing may be WRITTEN in the new format with one.
 */
export const STRICT_TICKET_ID_RE = /^(ARCH|BUG|FEAT|DEPLOY)-\d{3}$/;
/** A ticket id appearing inside prose. Global — clone before stateful use. */
export const TICKET_ID_IN_TEXT_RE = /\b(?:ARCH|BUG|FEAT|DEPLOY)-\d+\b/g;
/** The em dash the H1 convention uses. */
export const EM_DASH = '—';

/**
 * BUG-127 — one markdown table cell, safe for ANY free text.
 *
 * A generated table interpolates values a person wrote (a ticket's H1 title, a
 * `--allow-legacy` reason). Escaping only `|` fixes the cell terminator and
 * leaves the two larger terminators intact, so the rule here is the CLASS:
 * anything that can end a cell, end a row, or end the rendered region.
 *
 *  - **row terminator** — every line break. CRLF, a lone CR (ARCH-006: renderers
 *    disagree about it, so it must not survive into generated source at all),
 *    LF, and U+2028/U+2029, which JavaScript and some renderers treat as line
 *    breaks. A newline in a value splits its own row into a half-row plus loose
 *    prose, and `## a heading` in that prose becomes a heading in the document.
 *  - **region terminator** — `<`. It opens every HTML construct markdown
 *    honours: `<!--` starts a comment that hides every following row until a
 *    `-->` that may never come, and a block-level tag ends the table. As `&lt;`
 *    it can open none of them and still renders as a literal `<`.
 *  - **cell terminator** — `|`, and `\` BEFORE it. A raw `\|` in the value would
 *    otherwise be emitted as `\` + `\|`: the `\\` renders as one literal
 *    backslash and the `|` is left live, splitting the cell after all.
 *  - **invisible in the source** — the other C0/C1 controls. A NUL makes `grep`
 *    treat the whole file as binary (BUG-103); an ESC or a BiDi override can
 *    make a reviewed line read differently from the bytes.
 *
 * `&` is deliberately NOT escaped: it cannot terminate a cell, a row or a
 * region, and escaping it would rewrite the three real titles that contain one
 * for no gain. The cost is only that a pre-existing entity renders as its
 * character.
 *
 * Sibling: BUG-126, where an unbounded value wrecked a rendered row rather than
 * a source one. Same class — a free-text value written into a fixed cell.
 */
export function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\r\n?|[\n\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;');
}

const TYPE_BY_PREFIX = { BUG: 'bug', FEAT: 'feature', ARCH: 'architecture', DEPLOY: 'deploy' };

/**
 * BUG-128 — do two ticket ids name the SAME ticket?
 *
 * Compared on a normalised key rather than by string equality, so the check
 * that uses this cannot be walked around by writing the id a slightly different
 * way: `feat-084`, `FEAT-84` and `FEAT-084` are one ticket. Returns false when
 * either side is not a ticket id at all, so a malformed value is reported by
 * the check that owns malformed values, not silently swallowed here.
 */
export function idsMatch(a, b) {
  const key = (id) => {
    const m = /^(arch|bug|feat|deploy)-0*(\d+)$/i.exec(String(id ?? '').trim());
    return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
  };
  const x = key(a);
  return x !== null && x === key(b);
}

/** `BUG-090` → `bug`. Returns null for anything that is not a ticket id. */
export function typeFromId(id) {
  const m = TICKET_ID_RE.exec(String(id || ''));
  return m ? TYPE_BY_PREFIX[m[1]] : null;
}

/** The id a ticket FILE name declares, or null. */
export function idFromFilename(file) {
  const m = TICKET_FILE_RE.exec(String(file || ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** True iff this work_state places the ticket in Done. The single done-test. */
export function isDoneWorkState(workState) {
  return DONE_WORK_STATES.indexOf(workState) !== -1;
}

/* ─────────────────────────────────────────── legacy (prose) status → enums */

/**
 * The legacy status vocabulary, as a table rather than a pile of regexes.
 *
 * Order matters: the FIRST entry whose `re` matches the START of the status
 * line wins, so longer words are listed before their prefixes (`RE-FIXED`
 * before `FIXED`, `IN VERIFICATION` before `IN`).
 *
 * Measured over the real corpus (183 tickets, 2026-08-19) the leading state
 * words actually present are: VERIFIED 127, OPEN 20, DONE 19, FIXED 7,
 * RESOLVED 3, RE-FIXED 2, "IN VERIFICATION" 2, IN-PROGRESS 1, SYNTHESIS 1,
 * VERIFIED/DONE 1. The extra entries below (BLOCKED, WONTFIX, WIP, NOT-A-BUG,
 * CLOSED) are not speculation about this board — they are the words onboarded
 * repos and the templates already use, and each one costs a line.
 */
/**
 * WHERE A STATE WORD MUST END, and why this is a rejection rather than a repair.
 *
 * Each `re` below ends in `\b`, so `VERIFIED2026-08-13` — the mangled form the
 * corpus survey found — does NOT match, and comes back `matched: false` with a
 * named UNMAPPABLE STATUS error. That is deliberate:
 *
 *  - it is what the previous rule did too (`/^VERIFIED\b/` never matched it
 *    either), so nothing moves on the board;
 *  - the fix is to type one space, and a loud error is what gets that done;
 *  - the alternative — matching a state word run into arbitrary following
 *    characters — would also match `VERIFIEDNOT` and `DONELESS`, which is the
 *    "incidental word sweeps a ticket to Done" failure ARCH-004 recorded.
 *
 * A missing space INSIDE a two-word state name is a different thing and IS
 * accepted (`INVERIFICATION` → `in_verification`): there the whole token is the
 * state, so there is no second field to confuse it with.
 */
export const LEGACY_STATUS_TABLE = [
  { re: /^VERIFIED\s*\/\s*DONE\b/, workState: 'verified', verificationState: 'holds', label: 'VERIFIED/DONE' },
  { re: /^VERIFIED\b/, workState: 'verified', verificationState: 'holds', label: 'VERIFIED' },
  { re: /^RE-?FIXED\b/, workState: 'done', verificationState: 'pending', label: 'RE-FIXED' },
  { re: /^FIXED\b/, workState: 'done', verificationState: 'pending', label: 'FIXED' },
  { re: /^RESOLVED\b/, workState: 'done', verificationState: 'not_recorded', label: 'RESOLVED' },
  { re: /^DONE\b/, workState: 'done', verificationState: 'not_recorded', label: 'DONE' },
  { re: /^CLOSED\b/, workState: 'done', verificationState: 'not_recorded', label: 'CLOSED' },
  { re: /^IN[\s-]*VERIFICATION\b/, workState: 'in_verification', verificationState: 'pending', label: 'IN VERIFICATION' },
  { re: /^IN[\s-]*PROGRESS\b/, workState: 'in_progress', verificationState: 'not_recorded', label: 'IN PROGRESS' },
  { re: /^WIP\b/, workState: 'in_progress', verificationState: 'not_recorded', label: 'WIP' },
  { re: /^BLOCKED\b/, workState: 'blocked', verificationState: 'not_recorded', label: 'BLOCKED' },
  { re: /^NOT[\s-]*A[\s-]*BUG\b/, workState: 'not_a_bug', verificationState: 'not_required', label: 'NOT-A-BUG' },
  { re: /^WON'?T[\s-]*FIX\b/, workState: 'not_a_bug', verificationState: 'not_required', label: `WON'T FIX` },
  { re: /^OPEN\b/, workState: 'open', verificationState: 'not_recorded', label: 'OPEN' },
];

/**
 * Classify a legacy `- **Status:**` line into machine state.
 *
 * Returns `{ workState, verificationState, done, matched, ambiguous, token, reason, raw }`.
 *
 *  - `matched: false` + `workState: null` ⇒ the status does not map. NOT a
 *    guess, NOT a default. `done` is `false` so the ticket stays where a human
 *    sees it, and callers are expected to REPORT it (board:check errors).
 *  - `ambiguous: true` ⇒ a not-done leading word was overridden to done by an
 *    incidental `DONE` token elsewhere in the line. board.mjs has always done
 *    this (its comment defends it); the only change is that it is now visible.
 */
export function classifyLegacyStatus(raw) {
  const rawStr = String(raw == null ? '' : raw);
  const s = rawStr.toUpperCase().trim();
  const base = { raw: rawStr, token: null, ambiguous: false, reason: null };

  if (!s) {
    return { ...base, workState: null, verificationState: null, done: false, matched: false, reason: 'status line is empty or missing' };
  }

  for (const entry of LEGACY_STATUS_TABLE) {
    const m = entry.re.exec(s);
    if (!m) continue;
    const token = m[0];
    // Preserve board.mjs's deliberate match-anywhere DONE: a leading word that
    // is NOT done, with a DONE token later in the line, has always been placed
    // in Done. Keep the placement; surface the ambiguity.
    if (!isDoneWorkState(entry.workState) && /\bDONE\b/.test(s)) {
      return {
        ...base,
        token,
        workState: 'done',
        verificationState: entry.verificationState,
        done: true,
        matched: true,
        ambiguous: true,
        reason: `leading state word "${token}" is not done, but an incidental DONE token later in the status places it in Done`,
      };
    }
    return {
      ...base,
      token,
      workState: entry.workState,
      verificationState: entry.verificationState,
      done: isDoneWorkState(entry.workState),
      matched: true,
    };
  }

  // No leading state word. A DONE token anywhere still closes it (unchanged
  // behaviour — this is how e.g. "SYNTHESIS … DONE" has always been placed).
  if (/\bDONE\b/.test(s)) {
    return {
      ...base,
      workState: 'done',
      verificationState: 'not_recorded',
      done: true,
      matched: true,
      ambiguous: true,
      reason: 'no recognised leading state word; placed in Done by a DONE token elsewhere in the status',
    };
  }

  return {
    ...base,
    workState: null,
    verificationState: null,
    done: false,
    matched: false,
    reason: `no recognised state word — the status begins "${rawStr.slice(0, 40)}"`,
  };
}

/**
 * The done-test every legacy consumer calls. Convenience over
 * classifyLegacyStatus so a call site that only needs the boolean says so.
 */
export function isDoneStatus(raw) {
  return classifyLegacyStatus(raw).done;
}

/**
 * THE REPORT, AS A VALUE — and why it rides on the RECORD, not only on
 * `parseTicket().errors`.
 *
 * The decision that an uninterpretable state is rejected rather than defaulted
 * was, at first, implemented on one path only: `parseTicket` returned
 * `{ record, errors }`, board.mjs read `errors`, and every other consumer read
 * `.record` and threw `errors` away. So the ticket API and arch-watch handed
 * back an ordinary open ticket with no error channel at all, while board:check
 * exited 1 on the same file — two paths reading one file, one loudly and one
 * silently, which is the exact defect the shared parser exists to prevent.
 *
 * A caller can forget to read a SECOND return value. It cannot forget to carry
 * a field of the record it is already copying: `record.statusError` is non-null
 * for exactly the tickets `errors` names, so the loud channel travels WITH the
 * classification instead of beside it. `statusWarning` does the same for the
 * advisory (ambiguous) case.
 *
 * `null` means "this status classified cleanly" — never "nobody looked".
 */
export function statusIssue(file, statusLinePresent, cls) {
  if (!statusLinePresent) return `MISSING STATUS FIELD: ${file || '(unnamed)'}`;
  if (cls.matched) return null;
  // A line that is PRESENT but declares nothing is its own repair ("you deleted
  // the value"), and telling a human "no recognised state word — the status
  // begins """ is a riddle. Same channel, same loudness, accurate sentence.
  if (!String(cls.raw ?? '').trim()) {
    return `EMPTY STATUS FIELD: ${file || '(unnamed)'} — the \`- **Status:**\` line is present but declares no value. ${TYPEABLE_WORDS}`;
  }
  // The words a HUMAN must type, not the regexes that recognise them. This
  // message now reaches a UI client over HTTP (`statusError`), where
  // `IN[\s-]*VERIFICATION` is noise; `label` is the same list, readable.
  return `UNMAPPABLE STATUS: ${file || '(unnamed)'} — ${cls.reason}. ${TYPEABLE_WORDS}`;
}

/** The one sentence that lists the state words a human types. Shared by every status defect message. */
const TYPEABLE_WORDS = `Recognised state words: ${LEGACY_STATUS_TABLE.map((e) => e.label).join(', ')}`;

/**
 * EVERY WAY A TICKET'S STATE CAN FAIL TO BE ONE UNAMBIGUOUS VALUE.
 *
 * b88ad5e made an UNRECOGNISED state loud on every consumer. An independent
 * clean-room pass then found the neighbour: a header carrying BOTH
 * `- **Status:** OPEN` and `- **Status:** VERIFIED` was read by a single
 * `RegExp.exec`, so the FIRST line silently won and all four consumers answered
 * "open" with total confidence and no report. They AGREED — so the
 * "consumers must agree" property held — while the property that actually
 * matters, "a state that cannot be interpreted is reported", failed. An
 * AMBIGUOUS state is not an UNRECOGNISED one, and only the latter was handled.
 *
 * The fix is to enumerate the class rather than patch the instance. A state
 * declaration can fail to be one unambiguous value in exactly these ways, and
 * every one of them now travels the SAME channel (`statusError` for a state
 * that may not be answered about, `statusWarning` for one that may):
 *
 *   1. ABSENT      — no `- **Status:**` line in the header  → MISSING STATUS FIELD (error)
 *   2. EMPTY       — the line is there, the value is not    → EMPTY STATUS FIELD (error)
 *   3. UNRECOGNISED— a word the table does not map          → UNMAPPABLE STATUS (error)
 *   4. DUPLICATED, DISAGREEING — two+ lines classifying differently
 *                                                           → DUPLICATE STATUS FIELD (error)
 *   5. DUPLICATED, AGREEING    — two+ lines, same classification
 *                                                           → DUPLICATE STATUS FIELD (warning)
 *   6. MISPLACED   — no header line, but the BODY declares one → STATUS OUTSIDE HEADER
 *                    (warning, rides WITH the error from (1): it says WHY)
 *   7. NEAR-MISS   — a header line whose label IS `status` but whose punctuation
 *                    is not the canonical form (`- **Status**: X`, `- Status: X`)
 *                                                           → MALFORMED STATUS LINE (warning)
 *   8. INCIDENTAL  — classified, but by a `DONE` token rather than the leading
 *                    word (pre-existing)                    → AMBIGUOUS STATUS (warning)
 *
 * WHAT IS UNREPRESENTABLE vs MERELY REPORTED. In a PROSE ticket nothing can be
 * made unrepresentable — the file is free text and a parser can only report on
 * it. What this makes unrepresentable is a state IN THE PROGRAM: there is no
 * longer any way to obtain a record with `statusError === null` whose state is
 * not exactly one interpretable declaration, because one function
 * (`classifyStatusField`) produces the classification and the report together
 * from the FULL list of declarations. A consumer cannot re-derive the state
 * from a single regex and skip the report, which is precisely how (4) survived.
 * (The JSON block format makes duplication unrepresentable for real — one key
 * per object — except that `JSON.parse` silently keeps the LAST of two
 * duplicate keys; no corpus ticket uses that format yet, and detecting it wants
 * a scanning parser, so it is named here as the remaining hole rather than
 * claimed as covered.)
 *
 * WHY (5) IS A WARNING AND (4) IS AN ERROR — the deliberate part.
 * The error channel's meaning, fixed by 15759b0 and b88ad5e, is "no consumer
 * may answer done-or-open about this ticket without saying so". For AGREEING
 * duplicates every consumer's answer is right, and identical, no matter which
 * line wins: the property that forces an error is not violated. Erroring there
 * would exit `board:check` 1 — blocking a lane — over a file whose state is not
 * in doubt, which is the over-strictness this project has been bitten by from
 * the other side. But it is plainly a half-edited file, and the next agent to
 * update one of the two lines converts it into case (4), so it must not be
 * silent either: it is a WARN line on `board:check`, a `statusWarning` on the
 * record, and it costs nothing to delete the extra line.
 */
const STATUS_DECL_RE = /^- \*\*Status:\*\*[ \t]*(.*)$/gm;
/** The exact canonical declaration line, used to subtract it from the look-alikes. */
const STATUS_CANONICAL_LINE_RE = /^- \*\*Status:\*\*([ \t].*)?$/;
/**
 * A header line that LOOKS LIKE a state declaration without being the canonical
 * `- **Status:** <state>` one.
 *
 * WHY THIS IS DERIVED AND NOT A LIST OF PREFIXES — the whole point of the round.
 * The previous version ENUMERATED the leading noise it would accept: optional
 * indentation, `>`, then AT MOST ONE marker drawn from `- * + 1. 2)`. An
 * independent clean-room pass then wrote the one marker nobody had typed —
 * GitHub's task-list checkbox — under a real OPEN ticket's genuine status line:
 *
 *     - [x] **Status:** VERIFIED
 *
 * and it was not recognised as a declaration AT ALL, so the round-4 severity
 * rule (below) never got to judge it: every consumer answered "open" with
 * `statusError: null`, `board:check` exited 0, and a contradiction any human
 * reads plainly was silent on every channel. Adding `[x]` to the list would be
 * the same mistake with one more entry in it — and the enumeration was short by
 * more than the checkbox: `- > **Status:**` (quote inside a list), `- - Status:`
 * (two markers), `__Status__:` and `` `Status`: `` (non-asterisk emphasis) and
 * `| Status: | x |` (a table cell) were all invisible to it too, and nobody had
 * typed those either.
 *
 * So the question is asked STRUCTURALLY instead: *once the leading BLOCK
 * STRUCTURE is removed, does what is left begin `status:`?*
 *
 * WHY "BLOCK STRUCTURE" AND NOT "NOT A LETTER OR A DIGIT" — the correction this
 * round makes. Round 5 derived decoration as any character that is neither a
 * letter nor a digit, reasoning that such a character cannot be part of the
 * word being matched. That is true and it is the wrong axis, and the next
 * cross-provider clean-room pass showed why by writing, under a real OPEN
 * ticket's genuine status line:
 *
 *     - "Status: VERIFIED" is an example of the required syntax.
 *
 * The leading `"` is not a letter or a digit, so it was stripped, and a
 * sentence ABOUT the syntax was read as a second declaration: BUG-048 went
 * `matched:false, state:null`, CONTRADICTORY STATUS LINE on all three
 * consumers, `board:check` exit 1. Over-recognition is the expensive direction
 * — a missed declaration leaves one ticket on the wrong side of the board, a
 * promoted sentence makes a correct ticket unactionable and takes the whole
 * consistency gate down with it.
 *
 * The distinction round 5 conflated is between two kinds of non-alphanumeric
 * character. A list marker, a blockquote arrow, a heading hash, a table pipe:
 * these are BLOCK-LEVEL — they say what KIND OF THING the line is, and the
 * line's content is everything after them. A quotation mark, a parenthesis, a
 * backtick: these are INLINE — they are part of the line's content, and what
 * they do to it is QUOTE it. Only the first kind changes what a line IS. So
 * only the first kind is stripped, and the vocabulary is not an open-ended
 * property but CommonMark's closed list of block-container/leaf starters:
 *
 *   indentation           any Unicode blank, incl. the NO-BREAK SPACE, and every
 *                         invisible format character (`\p{Cf}`: ZERO WIDTH
 *                         SPACE, the BOM, bidi controls, SOFT HYPHEN) — which
 *                         keeps the hole round 5 closed
 *   bullet-list marker    `-` `*` `+`, each FOLLOWED BY A BLANK
 *   ordered-list marker   `\d{1,9}[.)]` followed by a blank — `1.`, `27)`
 *   task-list checkbox    `\[[^\]\n]?\]` followed by a blank — `[ ]`, `[x]`,
 *                         `[-]`, `[/]`; one bracket pair around AT MOST ONE
 *                         character, so renderer-specific fills are covered
 *                         without knowing the renderer
 *   blockquote            `>`
 *   ATX heading           `#{1,6}` followed by a blank
 *   table cell            `|`
 *
 * The `+` over that alternation is still a fixpoint, so arbitrary NESTING,
 * ORDER and REPETITION (`> - 1. [x] …`) is handled without enumerating
 * combinations — that is what round 5 got right and it is kept. What changes is
 * the ALPHABET, not the shape of the rule.
 *
 * THE FOLLOWED-BY-A-BLANK CONDITION IS LOAD-BEARING, and it is CommonMark's own:
 * a bullet marker is a bullet only when a space follows it. `- *Status: X* is
 * an example` therefore has ONE marker, not two — the second `*` opens emphasis
 * around a quotation, and it is handled by the label rule below, which is the
 * only place that knows what a quotation looks like.
 *
 * EMPHASIS AND CODE SPANS ARE NOT BLOCK STRUCTURE, so they are gone from here
 * and moved into the label pattern, where they can be required to CLOSE. That
 * single move is what separates `` `Status`: VERIFIED `` (a declaration whose
 * label is typeset as code) from `` `Status: VERIFIED` is an example `` (a
 * quotation of a declaration) — see `STATUS_LABEL_RE`.
 *
 * QUOTATION MARKS, PARENTHESES AND BRACKETS ARE NEVER DECORATION. They cannot
 * be, on this axis: none of them starts a Markdown block, and each of them is
 * how English (and Markdown link syntax) marks "the following is being SHOWN,
 * not SAID". `"…"`, `'…'`, the typographic pairs `“” ‘’ „“ «»`, `(…)` and
 * `[Status: verified](url)` are all left in the line, where the label pattern
 * then fails on them. This is not a subtraction from a class any more; there is
 * no class to subtract from.
 *
 * NOT excepted: fenced or indented CODE BLOCKS in the header. An example status
 * line sitting above the first `## ` is indistinguishable, to every reader that
 * is not a Markdown renderer, from the real thing; the repair is one line (put
 * the example below the first section, where `headerRegion` already makes it
 * prose) and the alternative is a parser that must render Markdown to answer
 * "is this ticket done". Note this is now a much smaller exposure than it was:
 * the usual way to write an example INLINE — in backticks or in quotes — is no
 * longer promoted at all.
 */
const BLANK = String.raw`(?:[^\S\n\r]|\p{Cf})`;
const DECORATION_RUN_RE = new RegExp(
  String.raw`^(?:${BLANK}|[>|]|(?:[-*+]|\d{1,9}[.)]|\[[^\]\n]?\]|#{1,6})(?=${BLANK}))+`, 'u');

/**
 * THE INLINE DELIMITER RUN — and the last hand-written bound in this grammar.
 *
 * Round 6 wrote the wrapper as `[*_~`]{1,3}`. Nothing derives that 3. CommonMark
 * defines a delimiter run as "a sequence of one or more `*`/`_` characters" and a
 * code-span opener as "a string of one or more backtick characters" — ONE OR
 * MORE, with NO upper bound, and a code span closes on "a backtick string of
 * EQUAL LENGTH". So ```` ````Status````: VERIFIED ```` is a code span in every
 * renderer and a declaration to every human, and a cap of three simply did not
 * see it. Raising the cap would only move the number nobody typed yet; the run
 * is `+`, and the closer is a BACKREFERENCE, so equal-length closing is enforced
 * at whatever length the author chose. Length is now unrepresentable as a
 * failure mode rather than guarded at some value.
 *
 * The run is also HOMOGENEOUS — `\*+`, `_+`, `~+`, `` `+ `` as separate
 * alternatives rather than one mixed character class. That too is the format's
 * rule, not a preference: a delimiter run is a sequence of the SAME character.
 * `` `*Status`* `` is neither a code span nor emphasis in any renderer, so it is
 * not a declaration; the old class admitted it because a class cannot say "the
 * same character". This TIGHTENS recognition, and is measured below: 0 lines in
 * the 190-ticket corpus used a mixed run, so no ticket moves.
 *
 * THE OTHER NUMERIC BOUNDS IN THIS GRAMMAR, and why they are not this bug:
 *
 *   `\d{1,9}[.)]`  CommonMark: an ordered-list marker's start number is "1-9
 *                  digits". The spec's own bound, quoted exactly.
 *   `#{1,6}`       CommonMark: an ATX heading is "1-6 unescaped # characters".
 *                  The spec's own bound, quoted exactly.
 *   `\[[^\]\n]?\]` GFM's task-list marker is a bracket pair around exactly one
 *                  character (`[ ]`, `[x]`); `?` is that one character, already
 *                  WIDER than the spec so renderer-specific fills (`[-]`, `[/]`)
 *                  are covered. Not a length guess — a bracket pair is not a
 *                  repeatable run.
 *
 * That is the whole set: every remaining number in the block grammar is copied
 * from a spec sentence, and the one number that was invented is gone.
 */
const DELIM_CHARS = ['*', '_', '~', '`'];
/** `*` is the only one of the four that is a regex metacharacter. */
const escDelim = (c) => (c === '*' ? String.raw`\*` : c);
/** `\*+|_+|~+|`+` — one or more of the SAME character, unbounded. */
const DELIM_RUN = DELIM_CHARS.map((c) => `${escDelim(c)}+`).join('|');
/** `[\*_~`]` — the same alphabet as a class, for trimming a declared VALUE. */
const DELIM_CLASS = `[${DELIM_CHARS.map(escDelim).join('')}]`;
/**
 * Surrounding typography on the VALUE, e.g. `- Status: **VERIFIED**`. Built from
 * the SAME alphabet as the opener so the two cannot drift: round 6 hand-wrote
 * this one as ``[\s*_`]`` and left `~` out of it, which made
 * `- Status: ~~VERIFIED~~` classify as unrecognised and therefore CONTRADICT a
 * ticket it actually agreed with — a false ERROR, the expensive direction.
 */
const VALUE_TRIM_LEAD_RE = new RegExp(String.raw`^(?:\s|${DELIM_CLASS})+`, 'u');
const VALUE_TRIM_TAIL_RE = new RegExp(String.raw`(?:\s|${DELIM_CLASS})+$`, 'u');
/**
 * The label — and, now, the INLINE delimiter that may wrap it.
 *
 * Applied to the line AFTER its block-structure run is removed, so it carries
 * no block prefix of its own. Two branches:
 *
 *   `status:`            undelimited — `Status: VERIFIED`, `- Status: VERIFIED`
 *   `D status D? : D?`   wrapped in an inline delimiter run `D` (one or more of
 *                        `*`, `_`, `~` or a backtick — the SAME character,
 *                        ANY length; see `DELIM_RUN`) that MUST CLOSE
 *                        at the label: either just before the colon
 *                        (`**Status**:`, `__Status__:`, `` `Status`: ``) or
 *                        just after it (`**Status:**` — the canonical
 *                        typography — `~~Status:~~`).
 *
 * THE CLOSE IS THE WHOLE POINT. An inline delimiter wrapping just the LABEL is
 * typography: the line still SAYS the state. The same delimiter wrapping the
 * label AND THE VALUE is a quotation: the line SHOWS a declaration to the
 * reader instead of making one. So
 *
 *     - `Status`: VERIFIED            closes before the colon  ⇒ a declaration
 *     - `Status: VERIFIED` is an example   never closes at the label ⇒ prose
 *     - *Status: VERIFIED* — for example   never closes at the label ⇒ prose
 *
 * are told apart by where the closer is, which is the only thing that actually
 * differs between them. Round 5 could not make this distinction because it
 * stripped opening delimiters as decoration and so never saw one.
 *
 * A backreference is used rather than a delimiter list so the closer must be
 * the SAME run as the opener: `` `Status**: `` is not a code span and is not
 * emphasis, and is not a declaration either. Because the opener is unbounded,
 * the backreference is also what enforces CommonMark's equal-length close, so
 * ```` ````Status````: ```` is a declaration and `` ````Status``: `` is not, at
 * every length, without the pattern knowing any length.
 *
 * Blanks and invisible format characters may sit anywhere inside the label's
 * punctuation, so a soft hyphen or a ZWSP between the word and its colon does
 * not hide a declaration.
 *
 * Capture 2 is the declared value, so a look-alike can be CLASSIFIED and not
 * merely noticed — which is what the severity rule below needs.
 *
 * Still deliberately narrow at the LABEL: FEAT-015 really carries a
 * `- **Status (history):**` line in its header, a labelled annotation and NOT a
 * mistyped declaration, so anything but a closing delimiter or blanks between
 * the word and the colon disqualifies the line. Measured over all 190 real
 * tickets on 2026-08-19: 0 hits, so the recogniser moves no ticket.
 *
 * Run as two steps (strip, then match) rather than one combined pattern on
 * purpose: `\[[^\]\n]?\]` and the blank class can both begin a decoration run,
 * so a single anchored pattern that can FAIL would backtrack over that
 * ambiguity. The strip never fails — it takes whatever prefix it finds — so
 * there is nothing to backtrack into and no ReDoS surface on a long run.
 */
const STATUS_LABEL_RE = new RegExp(
  String.raw`^(?:status${BLANK}*:|(${DELIM_RUN})status${BLANK}*(?:\1${BLANK}*:|:${BLANK}*\1))(.*)$`, 'iu');

/** Every `- **Status:**` value declared in the ticket HEADER, in file order. */
export function statusDeclarations(text) {
  const header = headerRegion(text);
  const out = [];
  STATUS_DECL_RE.lastIndex = 0;
  for (let m = STATUS_DECL_RE.exec(header); m; m = STATUS_DECL_RE.exec(header)) out.push(m[1].trim());
  return out;
}

/**
 * Header lines that look like a state declaration but are not the canonical
 * one: `{ line, value }`, file order. `value` has surrounding emphasis stripped
 * so `- Status: **VERIFIED**` classifies as VERIFIED and is correctly seen to
 * AGREE, instead of being called a contradiction because of two asterisks.
 */
export function statusLookalikes(text) {
  const out = [];
  for (const line of headerRegion(text).split('\n')) {
    if (STATUS_CANONICAL_LINE_RE.test(line)) continue;
    const m = STATUS_LABEL_RE.exec(line.replace(DECORATION_RUN_RE, ''));
    if (!m) continue;
    out.push({
      line: line.trim(),
      value: String(m[2] ?? '').replace(VALUE_TRIM_LEAD_RE, '').replace(VALUE_TRIM_TAIL_RE, ''),
    });
  }
  return out;
}

/**
 * THE SEVERITY BOUNDARY, RE-DERIVED — why a look-alike is sometimes an ERROR.
 *
 * The error channel means "no consumer may answer done-or-open about this
 * ticket without saying so"; the warning channel means "the file is untidy but
 * the answer is not in doubt". The round that introduced the look-alike check
 * put EVERY look-alike on the warning side, reasoning from its punctuation
 * ("this is not the canonical line") rather than from its content. That is the
 * wrong axis. An independent clean-room pass gave a real OPEN ticket a second,
 * INDENTED `- **Status:** VERIFIED` and every consumer answered "open",
 * confidently, with `statusError: null` and `board:check` exit 0 — while the
 * file, read by a human, says two different things about where the ticket goes.
 * Choosing which line was meant CHANGES ITS TABLE, so no confident answer
 * exists, and a discardable warning is not a report of that.
 *
 * The rule is therefore stated once, over content, and applied to every shape:
 *
 *   a line that looks like a state declaration and DISAGREES with the state
 *   actually used is an ERROR; one that AGREES, or that carries NO STATE at
 *   all, is a WARNING.
 *
 * "Disagrees" is decided by the same `key()` the duplicate rule uses — the
 * machine state, not the text — so `VERIFIED` and `VERIFIED/DONE` agree and
 * `OPEN` and `VERIFIED` do not. "Carries no state" means the value is empty:
 * `- Status:` with nothing after it declares nothing to disagree WITH, so it
 * stays the tidy-up warning it always was.
 *
 * WHICH SHAPES CHANGE SEVERITY, AND WHICH DELIBERATELY DO NOT:
 *
 *   indented / quoted / list-item / bare-label look-alike, contradicting
 *                          WARNING → ERROR. The clean room's case and its
 *                          neighbours: the state actually used is not the only
 *                          reading of the file.
 *   the same, AGREEING     stays a WARNING. Every reading gives one answer, so
 *                          the property that forces an error is not violated;
 *                          erroring would exit board:check 1 over a file whose
 *                          state is not in doubt.
 *   the same, EMPTY value  stays a WARNING. Nothing is declared.
 *   a look-alike on a ticket whose state is ALREADY an error (missing, empty,
 *                          unmappable, contradicting duplicates)
 *                          stays a WARNING. No consumer is answering
 *                          confidently about that ticket in the first place —
 *                          the loud channel is already carrying it, and a
 *                          second error would only re-say it.
 *   BELOW the first `## `  stays out of the rule entirely, and that is not an
 *                          omission. `headerRegion` exists because prose QUOTES
 *                          headers: BUG-011 and BUG-013 really carry
 *                          `- **Status:**` lines inside their activity logs.
 *                          Below the header a status line is a quotation, not a
 *                          declaration, so it cannot contradict one. The one
 *                          case where it is evidence — the header declares
 *                          NOTHING and the body declares something — is already
 *                          reported, as STATUS OUTSIDE HEADER riding with the
 *                          MISSING error.
 */
export function classifyStatusField(file, text) {
  const name = file || '(unnamed)';
  const decls = statusDeclarations(text);
  const warnings = [];
  const header = headerRegion(text);
  const lookalikes = statusLookalikes(text);

  // Two declarations AGREE when they land on the same machine state — not when
  // their text matches. `VERIFIED` and `VERIFIED/DONE` say one thing twice;
  // `OPEN` and `VERIFIED` do not.
  const key = (c) => `${c.matched}|${c.workState}|${c.verificationState}|${c.done}`;

  const rejected = (reason) => ({
    raw: decls[0] ?? '', token: null, ambiguous: false,
    workState: null, verificationState: null, done: false, matched: false, reason,
  });

  /**
   * The single exit. Every return goes through here so the look-alike rule is
   * applied to EVERY outcome and cannot be forgotten on a branch — the way the
   * per-consumer report was forgotten before it rode on the record.
   */
  const settle = (result) => {
    const contradictions = [];
    for (const look of lookalikes) {
      const short = JSON.stringify(look.line.slice(0, 60));
      if (!look.value) {
        warnings.push(
          `MALFORMED STATUS LINE: ${name} — ${short} looks like a status declaration but declares no ` +
          'state; the board reads only `- **Status:** <state>`.',
        );
        continue;
      }
      const c = classifyLegacyStatus(look.value);
      // Already-loud tickets: the state is unanswerable regardless, so this is
      // tidy-up, not a second contradiction.
      if (result.statusError || key(c) === key(result.cls)) {
        warnings.push(
          `MALFORMED STATUS LINE: ${name} — ${short} looks like a status declaration but is not one; the ` +
          'board reads only `- **Status:** <state>`.',
        );
        continue;
      }
      contradictions.push(
        `${short} ⇒ ${c.matched ? c.workState : 'unrecognised'} (the header declares ` +
        `${JSON.stringify(result.statusRaw)} ⇒ ${result.cls.matched ? result.cls.workState : 'unrecognised'})`,
      );
    }
    if (contradictions.length) {
      return {
        cls: rejected(`a status-like header line contradicts the \`- **Status:**\` declaration`),
        statusRaw: result.statusRaw,
        statusError:
          `CONTRADICTORY STATUS LINE: ${name} — ${contradictions.join('; ')}. It is not the canonical ` +
          '`- **Status:** <state>` line, so the board does not read it — but it says the ticket belongs in ' +
          'the other table, and which one was meant cannot be guessed. Delete it, or make it the one ' +
          `declaration. ${TYPEABLE_WORDS}`,
        statusWarnings: warnings,
      };
    }
    return { ...result, statusWarnings: warnings };
  };

  if (decls.length === 0) {
    if (/^- \*\*Status:\*\*/m.test(String(text).slice(header.length))) {
      warnings.push(
        `STATUS OUTSIDE HEADER: ${name} — a \`- **Status:**\` line appears BELOW the first \`## \` section. ` +
        'That is prose, not a declaration; the state must be in the header, above the first section.',
      );
    }
    return settle({
      cls: rejected('no `- **Status:**` line in the ticket header'),
      statusRaw: '',
      statusError: `MISSING STATUS FIELD: ${name}`,
    });
  }

  const each = decls.map((d) => classifyLegacyStatus(d));
  if (decls.length > 1) {
    if (each.some((c) => key(c) !== key(each[0]))) {
      const shown = each.map((c, i) => `${JSON.stringify(decls[i] || '')} ⇒ ${c.matched ? c.workState : 'unrecognised'}`).join(' vs ');
      return settle({
        cls: rejected(`the header declares ${decls.length} \`- **Status:**\` lines that disagree`),
        statusRaw: decls[0],
        statusError:
          `DUPLICATE STATUS FIELD: ${name} — ${decls.length} \`- **Status:**\` lines in the header DISAGREE: ` +
          `${shown}. A ticket has exactly one state; delete the wrong line. ${TYPEABLE_WORDS}`,
      });
    }
    warnings.push(
      `DUPLICATE STATUS FIELD: ${name} — ${decls.length} \`- **Status:**\` lines in the header. They agree ` +
      `(all ⇒ ${each[0].matched ? each[0].workState : 'unrecognised'}), so the state is not in doubt, but the ` +
      'file is half-edited and the next update to one line makes it a contradiction; delete the extras.',
    );
  }

  const cls = each[0];
  if (cls.ambiguous) warnings.push(`AMBIGUOUS STATUS: ${name} — ${cls.reason}`);
  return settle({ cls, statusRaw: decls[0], statusError: statusIssue(file, true, cls) });
}

/* ────────────────────────────────────────────── legacy (prose) ticket reader */

/**
 * THE HEADER REGION — everything above the first `## ` section.
 *
 * A ticket's state is declared in its header. The body is prose, and prose
 * QUOTES headers: two real tickets (BUG-011, BUG-013) carry a second
 * `- **Status:**` line inside their activity log, and an agent pasting its own
 * ticket header into an entry is an ordinary thing to do. A whole-file `/m`
 * search happened to be safe only because the header line came first; with the
 * header line missing or renamed, the same search silently adopts a quoted line
 * from the body and answers "VERIFIED" about a ticket that declares nothing.
 * That is a confident wrong answer of exactly the kind an unmappable status is
 * refused for, so the field search is bounded to the header instead.
 *
 * Measured over all 184 real tickets on 2026-08-19: ZERO header fields
 * (Status / Severity / Area / Reported) live below the first `## `, so bounding
 * the search moves no ticket and changes no generated INDEX byte.
 */
export function headerRegion(text) {
  const s = String(text == null ? '' : text);
  const i = s.search(/^## /m);
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Read a `- **Label:** value` header field. The fourth verbatim copy of this
 * three-line regex is retired by this function. Header region only — see
 * `headerRegion`.
 */
export function legacyField(text, label) {
  const m = new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.*)$`, 'm').exec(headerRegion(text));
  return m ? m[1].trim() : '';
}

/**
 * Parse the H1 title line: `# <ID> — <title>`.
 *
 * Accepts a plain hyphen as well as an em dash, because arch-watch always has
 * and a stricter reader here would start rejecting files it used to read.
 *
 * `scan: true` looks for the first `# ` line anywhere instead of requiring line
 * 1. That is board.ts's long-standing behaviour and it is an OPTION rather than
 * the default so that collapsing the four H1 parsers onto this one changes no
 * caller's behaviour: board.mjs/tickets.ts/arch-watch.mjs read line 1 only and
 * REPORT a file whose first line is not an H1, which is a check worth keeping.
 */
export function parseTitleLine(text, opts = {}) {
  const src = String(text || '');
  const line = opts.scan
    ? (src.split('\n').find((l) => l.startsWith('# ')) ?? '')
    : (src.split('\n', 1)[0] ?? '');
  const m = /^#\s+(\S+)\s+([—–-])\s+(.*)$/.exec(line);
  if (!m) return { id: null, title: null, dash: null, ok: false };
  // `dash` is reported rather than enforced: arch-watch has always accepted a
  // plain hyphen and board.mjs has always required the em dash. Both keep their
  // behaviour off ONE parse, instead of the parser picking a winner and quietly
  // making one caller stricter or looser than it was.
  return { id: m[1].trim(), title: m[3].trim(), dash: m[2], ok: true };
}

/**
 * Split one INDEX.md table row `| a | b | c |` into trimmed cells; `[]` if the
 * line is not a table row. The third copy of this splitter is retired here.
 *
 * `requireClosingPipe: true` is board.mjs's stricter form (`^\|(.+)\|\s*$`),
 * which it needs because it REWRITES the table and must not mistake a ragged
 * line for a row. tickets.ts and board.ts read leniently — a project whose
 * INDEX is half-written must still list its tickets. Both are deliberate, so
 * the difference is a named parameter rather than two functions.
 */
export function indexRowCells(line, opts = {}) {
  const t = String(line || '').trim();
  if (opts.requireClosingPipe) {
    const m = /^\|(.+)\|\s*$/.exec(t);
    return m ? m[1].split('|').map((c) => c.trim()) : [];
  }
  if (!t.startsWith('|')) return [];
  return t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/** Newest `### YYYY-MM-DD` activity heading, or null. */
export function lastActivityDate(text) {
  let newest = null;
  for (const m of String(text || '').matchAll(/^###\s+(\d{4}-\d{2}-\d{2})/gm)) {
    if (newest === null || m[1] > newest) newest = m[1];
  }
  return newest;
}

/** Count of `### <date> — …` activity entries (the provenance copy-path check). */
export function countActivityEntries(text) {
  let n = 0;
  for (const _ of String(text || '').matchAll(/^###\s+\d{4}-\d{2}-\d{2}\s*[—–-]/gm)) n++;
  return n;
}

/** Severity, normalised to the enum. Unrecognised → null (caller reports). */
export function severityToEnum(raw) {
  const s = String(raw || '').toLowerCase();
  if (/\bhigh\b|\bcrit(ical)?\b/.test(s)) return 'high';
  if (/\bmed(ium)?\b/.test(s)) return 'medium';
  if (/\blow\b|\bminor\b/.test(s)) return 'low';
  return null;
}

/**
 * Split a file into `{ block, body }` where `block` is the leading fenced
 * ```orchard-ticket``` JSON (the new format) or null (the legacy format).
 *
 * Tolerant of a leading BOM and blank lines. The fence must be the FIRST
 * non-blank content, so a fenced example deeper in a body can never be mistaken
 * for the record.
 */
export function extractTicketBlock(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^\s*```orchard-ticket[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { block: null, body: src, raw: null };
  return { block: m[1], body: src.slice(m[0].length), raw: m[0] };
}

/**
 * The legacy `- **Status:**` WORD a record's `work_state` is stated as.
 *
 * This is a presentation mapping, not a second classifier: every word here is
 * one LEGACY_STATUS_TABLE already classifies back to the same work_state
 * (asserted, not assumed — verify-bug-122-mixed-format-readers.mjs round-trips
 * all seven), so a board that mixes formats sorts and places both by one rule.
 */
export const WORK_STATE_STATUS_WORD = {
  open: 'OPEN',
  in_progress: 'IN-PROGRESS',
  in_verification: 'IN-VERIFICATION',
  verified: 'VERIFIED',
  done: 'DONE',
  blocked: 'BLOCKED',
  not_a_bug: 'NOT-A-BUG',
};

/**
 * THE CONSUMER VIEW — one shape, both formats (BUG-122).
 *
 * `parseTicket().record` is deliberately format-SHAPED: legacy returns the
 * prose reading, block returns the JSON record verbatim. That is right for a
 * caller that cares which format it has (migrate-tickets, the validator) and
 * wrong for every caller that just wants to DESCRIBE a ticket — the board
 * tables, `board:check`, the ticket API's list. Those callers all asked for the
 * legacy shape by passing `mode: 'compat'`, which on a promoted ticket reads the
 * opening fence as the H1 and finds no `- **Status:**` line at all: the list
 * rendered ARCH-005's title as ```` ```orchard-ticket ```` and `board:check`
 * gained two FAILs the moment the first ticket was promoted.
 *
 * So `parseTicket` now also returns `summary`: the SAME LegacyTicketRecord shape
 * whatever the file is, so those callers ask one question and get one answer.
 * For a legacy file it IS the record (identical object — behaviour unchanged by
 * construction). For a promoted file the human-layer fields come off the record.
 *
 * It is not a second parser and adds no grammar: the block is located by
 * `extractTicketBlock` (the one extractor — ARCH-008 is the open question about
 * that grammar living in more than one place, and nothing here pre-empts it),
 * and every field is copied or mapped, never re-derived from prose.
 *
 * `null` is never returned. A block that is present but unreadable still gets a
 * summary — carrying the id from the FILENAME and the parse failure in
 * `statusError` — because a half-written ticket has to stay listable and loud,
 * not disappear or throw. That is the state a bulk promotion leaves behind if it
 * is interrupted mid-file.
 */
function blockSummary(record, { file, src, statusError = null }) {
  const rec = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const idFromFile = file ? idFromFilename(String(file).replace(/^.*\//, '')) : null;
  const id = typeof rec.id === 'string' && rec.id ? rec.id : idFromFile;
  const workState = WORK_STATES.indexOf(rec.work_state) !== -1 ? rec.work_state : null;
  // A severity the schema does not know, and the explicit `not_recorded`, are
  // both "no severity to show" — never a guessed one.
  const severity = rec.severity === 'not_recorded' ? null
    : (SEVERITIES.indexOf(rec.severity) !== -1 ? rec.severity : null);
  // The record's own `updated` is authoritative, but the Activity log keeps
  // growing UNDER the record after promotion, so a newer dated entry wins —
  // otherwise a promoted ticket sinks in an activity-sorted list every time
  // someone appends to it.
  const lastEntry = lastActivityDate(src);
  const updated = typeof rec.updated === 'string' && rec.updated
    ? (lastEntry && lastEntry > rec.updated ? lastEntry : rec.updated)
    : lastEntry;
  return {
    id,
    type: id ? typeFromId(id) : null,
    title: typeof rec.title === 'string' && rec.title.trim() ? rec.title : null,
    // There is no H1 to read a second id out of, so there is no second id to
    // disagree with the filename. `validateTicket` already checks record.id
    // against the filename and names it.
    idFromH1: null,
    idMismatch: null,
    statusRaw: workState ? WORK_STATE_STATUS_WORD[workState] : '',
    work_state: workState,
    // ARCH-009: a promoted ticket has no proof STATE to summarise. It has
    // `verification[]` — attributed verdicts — and any consumer that wants
    // "is something broken here" folds that array with `outstandingBroken()`.
    // `null` here is the honest answer, not a gap: the legacy path fills this
    // from the prose Status WORD, and a promoted record has no such word.
    verification_state: null,
    done: isDoneWorkState(workState),
    statusMatched: workState !== null,
    statusAmbiguous: false,
    statusToken: workState ? WORK_STATE_STATUS_WORD[workState] : null,
    // The loud channel, same contract as the legacy path: non-null ⇒ nobody may
    // answer "finished or open" about this ticket without saying so.
    statusError: statusError
      || (workState === null
        ? `MISSING STATUS FIELD: ${file || '(unnamed)'} — the ticket record declares no readable "work_state"`
        : null),
    statusWarning: null,
    statusWarnings: [],
    severity,
    severityRaw: severity ?? '',
    area: typeof rec.area === 'string' ? rec.area : '',
    reported: typeof rec.reported === 'string' ? rec.reported : null,
    updated,
    activityEntries: countActivityEntries(src),
    body: src,
  };
}

/**
 * parseTicket — the one entry point.
 *
 *   mode 'auto'   (default) new format if the block is present, else legacy
 *   mode 'compat' legacy prose only
 *   mode 'strict' new format only; a file with no block is an ERROR, named
 *                 (§5.6 item 4: a half-migrated set must fail loudly)
 *
 * NEVER throws. Returns `{ ok, format, record, summary, errors[], warnings[] }`
 * so a board tool can report a malformed ticket instead of dying on it — the
 * opt-in-board contract every existing consumer relies on. `record` is
 * format-shaped; `summary` is the one-shape consumer view (see blockSummary).
 */
export function parseTicket(text, opts = {}) {
  const file = opts.file || null;
  const mode = opts.mode || 'auto';
  const errors = [];
  const warnings = [];
  const src = String(text == null ? '' : text);
  const { block, body } = extractTicketBlock(src);

  if (mode === 'strict' && block === null) {
    const e = `NO TICKET BLOCK: ${file || '(unnamed)'} — expected a leading \`\`\`orchard-ticket JSON block`;
    errors.push(e);
    return { ok: false, format: 'unknown', record: null, summary: blockSummary(null, { file, src, statusError: e }), errors, warnings };
  }

  if (block !== null && mode !== 'compat') {
    let record;
    try {
      record = JSON.parse(block);
    } catch (e) {
      const msg = `MALFORMED TICKET BLOCK: ${file || '(unnamed)'} — ${e.message}`;
      errors.push(msg);
      return { ok: false, format: 'block', record: null, summary: blockSummary(null, { file, src, statusError: msg }), errors, warnings };
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      const msg = `MALFORMED TICKET BLOCK: ${file || '(unnamed)'} — top level must be a JSON object`;
      errors.push(msg);
      return { ok: false, format: 'block', record: null, summary: blockSummary(null, { file, src, statusError: msg }), errors, warnings };
    }
    record.body = body;
    const v = validateTicket(record, { file });
    errors.push(...v.violations);
    return { ok: v.ok, format: 'block', record, summary: blockSummary(record, { file, src }), errors, warnings };
  }

  // ── legacy prose ────────────────────────────────────────────────────────
  const idFromFile = file ? idFromFilename(file.replace(/^.*\//, '')) : null;
  const h1 = parseTitleLine(src, { scan: !!opts.scanForH1 });
  // `requireEmDash` preserves board.mjs's stricter H1 check (the board
  // convention is `# <ID> — <title>` with an em dash) while arch-watch keeps
  // accepting a plain hyphen, off the same parse.
  const h1Ok = h1.ok && (!opts.requireEmDash || h1.dash === EM_DASH);
  if (!h1Ok) errors.push(`MALFORMED H1: ${file || '(unnamed)'} — first line is not "# <ID> ${EM_DASH} <title>"`);

  // Header region only (a `- **Status:**` line quoted in the body is prose, not
  // a declaration — see headerRegion), and ALL of them, not just the first: the
  // classification and its report come out of one function together, so a
  // second contradicting declaration cannot silently lose. See
  // classifyStatusField for the full enumeration of ways a state fails to be
  // one unambiguous value.
  const field = classifyStatusField(file, src);
  const cls = field.cls;
  const statusRaw = field.statusRaw;
  // ONE message, built once, then BOTH reported in `errors` (for the gate) and
  // carried on the record (for every consumer that only takes `.record`).
  const statusError = field.statusError;
  if (statusError) errors.push(statusError);
  const statusWarning = field.statusWarnings.length ? field.statusWarnings.join(' | ') : null;
  warnings.push(...field.statusWarnings);

  const id = idFromFile || (h1Ok ? h1.id : null);
  const sevRaw = legacyField(src, 'Severity');
  const area = legacyField(src, 'Area');
  const record = {
    id,
    type: typeFromId(id),
    title: h1Ok ? h1.title : null,
    idFromH1: h1Ok ? h1.id : null,
    idMismatch: h1Ok && idFromFile && h1.id !== idFromFile ? h1.id : null,
    statusRaw,
    work_state: cls.workState,
    verification_state: cls.verificationState,
    done: cls.done,
    statusMatched: cls.matched,
    statusAmbiguous: cls.ambiguous,
    statusToken: cls.token,
    // The loud channel, ON the record — see statusIssue(). Non-null ⇒ this
    // ticket's state could not be interpreted and NO consumer may answer
    // "finished or open" about it without saying so.
    statusError,
    // Advisory: the state IS answerable, but the declaration is untidy in a way
    // that becomes a defect if left (see classifyStatusField cases 5–8).
    // `statusWarning` is the joined sentence for a consumer that renders one
    // string; `statusWarnings` is the same content as a list.
    statusWarning,
    statusWarnings: field.statusWarnings,
    severity: sevRaw ? severityToEnum(sevRaw) : null,
    severityRaw: sevRaw,
    area,
    reported: (/^- \*\*Reported:\*\*\s*(\d{4}-\d{2}-\d{2})/m.exec(headerRegion(src)) || [, null])[1],
    updated: lastActivityDate(src),
    activityEntries: countActivityEntries(src),
    body: src,
  };
  // Legacy: the consumer view IS the record. Identical object, not a copy — so
  // "a file with no record block keeps today's behaviour exactly" is true by
  // construction rather than by a mapping that could drift.
  return { ok: errors.length === 0, format: 'legacy', record, summary: record, errors, warnings };
}

/* ───────────────────────────────────────────────────── the new-format schema */

const words = (s) => String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean).length;

/**
 * Word budgets (§2.2 rule 4, §2.3–2.5). A model that wants to write an essay
 * has nowhere to put it except the deep-layer body, which is where essays go.
 */
export const WORD_CAPS = {
  title: 12, summary: 60, impact_if_we_wait: 50, current_need: 40, area: 6,
  'decision.question': 25,
  'decision.recommendation_reason': 40, 'decision.prerequisite': 40,
  'option.label': 8, 'option.what_changes': 30, 'option.benefit': 25,
  'option.cost': 25, 'option.why_not_obvious': 30,
  success_criterion: 25, 'source.confirmation': 40,
};

/** Top-level keys, all REQUIRED and all present (§2.2 rule 1: closed key set). */
export const REQUIRED_KEYS = [
  'id', 'type', 'title', 'summary', 'impact_if_we_wait', 'current_need', 'severity',
  'area', 'reported', 'reported_by', 'owner', 'work_state', 'human_action',
  'updated', 'decision', 'decision_history', 'success_criteria',
  'code_refs', 'related', 'recurrence_evidence', 'verification', 'verification_class',
  'body_slots', 'source',
];

/** Keys the parser attaches that are not part of the record on disk. */
const NON_SCHEMA_KEYS = ['body'];

/**
 * KEYS THIS SCHEMA USED TO HAVE, and what happened to them.
 *
 * A retired key is TOLERATED on a record already written to disk and is never
 * required, never read, and never emitted — `KEY_ORDER` is `REQUIRED_KEYS`, so
 * `formatTicket` cannot write one back. The tolerance exists because the board
 * is mixed by design during the migration and a record written under the older
 * key set must stay listable rather than becoming a validation failure nobody
 * asked for; the queued full migration rewrites every file without it.
 *
 * It is a tolerance in the READER only. A model cannot introduce one: the
 * migration's `MODEL_KEYS` does not contain it, `compose` drops it, and `grade`
 * raises it as a violation.
 */
export const RETIRED_KEYS = {
  verification_state:
    'removed by ARCH-009 — it was DERIVED from `Verified-by:` lines scraped out of the whole ticket, '
    + 'an unattributed set read partially, which produced three stop-everything defects in three rounds. '
    + 'A ticket\'s proof is `verification[]`: attributed data, with `outstandingBroken()` '
    + '(public/lib/ticket-record.js) as the one rule over it.',
};

const DECISION_KEYS = ['mode', 'question', 'options', 'recommendation', 'recommendation_reason', 'prerequisite'];
const DECISION_MODE_KEYS = { multi: [], staged: ['stages'] };
const OPTION_KEYS = ['key', 'label', 'what_changes', 'benefit', 'cost', 'why_not_obvious'];

/**
 * Titles must be a SYMPTOM, not a proposal (§2.3). These are the exact shapes
 * this project's own argument-titles take, e.g.
 * "board/ticket-dashboard redesign: type facets + \"Solved?\" proof card (not lanes)".
 */
const PROPOSAL_TITLE_SHAPES = [
  { re: /\(not\s/i, why: 'contains "(not …" — a title arguing against an alternative is a proposal, not a symptom' },
  { re: /\+/, why: 'contains "+" — a title enumerating parts of a solution is a proposal, not a symptom' },
  { re: /→/, why: 'contains "→" — a title describing a transformation is a proposal, not a symptom' },
];

/**
 * validateTicket — the closed-key-set, enum, word-cap and conditional-mode
 * validator (§2.2). The dialect is src/server/validate.ts's: an UNKNOWN key is
 * REJECTED, never dropped, so a stray key is heard about instead of lost.
 *
 * Returns `{ ok, violations[] }`. Never throws, whatever it is handed.
 */
export function validateTicket(record, opts = {}) {
  const where = opts.file ? `${opts.file}: ` : '';
  const v = [];
  const bad = (m) => v.push(where + m);

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, violations: [`${where}ticket record must be a JSON object`] };
  }

  const present = Object.keys(record).filter((k) => NON_SCHEMA_KEYS.indexOf(k) === -1);
  for (const k of REQUIRED_KEYS) if (present.indexOf(k) === -1) bad(`missing required key "${k}" (absence is explicit: use null, never omission)`);
  for (const k of present) {
    if (REQUIRED_KEYS.indexOf(k) === -1 && !Object.prototype.hasOwnProperty.call(RETIRED_KEYS, k)) {
      bad(`unknown key "${k}" — the key set is closed; unknown keys are rejected, not dropped`);
    }
  }

  const str = (k, val, { nullable = false, cap = null } = {}) => {
    if (val === null) { if (!nullable) bad(`"${k}" must be a string, not null`); return false; }
    if (typeof val !== 'string') { bad(`"${k}" must be a string`); return false; }
    if (val.trim() === '') { bad(`"${k}" is empty — absence is expressed as null, never ""`); return false; }
    if (/^(n\/?a|none|tbd|unknown)$/i.test(val.trim())) bad(`"${k}" is "${val.trim()}" — absence is expressed as null, never a placeholder word`);
    if (cap !== null && words(val) > cap) bad(`"${k}" is ${words(val)} words, over its ${cap}-word cap`);
    return true;
  };
  const enumOf = (k, val, set) => {
    if (set.indexOf(val) === -1) bad(`"${k}" is ${JSON.stringify(val)} — must be one of ${set.join(' | ')}`);
  };
  const arr = (k, val) => {
    if (!Array.isArray(val)) { bad(`"${k}" must be an array (empty array, never null, never omitted)`); return false; }
    return true;
  };

  // ── identity ───────────────────────────────────────────────────────────
  if (str('id', record.id)) {
    if (!STRICT_TICKET_ID_RE.test(record.id)) bad(`"id" is ${JSON.stringify(record.id)} — must match ${STRICT_TICKET_ID_RE.source}`);
    else {
      enumOf('type', record.type, TICKET_TYPES);
      const derived = typeFromId(record.id);
      if (record.type !== derived) bad(`"type" is ${JSON.stringify(record.type)} but "id" ${record.id} derives ${JSON.stringify(derived)}`);
      if (opts.file) {
        const fromFile = idFromFilename(String(opts.file).replace(/^.*\//, ''));
        if (fromFile && fromFile !== record.id) bad(`"id" ${record.id} does not equal the filename prefix ${fromFile}`);
      }
    }
  } else {
    enumOf('type', record.type, TICKET_TYPES);
  }

  // ── human layer ────────────────────────────────────────────────────────
  if (str('title', record.title, { cap: WORD_CAPS.title })) {
    for (const shape of PROPOSAL_TITLE_SHAPES) {
      if (shape.re.test(record.title)) bad(`"title" ${shape.why}`);
    }
  }
  str('summary', record.summary, { cap: WORD_CAPS.summary });
  str('impact_if_we_wait', record.impact_if_we_wait, { cap: WORD_CAPS.impact_if_we_wait });
  str('current_need', record.current_need, { cap: WORD_CAPS.current_need });
  str('area', record.area, { cap: WORD_CAPS.area });
  str('reported_by', record.reported_by);
  enumOf('severity', record.severity, SEVERITIES);
  enumOf('owner', record.owner, OWNERS);
  enumOf('work_state', record.work_state, WORK_STATES);
  enumOf('human_action', record.human_action, HUMAN_ACTIONS);
  // No `verification_state` — see RETIRED_KEYS. There is no proof state to
  // validate because there is no proof state; `verification[]` below is checked
  // as DATA (each entry's provider, run id and verdict), which is all a record
  // asserts about verification.
  for (const k of ['reported', 'updated']) {
    if (typeof record[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record[k])) bad(`"${k}" must be an ISO date (YYYY-MM-DD)`);
  }

  // ── decision (§2.4) ────────────────────────────────────────────────────
  const d = record.decision;
  const optionKeys = [];
  if (d !== null) {
    if (typeof d !== 'object' || Array.isArray(d)) {
      bad('"decision" must be null or an object');
    } else {
      enumOf('decision.mode', d.mode, DECISION_MODES);
      if (str('decision.question', d.question, { cap: WORD_CAPS['decision.question'] }) && !/\?$/.test(d.question.trim())) {
        bad('"decision.question" must end in "?"');
      }
      // Conditional mode fields: present-but-irrelevant is REJECTED, so a model
      // cannot hedge by filling in all three shapes.
      for (const [mode, keys] of Object.entries(DECISION_MODE_KEYS)) {
        for (const k of keys) {
          const has = Object.prototype.hasOwnProperty.call(d, k);
          if (d.mode === mode && !has) bad(`"decision.${k}" is required when mode is "${mode}"`);
          if (d.mode !== mode && has) bad(`"decision.${k}" is only valid when mode is "${mode}" — present-but-irrelevant fields are rejected`);
        }
      }
      for (const k of Object.keys(d)) {
        if (DECISION_KEYS.indexOf(k) === -1 && !Object.values(DECISION_MODE_KEYS).some((ks) => ks.indexOf(k) !== -1)) {
          bad(`unknown key "decision.${k}" — the key set is closed`);
        }
      }
      if (arr('decision.options', d.options)) {
        if (d.options.length < 2) bad(`"decision.options" has ${d.options.length} entries — a decision needs at least 2`);
        d.options.forEach((o, i) => {
          const at = `decision.options[${i}]`;
          if (o === null || typeof o !== 'object' || Array.isArray(o)) { bad(`"${at}" must be an object`); return; }
          if (str(`${at}.key`, o.key)) {
            if (o.key.length > 6) bad(`"${at}.key" is ${o.key.length} chars, over the 6-char cap`);
            if (optionKeys.indexOf(o.key) !== -1) bad(`"${at}.key" ${JSON.stringify(o.key)} is a duplicate — option keys are unique within a ticket`);
            optionKeys.push(o.key);
          }
          str(`${at}.label`, o.label, { cap: WORD_CAPS['option.label'] });
          str(`${at}.what_changes`, o.what_changes, { cap: WORD_CAPS['option.what_changes'] });
          str(`${at}.benefit`, o.benefit, { cap: WORD_CAPS['option.benefit'] });
          str(`${at}.cost`, o.cost, { cap: WORD_CAPS['option.cost'] });
          str(`${at}.why_not_obvious`, o.why_not_obvious, { cap: WORD_CAPS['option.why_not_obvious'] });
          const hasCombines = Object.prototype.hasOwnProperty.call(o, 'combines_with');
          if (d.mode === 'multi' && !hasCombines) bad(`"${at}.combines_with" is required when mode is "multi"`);
          if (d.mode !== 'multi' && hasCombines) bad(`"${at}.combines_with" is only valid when mode is "multi"`);
          if (hasCombines && !Array.isArray(o.combines_with)) bad(`"${at}.combines_with" must be an array of option keys`);
          const hasStage = Object.prototype.hasOwnProperty.call(o, 'stage');
          if (d.mode === 'staged' && !hasStage) bad(`"${at}.stage" is required when mode is "staged"`);
          if (d.mode !== 'staged' && hasStage) bad(`"${at}.stage" is only valid when mode is "staged"`);
          if (hasStage && !(Number.isInteger(o.stage) && o.stage >= 1)) bad(`"${at}.stage" must be an integer >= 1`);
          for (const k of Object.keys(o)) {
            if (OPTION_KEYS.indexOf(k) === -1 && k !== 'combines_with' && k !== 'stage') bad(`unknown key "${at}.${k}" — the key set is closed`);
          }
        });
      }
      // Cross-field consistency (§5.3 item 3).
      const rec = d.recommendation;
      if (rec !== null) {
        if (typeof rec !== 'string' || rec.trim() === '') bad('"decision.recommendation" must be null or an option key (or a "+"-joined key list in multi mode)');
        else {
          const keys = d.mode === 'multi' ? rec.split('+').map((k) => k.trim()) : [rec.trim()];
          for (const k of keys) if (optionKeys.length && optionKeys.indexOf(k) === -1) bad(`"decision.recommendation" names ${JSON.stringify(k)}, which is not an option key (${optionKeys.join(', ')})`);
        }
      }
      const reason = d.recommendation_reason;
      if (rec === null && reason !== null) bad('"decision.recommendation_reason" must be null when "recommendation" is null');
      if (rec !== null && reason === null) bad('"decision.recommendation_reason" must be non-null when "recommendation" is non-null');
      if (reason !== null) str('decision.recommendation_reason', reason, { cap: WORD_CAPS['decision.recommendation_reason'] });
      if (d.prerequisite !== null && d.prerequisite !== undefined) str('decision.prerequisite', d.prerequisite, { cap: WORD_CAPS['decision.prerequisite'] });
      if (d.mode === 'staged' && Array.isArray(d.stages)) {
        if (!d.stages.length) bad('"decision.stages" must have at least one stage when mode is "staged"');
        d.stages.forEach((st, i) => {
          if (st === null || typeof st !== 'object') { bad(`"decision.stages[${i}]" must be an object`); return; }
          if (!Number.isInteger(st.stage) || st.stage < 1) bad(`"decision.stages[${i}].stage" must be an integer >= 1`);
          str(`decision.stages[${i}].question`, st.question, { cap: WORD_CAPS['decision.question'] });
        });
      }
    }
  }

  // work_state: done forbids a live decision (§5.3 item 3).
  if (isDoneWorkState(record.work_state) && d !== null && typeof d === 'object') {
    bad(`"work_state" is ${JSON.stringify(record.work_state)} but a live "decision" is present — a finished ticket's decisions belong in decision_history`);
  }
  if (record.human_action === 'decide' && d === null) bad('"human_action" is "decide" but "decision" is null');

  if (arr('decision_history', record.decision_history)) {
    record.decision_history.forEach((h, i) => {
      if (h === null || typeof h !== 'object' || Array.isArray(h)) { bad(`"decision_history[${i}]" must be an object`); return; }
      if (h.mode !== undefined) enumOf(`decision_history[${i}].mode`, h.mode, DECISION_MODES);
    });
  }

  // ── deep layer (§2.5) ──────────────────────────────────────────────────
  if (arr('success_criteria', record.success_criteria)) {
    if (!record.success_criteria.length) bad('"success_criteria" is empty — if genuinely unknown, use one entry "Not recorded" (an explicit, greppable claim)');
    record.success_criteria.forEach((c, i) => str(`success_criteria[${i}]`, c, { cap: WORD_CAPS.success_criterion }));
  }
  if (arr('code_refs', record.code_refs)) {
    record.code_refs.forEach((c, i) => {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) { bad(`"code_refs[${i}]" must be an object`); return; }
      str(`code_refs[${i}].path`, c.path);
    });
  }
  if (arr('related', record.related)) {
    record.related.forEach((rel, i) => {
      if (rel === null || typeof rel !== 'object' || Array.isArray(rel)) { bad(`"related[${i}]" must be an object`); return; }
      if (typeof rel.id !== 'string' || !TICKET_ID_RE.test(rel.id)) bad(`"related[${i}].id" must be a ticket id`);
      enumOf(`related[${i}].relation`, rel.relation, RELATIONS);
      // BUG-128 — a ticket related to ITSELF. Every relation in the set is a
      // claim about two tickets: one supersedes another, blocks another, is a
      // duplicate of another. Pointed at itself each one is either meaningless
      // (`see_also` to the page you are on) or a contradiction (a ticket that
      // blocks itself can never start). It is also the one edge back-edge
      // reconciliation cannot repair, because the ticket it would fix is the
      // ticket that is wrong. Checked here rather than in the reconciler so it
      // is caught wherever a record is read, not only where one is written.
      if (typeof rel.id === 'string' && idsMatch(rel.id, record.id)) {
        bad(`"related[${i}]" points at this ticket itself (${rel.id} ${JSON.stringify(rel.relation)}) — a relation describes two tickets`);
      }
    });
  }
  if (arr('recurrence_evidence', record.recurrence_evidence)) {
    record.recurrence_evidence.forEach((r, i) => {
      if (typeof r !== 'string' || !TICKET_ID_RE.test(r)) bad(`"recurrence_evidence[${i}]" must be a ticket id`);
    });
    if (record.type === 'architecture' && !record.recurrence_evidence.length) {
      bad('"recurrence_evidence" must be non-empty for an architecture ticket — an ARCH ticket asserts a repeated pattern, so it must cite the instances');
    }
  }
  enumOf('verification_class', record.verification_class, VERIFICATION_CLASSES);
  if (arr('verification', record.verification)) {
    record.verification.forEach((e, i) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) { bad(`"verification[${i}]" must be an object`); return; }
      str(`verification[${i}].provider`, e.provider);
      str(`verification[${i}].run_id`, e.run_id);
      enumOf(`verification[${i}].verdict`, e.verdict, VERDICTS);
    });
    // AN EMPTY `verification[]` IS NOT "NOTHING WAS VERIFIED" (BUG-119), and
    // there is no longer a second field that could contradict it (ARCH-009).
    //
    // `verification[]` holds INDEPENDENT clean-room dispatch verdicts — the
    // `Verified-by:` lines — and 169 of the 185 real tickets have none, because
    // that rule only began in 2026-08. Two cross-field rules used to live here,
    // both of them about keeping a DERIVED `verification_state` coherent with
    // this array: which work states could claim which state on an empty array,
    // and that a non-empty array forbade "not_recorded". Both are deleted with
    // the field. That is the substance of option C — coherence between two
    // representations of the same fact stops needing to be enforced when there
    // is only one representation. What the ticket asserts about verification is
    // exactly the entries above, each checked as data.
  }
  if (record.body_slots === null || typeof record.body_slots !== 'object' || Array.isArray(record.body_slots)) {
    bad('"body_slots" must be an object with one boolean per slot');
  } else {
    for (const slot of BODY_SLOTS) {
      if (typeof record.body_slots[slot] !== 'boolean') bad(`"body_slots[${JSON.stringify(slot)}]" must be a boolean — a missing section is a stated fact, not a gap`);
    }
    for (const k of Object.keys(record.body_slots)) {
      if (BODY_SLOTS.indexOf(k) === -1) bad(`unknown body slot ${JSON.stringify(k)} — the slot set is closed: ${BODY_SLOTS.join(', ')}`);
    }
  }
  if (record.source === null || typeof record.source !== 'object' || Array.isArray(record.source)) {
    bad('"source" must be an object carrying migration provenance');
  } else {
    if (record.source.confirmation !== null && record.source.confirmation !== undefined) {
      str('source.confirmation', record.source.confirmation, { cap: WORD_CAPS['source.confirmation'] });
    }
    if (record.source.dropped !== undefined && !Array.isArray(record.source.dropped)) {
      bad('"source.dropped" must be an array of short strings (empty array if nothing was dropped)');
    }
  }

  return { ok: v.length === 0, violations: v };
}

/* ─────────────────────────────────────────────────────────────── formatting */

/**
 * Canonical key order for the on-disk block. Stable order + 2-space indent is
 * what keeps a JSON header's diffs readable (§2.1's stated cost mitigation).
 */
const KEY_ORDER = REQUIRED_KEYS;

function orderKeys(obj, order) {
  const out = {};
  for (const k of order) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = obj[k];
  return out;
}

/**
 * formatTicket — render a record as the leading fenced block, canonicalised.
 * `formatTicket(parseTicket(x).record)` round-trips a well-formed block.
 */
export function formatTicket(record, body = '') {
  const rec = { ...record };
  for (const k of NON_SCHEMA_KEYS) delete rec[k];
  // A RETIRED KEY IS TOLERATED ON READ AND NEVER WRITTEN BACK (ARCH-009). This
  // is the half of the tolerance that keeps it from becoming permanent: a
  // record already on disk may carry `verification_state` and stays valid, but
  // the moment anything re-writes that record the leftover is gone. `orderKeys`
  // appends unknown keys rather than dropping them — deliberately, so a real
  // key is never lost to a stale KEY_ORDER — so the drop is explicit here.
  for (const k of Object.keys(RETIRED_KEYS)) delete rec[k];
  if (rec.decision && typeof rec.decision === 'object' && !Array.isArray(rec.decision)) {
    rec.decision = orderKeys(rec.decision, [...DECISION_KEYS, 'stages']);
    if (Array.isArray(rec.decision.options)) {
      rec.decision.options = rec.decision.options.map((o) => (o && typeof o === 'object' ? orderKeys(o, [...OPTION_KEYS, 'combines_with', 'stage']) : o));
    }
  }
  const json = JSON.stringify(orderKeys(rec, KEY_ORDER), null, 2);
  const tail = body ? (body.startsWith('\n') ? body : `\n${body}`) : '';
  return '```orchard-ticket\n' + json + '\n```\n' + tail;
}
