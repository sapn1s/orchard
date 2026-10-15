#!/usr/bin/env node
/**
 * FEAT-091 — durable response-format metrics: the record side, and the reader
 * that turns those records into "which block are we missing?".
 *
 * WHY THIS IS THE LOAD-BEARING PART. The vocabulary is a fixed set of SEMANTIC
 * categories, and the design says the fallback firing is a SIGNAL TO ADD A
 * CATEGORY. That is only true if the record answers "what KIND of thing keeps
 * landing there", not "how much" — so this file captures the author's own label
 * on every declared `orchard-uncategorized` block, plus the shape and a readable
 * excerpt, and clusters the labels in the report.
 *
 * ── TWO FALLBACKS, NEVER ADDED TOGETHER
 *   declared  — an `orchard-uncategorized` block. The author reached for the
 *               vocabulary and found nothing that fit. This is a VOCABULARY gap:
 *               read the labels, name the missing category, add it.
 *   loose     — prose outside every block. The author did not categorise. This is
 *               a COMPLIANCE gap and calls for the opposite response.
 * Summing them would make both unreadable, so they are separate fields, separate
 * report sections, and separate decision rules.
 *
 * ── WHERE, AND WHY THERE
 * `<dataDir>/logs/response-format-metrics.jsonl`, one JSON object per graded
 * turn. Outside the repo, next to the existing stop-hook advisory log, for the
 * same reason: it is per-machine telemetry, not source, and it must never appear
 * in a commit or an exported tree (BUG-104).
 *
 * ── EVERY GRADED TURN IS RECORDED, not just the ones that fail.
 * Without the compliant turns there is no denominator, and "fallback is rising"
 * is unanswerable. A turn where everything landed inside blocks writes a line
 * too — it is just a small one.
 *
 * ── CONTENT CAPTURE POLICY (this writes reply text to local disk)
 *   - structured message (has blocks) + fallback  -> excerpt KEPT. This is the
 *     signal: the author reached for the format and still had something that did
 *     not fit. Reading these is how a new block gets named.
 *   - unstructured message (no blocks at all)     -> characterisation kept,
 *     excerpt truncated hard. These are expected (short replies need no
 *     ceremony), so they must not dominate the file or the disk.
 *   - per-line and per-file caps, plus one-generation rotation, so a long-running
 *     machine cannot be filled by telemetry.
 *
 * ── SAFETY: nothing here may affect a turn. Every export swallows its own
 * errors and returns a status instead of throwing. The Stop hook calls
 * `recordTurn` inside its own try/catch as a second belt.
 *
 * CLI:  node scripts/lib/format-metrics.mjs report [--file PATH] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractProse } from './readability.mjs';

/* ── caps ───────────────────────────────────────────────────────────────────── */

const MAX_RUNS_PER_TURN = 12;      // beyond this, count only (a pathological message)
const MAX_LINE_BYTES = 24 * 1024;  // one turn's record
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const UNSTRUCTURED_EXCERPT = 240;  // expected case: characterise, do not archive

/* FEAT-125 length budget, read back as measurement ceilings (FEAT-127). */
const DEFAULT_WORD_CEILING = 120;  // default per-turn prose budget
const HANDOFF_WORD_CEILING = 250;  // the higher budget for a handoff / pending decision

/* ── paths ──────────────────────────────────────────────────────────────────── */

/** dataDir() mirror — same resolution the Stop hook uses; no server-graph import. */
export function dataDir() {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

export function metricsPath(dir) {
  return path.join(dir ?? dataDir(), 'logs', 'response-format-metrics.jsonl');
}

/* ── prose-volume metric (FEAT-127) ──────────────────────────────────────────
 * FEAT-125 gave the length budget as INJECTED ADVICE; discipline has failed the
 * user twice, so the two failure modes are now MEASURED per graded turn:
 *   - proseWords : the words a reader actually reads — every category block's
 *                  body plus loose prose — EXCLUDING the `orchard-digest` JSON and
 *                  the fence wrappers themselves (block bodies already have their
 *                  fences stripped by the parser; the digest block is skipped).
 *   - askBlocks  : how many `orchard-ask` blocks the turn handed over. A turn with
 *                  more than one ask, or an ask over a decision that was not the
 *                  user's, is the second failure mode this ticket exists to watch.
 * ADVISORY BY NATURE: this records numbers, it does not truncate or block. The
 * Stop hook already cannot cost a turn (advisory), and neither can this — it is a
 * lens on the transcript, not a gate.
 *
 * The word rule matches characterise() EXACTLY (`[A-Za-z][A-Za-z'-]*`), so a
 * block body and a loose run are counted the same way and proseWords is the sum
 * of comparable units.
 *
 * BUG-192 — before counting, each unit is run through readability's extractProse,
 * so the length budget excludes exactly what the READABILITY check excludes:
 * markdown tables, blockquotes (quoted evidence), URLs (link targets) and fenced
 * code. Counting those against the budget penalised the very things the injected
 * budget's DO-NOT-CUT list requires (before/after evidence, quoted output), and
 * disagreed with the readability grader on the same reply. This is why fallback
 * runs are recomputed from `r.text` rather than trusting the parser's precomputed
 * `r.words`, which counts table/quote/link words. */
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
function wordCount(s) {
  return (String(s ?? '').match(WORD_RE) || []).length;
}
/** Count words a reader actually reads: strip tables/quotes/links/code first. */
function proseWordsOf(s) {
  return wordCount(extractProse(s));
}

/**
 * Prose words a reader reads this turn, and the number of asks. Pure; derived
 * from the parseResponseBlocks() result so it needs no transcript re-read.
 * Digest JSON, fence wrappers, tables, blockquotes, links and code are excluded
 * (see the note above — consistent with the readability grader).
 */
export function proseVolume(parsed) {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let words = 0;
  for (const b of blocks) {
    if (!b || b.name === 'orchard-digest') continue; // JSON, not prose
    words += proseWordsOf(b.content);
  }
  const runs = Array.isArray(parsed?.fallbackRuns) ? parsed.fallbackRuns : [];
  for (const r of runs) {
    if (typeof r?.text === 'string') words += proseWordsOf(r.text);
    else if (typeof r?.words === 'number') words += r.words; // no text to re-strip
  }
  const askBlocks = Number(parsed?.counts?.['orchard-ask'] || 0);
  return { proseWords: words, askBlocks };
}

/**
 * Which length budget applies this turn, and whether the reply is over it
 * (FEAT-138 — the ENFORCED form of the FEAT-125 length budget).
 *   - default : ≤120 words of prose.
 *   - handoff : ≤250 words when the turn carries a PENDING DECISION — i.e. an
 *               `orchard-ask`. This is the only "handoff" the Stop hook can grade:
 *               a lane→orchestrator handoff is a sidechain the hook never sees, so
 *               on the main thread the ask turn IS the pending-decision turn.
 * Pure; derived from the same parseResponseBlocks() result as proseVolume().
 */
export function evaluateLength(parsed) {
  const { proseWords, askBlocks } = proseVolume(parsed);
  const ceiling = askBlocks > 0 ? HANDOFF_WORD_CEILING : DEFAULT_WORD_CEILING;
  return { proseWords, askBlocks, ceiling, over: proseWords > ceiling };
}

/* ── ask-ownership gate (FEAT-137) ────────────────────────────────────────────
 * The MECHANICAL form of WA §A's ownership test. Every `orchard-ask` must declare,
 * in its own body, a CONFIDENCE and a DECIDER — the user-held thing that makes the
 * call theirs (since BUG-256: one of HARD_STOPS below, with its consequence). The
 * defect this catches is the one the user hit verbatim ("there is a breaking bug
 * which will corrupt data … not sure if u want to fix it tho, so i will leave it"):
 * a HIGH-confidence ask that names no user-held decider is not the user's decision
 * at all — it is the author's, and should have been decided, not handed over.
 *
 * HONEST LIMITATION, stated where the code is: this is a PRESENCE/well-formedness
 * check, not a truth check. It verifies the ask carries a recognised `confidence:`
 * level and a `decider:` line naming a hard stop plus a consequence (BUG-256); it
 * CANNOT verify the named stop is true (a model can type `decider: taste — …` over a
 * pure sequencing choice) — the stated consequence makes such a relabel auditable. It catches the missing or unnameable declaration — the shape the user
 * actually hit — and the report surfaces the rest for a human to read. */
const CONFIDENCE_RE = /^[ \t>*+-]*confidence[ \t]*:[ \t]*(high|hi|med(?:ium)?|low|lo)\b/im;
const DECIDER_RE = /^[ \t>*+-]*decider[ \t]*:[ \t]*(\S.*)$/im;

/* ── BUG-256: the decider is a CLOSED list of hard stops, with its consequence ──
 * FEAT-137 accepted any text after `decider:`. Measured over 282 real asks
 * (docs/research/unnecessary-asks-2026-10-14.md), naming a decider did not
 * separate the user's calls from the agent's own (71/160 vs 55/122 unnecessary):
 * `priority (whether to spend on it now)`, `spend`, a generic `risk` and even
 * `none` passed. An ask is now legitimate only for one of these stops — the WA §A
 * list (r3: the WHOLE decider value, exactly) — and a `consequence:` line must say
 * the concrete consequence (≥ 3 words),
 * so a relabel is at least visible to an audit. `info` (a fact only the user has)
 * and `blocked` (a technical block the agent cannot clear) keep the
 * unresolved-information and technical-blocker paths open. Agent effort, ordering
 * and "another round?" on work already asked for are deliberately NOT here. */
export const HARD_STOPS = Object.freeze([
  'irreversible', // cannot be undone (history rewrite, deleting user data)
  'outward',      // publishes or sends outside this machine (push, public repo, external service)
  'live',         // restarts or interrupts running work (service restart, killing a session)
  'git',          // a git write the user holds under their standing rule
  'access',       // a credential, sudo, or permission only the user can grant
  'money',        // real spend of the user's money or account quota (a paid plan, a purchase, burning a weekly limit)
  'taste',        // the user's own look-and-feel preference on something they will use
  'direction',    // a new goal or product direction beyond what was asked
  'info',         // a fact only the user has (what they saw, what they want kept)
  'blocked',      // a technical block the agent cannot clear itself
]);
const MIN_CONSEQUENCE_WORDS = 3;

/**
 * Read an ask's `decider:` and `consequence:` lines. Pure. Returns null when there
 * is no `decider:` line, else `{ raw, lead, hardStop, consequence, consequenceWords }`.
 *
 * BUG-256 r3 — EXACT GRAMMAR (orchestrator adjudication after the third break of the
 * token parse: r1 joined tokens, r2 compounds `live-priority` / `live_ops` → lead=live).
 * The decider VALUE is the whole text after `decider:` on that line, trimmed and
 * case-folded, and it must EQUAL one HARD_STOPS code. Nothing else is accepted:
 * no compounds, separators, wrappers, multiple codes or trailing words. There is no
 * lead-token or split step to get wrong — it is an allowlist of whole values, not an
 * enumeration of bad shapes. `hardStop` is that code, else null; `lead` is the
 * case-folded whole value (telemetry: what was actually declared).
 * The consequence lives on its OWN `consequence:` line; `consequenceWords` counts
 * word-like segments with Intl.Segmenter so any script counts (r1 B3).
 * The check is WELL-FORMEDNESS, not truth: a relabel under a list code with a
 * stated consequence passes by design; scripts/ask-audit.mjs measures it.
 */
const CONSEQUENCE_RE = /^[ \t>*+-]*consequence[ \t]*:[ \t]*(\S.*)$/im;
const WORDS = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
export function consequenceWordCount(text) {
  const t = String(text ?? '');
  if (WORDS) { let n = 0; for (const s of WORDS.segment(t)) if (s.isWordLike) n++; return n; }
  return (t.match(/[\p{L}\p{N}$][\p{L}\p{N}\p{M}$'.%-]*/gu) ?? []).length;
}
/** The exact-grammar verdict on one decider VALUE: the HARD_STOPS code it equals, else null. */
export function hardStopCode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return HARD_STOPS.includes(v) ? v : null;
}
export function deciderOf(content) {
  const text = String(content ?? '');
  const m = DECIDER_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  const c = CONSEQUENCE_RE.exec(text);
  const consequence = c ? c[1].trim() : '';
  return { raw, lead: raw.toLowerCase(), hardStop: hardStopCode(raw), consequence, consequenceWords: consequenceWordCount(consequence) };
}
/**
 * BUG-259 — THE one ownership verdict over a parsed decider, shared by the
 * turn-end ask check (askOwnershipDefects, below) and the board's decision-card
 * writer (`board-tool decide --decider=…`), so a chat ask and a Needs-You card
 * are held to the same closed list and the same consequence floor (ARCH-010).
 * Pure. `null` when the declaration is well-formed, else the defect code.
 */
export function hardStopDefect(decider) {
  if (!decider || !decider.hardStop) return 'decider-not-hard-stop';
  if (decider.consequenceWords < MIN_CONSEQUENCE_WORDS) return 'decider-no-consequence';
  return null;
}

/* ── ask subject: WHAT the ask is about, crossed with its decider ─────────────
 * The decider says WHY a call is the user's; it never said WHAT is being decided,
 * so an ask about the agent's own work passed under any well-formed code. Measured
 * in session 20ed61fc (2026-10-13): "I recommend one more round" passed as
 * `decider: spend` and idled the session ~420 min overnight; "Shall I file it and
 * start the fix?" and "Shall I measure it before you decide?" were the same shape.
 * Every `orchard-ask` now declares `about:` — EXACTLY one closed-list subject (the
 * BUG-256 r3 exact grammar: the whole trimmed, case-folded value, nothing else).
 *
 * AGENT_OWNED_SUBJECTS are the agent's call (WA §A): the ask is refused unless its
 * decider is one of OWNED_SUBJECT_EXEMPT_STOPS — the ACTION stops, where the
 * recommendation itself is irreversible, outward-facing, spends the user's money or
 * account quota, or is an act the agent may not take alone (a live restart, a git
 * write, a credential or permission). Under taste/direction/info/blocked the pair
 * is incoherent — a true direction fork is `about: goal`, taste is `preference`, a
 * fact is `fact`, a block is `action` — so it is refused. Measured on 40 real asks
 * (2026-10-14): the strict three-stop list refused real commit and other-repo asks.
 * The classification is the declared subject × the decider, never the ask's prose:
 * no phrase list. Honest limit, as for the decider: a mislabelled subject passes;
 * the declaration is recorded (`askSubjects`) so ask-audit can measure it. */
export const AGENT_OWNED_SUBJECTS = Object.freeze([
  'sequencing',     // what order, or when, to do work already asked for
  'implementation', // how to deliver what was asked when the user's outcome is the same either way: approach, design, which fix
  'round',          // whether to run another fix / verify / review round
  'next-step',      // whether to proceed with the next step of the requested work
  'approval',       // a go-ahead on the agent's own recommendation
]);
export const USER_SUBJECTS = Object.freeze([
  'goal',       // a fork in what to build or pursue, or a policy the user lives under (security posture, what agents may do, method)
  'preference', // the user's own look-and-feel or working preference (taste)
  'fact',       // something only the user knows (info)
  'action',     // something only the user can do: a click, a restart, a git write, a credential
  'spend',      // whether to spend the user's money or account quota
]);
export const ASK_SUBJECTS = Object.freeze([...AGENT_OWNED_SUBJECTS, ...USER_SUBJECTS]);
export const OWNED_SUBJECT_EXEMPT_STOPS = Object.freeze(['irreversible', 'outward', 'money', 'live', 'git', 'access']);
const ABOUT_RE = /^[ \t>*+-]*about[ \t]*:[ \t]*(\S.*)$/im;

/** Read an ask's `about:` line. Pure. null when absent, else `{ raw, subject }` (subject null if off-list). */
export function aboutOf(content) {
  const m = ABOUT_RE.exec(String(content ?? ''));
  if (!m) return null;
  const raw = m[1].trim();
  const v = raw.toLowerCase();
  return { raw, subject: ASK_SUBJECTS.includes(v) ? v : null };
}
/**
 * The subject verdict for one ask. Pure. `null` when it passes, else
 *   'ask-agent-owned'   — an agent-owned subject whose decider is not an exempt stop;
 *   'ask-about-unknown' — the `about:` value is not exactly one ASK_SUBJECTS code;
 *   'ask-missing-about' — no `about:` line.
 */
export function subjectDefect(about, decider) {
  if (!about) return 'ask-missing-about';
  if (!about.subject) return 'ask-about-unknown';
  if (AGENT_OWNED_SUBJECTS.includes(about.subject)
      && !OWNED_SUBJECT_EXEMPT_STOPS.includes(decider?.hardStop ?? '')) return 'ask-agent-owned';
  return null;
}
// WA §A "a recommendation is a claim — vet it like code": what the recommendation
// rests on (N and source) and whether it was independently refuted. Recognised the
// SAME way as decider, but OPTIONAL — its absence is never a defect, so older replies
// that predate the field still parse and still pass the gate. Recorded as telemetry
// (asksWithEvidence) so uptake is visible without being enforced.
const EVIDENCE_RE = /^[ \t>*+-]*evidence[ \t]*:[ \t]*(\S.*)$/im;

/** Normalise a declared confidence token to high|med|low, or '' when absent. */
function confidenceLevel(content) {
  const m = CONFIDENCE_RE.exec(String(content ?? ''));
  if (!m) return '';
  const t = m[1].toLowerCase();
  if (t === 'high' || t === 'hi') return 'high';
  if (t === 'low' || t === 'lo') return 'low';
  return 'med';
}

/**
 * Ownership defects across every `orchard-ask` block in a parsed reply. Pure.
 * One entry per offending ask: `{ confidence, hasDecider, defect }`, where defect is
 *   'missing-confidence'          — no recognised `confidence:` line at all.
 *   'high-confidence-no-decider'  — the CORE defect: confident AND no user-held decider.
 *   'missing-decider'             — a `decider:` line is absent (med/low confidence).
 *   'decider-not-hard-stop'       — BUG-256: the decider names no HARD_STOPS entry
 *                                   (priority, spend, risk, none, …): the agent's call.
 *   'decider-no-consequence'      — BUG-256: a hard stop with no stated consequence.
 *   'ask-agent-owned'             — the `about:` subject is the agent's own call
 *                                   (sequencing, implementation, round, next-step,
 *                                   approval) and the decider is not an exempt stop.
 *                                   Checked first, before any label defect.
 *   'ask-missing-about' / 'ask-about-unknown' — no `about:` line, or an off-list one.
 * A well-formed ask (a confidence, a hard-stop decider with its consequence, and a
 * user-held subject or an exempt stop) contributes nothing.
 */
export function askOwnershipDefects(parsed) {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const out = [];
  for (const b of blocks) {
    if (!b || b.name !== 'orchard-ask') continue;
    const content = String(b.content ?? '');
    const confidence = confidenceLevel(content);
    const decider = deciderOf(content);
    const hasDecider = decider !== null;
    const about = aboutOf(content);
    // An agent-owned subject is refused FIRST: telling the author to fix its
    // decider label would invite a relabel of a call that was never the user's.
    const subjectVerdict = subjectDefect(about, decider);
    if (subjectVerdict === 'ask-agent-owned') {
      out.push({ confidence, hasDecider, decider: decider?.raw, about: about.subject, defect: subjectVerdict });
      continue;
    }
    if (!confidence) { out.push({ confidence: '', hasDecider, defect: 'missing-confidence' }); continue; }
    if (!hasDecider) {
      out.push({ confidence, hasDecider, defect: confidence === 'high' ? 'high-confidence-no-decider' : 'missing-decider' });
      continue;
    }
    const defect = hardStopDefect(decider);
    if (defect) { out.push({ confidence, hasDecider, decider: decider.raw, defect }); continue; }
    if (subjectVerdict) out.push({ confidence, hasDecider, decider: decider.raw, about: about?.raw, defect: subjectVerdict });
  }
  return out;
}

/** Does an ask body declare an `evidence:` line? OPTIONAL — absence is never a defect. Pure. */
export function hasEvidence(content) {
  return EVIDENCE_RE.test(String(content ?? ''));
}

/**
 * Count of `orchard-ask` blocks that carry an `evidence:` line (WA §A). Pure.
 * Telemetry only — its absence is never flagged, so this never gates a reply.
 */
export function asksWithEvidence(parsed) {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let n = 0;
  for (const b of blocks) {
    if (b && b.name === 'orchard-ask' && hasEvidence(b.content)) n++;
  }
  return n;
}

/* ── completion-claim extraction (FEAT-150) ───────────────────────────────────
 * The MECHANICAL surface for "the orchestrator said done for something that was
 * only filed / built / unverified". A completion claim is not fuzzy prose — it is
 * a STRUCTURED digest item whose kind is `done` (KIND_ALIAS folds
 * done/changed/completed/complete into it). This function only EXTRACTS those
 * items and the ticket they reference; it grades NOTHING, because the grading is a
 * ground-truth read of the board (board-status.mjs) that must not live in this
 * dependency-light, disk-free module. The stop-hook does the binding.
 *
 * Input is the parseDigest() result ({ items, ... } | null), NOT a
 * parseResponseBlocks() result — completion claims live in the digest rail, which
 * is the one place the reader scans for "what got done". Pure. */
export function completionClaims(digest) {
  const items = Array.isArray(digest?.items) ? digest.items : [];
  const out = [];
  for (const it of items) {
    if (!it || it.kind !== 'done') continue;
    const text = typeof it.text === 'string' ? it.text : '';
    const ref = typeof it.ref === 'string' && it.ref.trim() ? it.ref.trim() : null;
    out.push({ text, ref });
  }
  return out;
}

/* ── record ─────────────────────────────────────────────────────────────────── */

/**
 * Build the JSONL record for one graded turn from a parseResponseBlocks() result.
 * Pure — split out from the write so it is testable without touching a disk.
 */
export function buildRecord(parsed, meta = {}) {
  const structured = parsed?.shape === 'structured';
  const runs = Array.isArray(parsed?.fallbackRuns) ? parsed.fallbackRuns : [];
  const kept = runs.slice(0, MAX_RUNS_PER_TURN).map((r) => ({
    position: r.position,
    chars: r.chars,
    lines: r.lines,
    words: r.words,
    tags: r.tags,
    // The archive: full excerpt when the author was using the format, a short
    // characterising snippet when they legitimately were not.
    excerpt: structured ? r.excerpt : String(r.excerpt ?? '').slice(0, UNSTRUCTURED_EXCERPT),
  }));
  // The DECLARED fallback, with the author's label kept verbatim — the label is
  // the only part of this record that can name a new category, so it is never
  // truncated away by the excerpt caps below.
  const declared = (Array.isArray(parsed?.declaredUncategorized) ? parsed.declaredUncategorized : [])
    .slice(0, MAX_RUNS_PER_TURN)
    .map((d) => ({
      label: typeof d.label === 'string' ? d.label.slice(0, 160) : '',
      chars: d.chars,
      lines: d.lines,
      words: d.words,
      tags: d.tags,
      excerpt: d.excerpt,
    }));
  const volume = proseVolume(parsed);
  const len = evaluateLength(parsed);
  const ownership = askOwnershipDefects(parsed);
  return {
    v: 2,
    ts: new Date().toISOString(),
    proseWords: volume.proseWords,
    askBlocks: volume.askBlocks,
    // FEAT-137/138 enforcement telemetry: was this turn over its length budget,
    // and how many asks were unowned (so the report shows whether enforcement is
    // biting and how often, not just whether the checks exist).
    lengthCeiling: len.ceiling,
    overLengthBudget: len.over,
    asksMissingConfidence: ownership.filter((d) => d.defect === 'missing-confidence').length,
    asksHighNoDecider: ownership.filter((d) => d.defect === 'high-confidence-no-decider').length,
    asksMissingDecider: ownership.filter((d) => d.defect === 'missing-decider').length,
    // BUG-256 telemetry: which decider each ask named (first token, lower-case;
    // '' when none), and how many named no hard stop — so a later ask audit can
    // re-measure the unnecessary-ask share without re-parsing transcripts.
    deciderTokens: (Array.isArray(parsed?.blocks) ? parsed.blocks : [])
      .filter((b) => b && b.name === 'orchard-ask')
      .map((b) => { const d = deciderOf(b.content); return d ? d.lead : ''; }), // r2: the TRUE lead, never a later joined code
    asksNotHardStop: ownership.filter((d) => d.defect === 'decider-not-hard-stop').length,
    asksNoConsequence: ownership.filter((d) => d.defect === 'decider-no-consequence').length,
    // Ask-subject telemetry: the declared `about:` per ask (case-folded; '' when
    // none) and how many were refused as the agent's own call.
    askSubjects: (Array.isArray(parsed?.blocks) ? parsed.blocks : [])
      .filter((b) => b && b.name === 'orchard-ask')
      .map((b) => { const a = aboutOf(b.content); return a ? a.raw.toLowerCase() : ''; }),
    asksAgentOwned: ownership.filter((d) => d.defect === 'ask-agent-owned').length,
    asksMissingAbout: ownership.filter((d) => d.defect === 'ask-missing-about' || d.defect === 'ask-about-unknown').length,
    // OPTIONAL field (WA §A): how many asks carry an `evidence:` line. Recorded for
    // uptake visibility only — its absence is never a defect and never blocks.
    asksWithEvidence: asksWithEvidence(parsed),
    session_id: typeof meta.session_id === 'string' ? meta.session_id : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    shape: parsed?.shape ?? 'unstructured',
    totalChars: parsed?.totalChars ?? 0,
    blockChars: parsed?.blockChars ?? 0,
    fallbackChars: parsed?.fallbackChars ?? 0,
    counts: parsed?.counts ?? {},
    unknownBlocks: (parsed?.unknownBlocks ?? []).map((u) => u.name),
    malformed: parsed?.malformed ?? [],
    fallbackRuns: kept,
    fallbackRunsTotal: runs.length,
    declaredUncategorized: declared,
    declaredUncategorizedTotal: (parsed?.declaredUncategorized ?? []).length,
  };
}

/** Rotate one generation when the file gets large. Best-effort, never throws. */
function rotateIfLarge(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch { /* missing file or a rename race: nothing to rotate */ }
}

/**
 * Append one turn's metrics. Returns `{ ok, file, reason? }`; NEVER throws, so a
 * full disk or a read-only data dir cannot cost the user a turn.
 */
export function recordTurn(parsed, meta = {}) {
  const file = meta.file ?? metricsPath(meta.dataDir);
  try {
    const rec = buildRecord(parsed, meta);
    let line = JSON.stringify(rec);
    if (line.length > MAX_LINE_BYTES) {
      // Drop the excerpts before dropping the record: the counts and tags are the
      // part we cannot reconstruct later, the prose is recoverable from the
      // transcript itself.
      rec.fallbackRuns = rec.fallbackRuns.map((r) => ({ ...r, excerpt: String(r.excerpt).slice(0, 200) }));
      rec.declaredUncategorized = rec.declaredUncategorized.map((d) => ({ ...d, excerpt: String(d.excerpt).slice(0, 200) }));
      rec.truncated = true;
      line = JSON.stringify(rec);
      if (line.length > MAX_LINE_BYTES) {
        // Labels survive even here: they are what a human reads to name the next
        // category, and they are two orders of magnitude smaller than the prose.
        rec.fallbackRuns = [];
        rec.declaredUncategorized = rec.declaredUncategorized.map((d) => ({ label: d.label, chars: d.chars, tags: d.tags }));
        line = JSON.stringify(rec);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file);
    fs.appendFileSync(file, line + '\n');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, reason: err?.message ?? String(err) };
  }
}

/* ── read ───────────────────────────────────────────────────────────────────── */

/**
 * Aggregate the JSONL into the decision surface described in the FEAT-091
 * ticket. Tolerates a partially-written last line (the hook appends while a
 * reader may be running) — an unparseable line is skipped, never fatal.
 */
export function summariseMetrics(file = metricsPath()) {
  const out = {
    file,
    turns: 0,
    skippedLines: 0,
    structured: 0,
    unstructured: 0,
    blockCounts: {},
    unknownBlockCounts: {},
    malformedCounts: {},
    fallbackCharsTotal: 0,
    blockCharsTotal: 0,
    // The headline ratio: of the turns where the author DID use the format, how
    // much of the message still landed outside it.
    structuredFallbackChars: 0,
    structuredTotalChars: 0,
    runsByPosition: {},
    tagCounts: {},
    /* The DECLARED fallback — kept entirely separate from loose prose above. */
    declaredTurns: 0,
    declaredBlocks: 0,
    declaredChars: 0,
    declaredUnlabelled: 0,
    /** The author's own words for what did not fit, clustered. This is the list
     *  a human reads to decide which category the vocabulary is missing. */
    declaredLabelCounts: {},
    declaredTagCounts: {},
    declaredSamples: [],
    /** Co-occurring tag signatures, most frequent first — the "what shape is it" view. */
    signatures: {},
    samples: [],
    /* ── PROSE VOLUME & ASKS (FEAT-127) — the two failure modes, measured.
     * proseWords per turn is collected so the report can give mean/median and
     * count turns over each ceiling; asks are the second axis. Advisory. */
    proseWordSamples: [],
    proseWordsMax: 0,
    overDefaultCeiling: 0,   // > 120 words (the FEAT-125 default budget)
    overHandoffCeiling: 0,   // > 250 words (the handoff/decision budget)
    asksTotal: 0,
    turnsWithAsk: 0,         // >= 1 orchard-ask
    turnsWithMultipleAsks: 0, // >= 2 orchard-ask in one turn
    biggestProseTurns: [],   // {ts, proseWords, askBlocks}
    /* ── ENFORCEMENT (FEAT-137/138) — how often the two gates would/did bite.
     * These count turns whose LAST-message record carries the enforcement fields
     * (older records simply do not contribute). */
    enforcedTurns: 0,        // turns recorded since the enforcement fields existed
    overLengthTurns: 0,      // turns over their applicable length ceiling
    asksMissingConfidence: 0,
    asksHighNoDecider: 0,    // the core ownership defect
    asksMissingDecider: 0,
  };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { out.skippedLines++; continue; }
    if (!rec || typeof rec !== 'object') { out.skippedLines++; continue; }
    out.turns++;
    if (rec.shape === 'structured') out.structured++; else out.unstructured++;

    // PROSE VOLUME & ASKS (FEAT-127). Older records (before this field existed)
    // simply do not contribute — proseWords is absent, not zero, so it is skipped.
    if (typeof rec.proseWords === 'number') {
      out.proseWordSamples.push(rec.proseWords);
      if (rec.proseWords > out.proseWordsMax) out.proseWordsMax = rec.proseWords;
      if (rec.proseWords > DEFAULT_WORD_CEILING) out.overDefaultCeiling++;
      if (rec.proseWords > HANDOFF_WORD_CEILING) out.overHandoffCeiling++;
      out.biggestProseTurns.push({ ts: rec.ts, proseWords: rec.proseWords, askBlocks: Number(rec.askBlocks || 0) });
    }
    const asks = Number(rec.askBlocks || rec.counts?.['orchard-ask'] || 0);
    out.asksTotal += asks;
    if (asks >= 1) out.turnsWithAsk++;
    if (asks >= 2) out.turnsWithMultipleAsks++;

    // ENFORCEMENT telemetry (FEAT-137/138). `overLengthBudget` is the marker that
    // a record predates or postdates the enforcement fields.
    if (typeof rec.overLengthBudget === 'boolean') {
      out.enforcedTurns++;
      if (rec.overLengthBudget) out.overLengthTurns++;
    }
    out.asksMissingConfidence += Number(rec.asksMissingConfidence || 0);
    out.asksHighNoDecider += Number(rec.asksHighNoDecider || 0);
    out.asksMissingDecider += Number(rec.asksMissingDecider || 0);
    out.fallbackCharsTotal += rec.fallbackChars || 0;
    out.blockCharsTotal += rec.blockChars || 0;
    if (rec.shape === 'structured') {
      out.structuredFallbackChars += rec.fallbackChars || 0;
      out.structuredTotalChars += rec.totalChars || 0;
    }
    for (const [k, v] of Object.entries(rec.counts || {})) out.blockCounts[k] = (out.blockCounts[k] || 0) + (v || 0);
    for (const n of rec.unknownBlocks || []) out.unknownBlockCounts[n] = (out.unknownBlockCounts[n] || 0) + 1;
    for (const m of rec.malformed || []) {
      const kind = String(m).split(':')[0];
      out.malformedCounts[kind] = (out.malformedCounts[kind] || 0) + 1;
    }
    const decl = Array.isArray(rec.declaredUncategorized) ? rec.declaredUncategorized : [];
    if (decl.length) out.declaredTurns++;
    for (const d of decl) {
      out.declaredBlocks++;
      out.declaredChars += d.chars || 0;
      const label = String(d.label || '').trim();
      if (!label) out.declaredUnlabelled++;
      // Cluster case-insensitively: "Copy-paste artifact" and "copy-paste
      // artifact" are the same evidence and must not read as two shapes.
      const key = label ? label.toLowerCase() : '(no label — a defect: the signal is lost)';
      out.declaredLabelCounts[key] = (out.declaredLabelCounts[key] || 0) + 1;
      for (const t of Array.isArray(d.tags) ? d.tags : []) out.declaredTagCounts[t] = (out.declaredTagCounts[t] || 0) + 1;
      out.declaredSamples.push({ ts: rec.ts, label, chars: d.chars, tags: d.tags || [], excerpt: d.excerpt });
    }
    for (const run of rec.fallbackRuns || []) {
      out.runsByPosition[run.position] = (out.runsByPosition[run.position] || 0) + 1;
      const tags = Array.isArray(run.tags) ? run.tags : [];
      for (const t of tags) out.tagCounts[t] = (out.tagCounts[t] || 0) + 1;
      const sig = tags.slice().sort().join('+') || '(none)';
      out.signatures[sig] = (out.signatures[sig] || 0) + 1;
      // Keep the biggest structured-message runs: the most expensive uncategorized
      // content is the best evidence for what a new block would be for.
      if (rec.shape === 'structured') {
        out.samples.push({ ts: rec.ts, chars: run.chars, position: run.position, tags, excerpt: run.excerpt });
      }
    }
  }
  out.samples.sort((a, b) => b.chars - a.chars);
  out.samples = out.samples.slice(0, 20);
  out.declaredSamples.sort((a, b) => b.chars - a.chars);
  out.declaredSamples = out.declaredSamples.slice(0, 20);
  out.fallbackShareStructured = out.structuredTotalChars
    ? out.structuredFallbackChars / out.structuredTotalChars
    : 0;

  // Prose-volume summary stats (FEAT-127).
  const pv = out.proseWordSamples.slice().sort((a, b) => a - b);
  out.proseWordsTurns = pv.length;
  out.proseWordsMean = pv.length ? pv.reduce((n, x) => n + x, 0) / pv.length : 0;
  out.proseWordsMedian = pv.length ? pv[Math.floor((pv.length - 1) / 2)] : 0;
  out.asksPerTurn = out.turns ? out.asksTotal / out.turns : 0;
  out.biggestProseTurns.sort((a, b) => b.proseWords - a.proseWords);
  out.biggestProseTurns = out.biggestProseTurns.slice(0, 5);
  return out;
}

/** Human-readable report — what a person runs to decide whether to add a block. */
export function formatReport(s) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const top = (obj, n = 8) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `      ${String(v).padStart(5)}  ${k}`).join('\n') || '      (none)';
  const lines = [
    `response-format metrics — ${s.file}`,
    `  turns graded          : ${s.turns}  (structured ${s.structured} / unstructured ${s.unstructured}, ${s.skippedLines} unreadable lines)`,
    `  fallback share        : ${pct(s.fallbackShareStructured)} of characters in STRUCTURED messages landed outside every block`,
    `  chars                 : blocks ${s.blockCharsTotal}, fallback ${s.fallbackCharsTotal}`,
    '  blocks used (by category):',
    top(s.blockCounts, 12),
    '',
    '  PROSE VOLUME & ASKS (FEAT-127 measured; FEAT-137/138 ENFORCED) — the two failure modes.',
    '  The measurements below are the lens FEAT-127 added; the ENFORCEMENT block after them',
    '  says how often the Stop hook is now asking for a revision (FEAT-125 length budget and',
    '  the WA §A ask-ownership rule are no longer advice-only on the main thread).',
    `    prose words/turn       : mean ${s.proseWordsMean.toFixed(0)}, median ${s.proseWordsMedian}, max ${s.proseWordsMax}  (over ${s.proseWordsTurns} turns with the field)`,
    `    over ${DEFAULT_WORD_CEILING}-word budget    : ${s.overDefaultCeiling} turns${s.proseWordsTurns ? ` (${pct(s.overDefaultCeiling / s.proseWordsTurns)})` : ''}`,
    `    over ${HANDOFF_WORD_CEILING}-word handoff cap: ${s.overHandoffCeiling} turns${s.proseWordsTurns ? ` (${pct(s.overHandoffCeiling / s.proseWordsTurns)})` : ''}`,
    `    orchard-ask blocks     : ${s.asksTotal} total, ${s.asksPerTurn.toFixed(2)} per turn; ${s.turnsWithAsk} turns had an ask, ${s.turnsWithMultipleAsks} had MORE THAN ONE`,
    '    biggest prose turns (words / asks):',
    (s.biggestProseTurns.length
      ? s.biggestProseTurns.map((t) => `      ${String(t.proseWords).padStart(5)}w  ${t.askBlocks} ask  ${t.ts}`).join('\n')
      : '      (none)'),
    '',
    '  ENFORCEMENT (FEAT-137/138) — turns the Stop hook would ask to revise, over the',
    `  ${s.enforcedTurns} turns recorded since enforcement shipped:`,
    `    over the length budget : ${s.overLengthTurns} turns${s.enforcedTurns ? ` (${pct(s.overLengthTurns / s.enforcedTurns)})` : ''}  (blocked once for a tighter re-send)`,
    `    unowned asks           : ${s.asksHighNoDecider} high-confidence with NO decider (the core defect), ${s.asksMissingDecider} other missing-decider, ${s.asksMissingConfidence} missing-confidence`,
    '',
    '  DECLARED UNCATEGORIZED — the author reached for the vocabulary and nothing fit.',
    '  This is the signal the design exists to produce: a repeated label here NAMES',
    '  the category that is missing.',
    `    blocks ${s.declaredBlocks} across ${s.declaredTurns} turns, ${s.declaredChars} chars, ${s.declaredUnlabelled} with NO label`,
    '    what the author called it:',
    top(s.declaredLabelCounts, 12),
    '    shape tags of that content:',
    top(s.declaredTagCounts, 10),
    '',
    '  LOOSE PROSE — content left outside every block. A different problem: the',
    '  author did not categorise, so there is nothing to read but the shape.',
    '  fallback runs by position:',
    top(s.runsByPosition),
    '  fallback tag frequency:',
    top(s.tagCounts, 12),
    '  fallback tag SIGNATURES (co-occurring shape — a dominant one names the missing block):',
    top(s.signatures, 10),
    '  unknown orchard-* names seen:',
    top(s.unknownBlockCounts),
    '  malformed:',
    top(s.malformedCounts),
    '',
    '  DECIDE — two different decisions, from two different numbers:',
    '   * ADD A CATEGORY when one label (or one obvious family of labels) accounts',
    '     for a third or more of the declared uncategorized blocks over >= 50 graded',
    '     turns. The label is the proposed name. Read the samples below first.',
    '   * FIX COMPLIANCE (not the vocabulary) when loose-prose share in structured',
    '     messages stays above 15% while declared uncategorized stays near zero:',
    '     that is content nobody tried to categorise, and a new name will not help.',
    '',
    '  largest DECLARED uncategorized blocks:',
  ];
  for (const sm of s.declaredSamples.slice(0, 5)) {
    lines.push(`    - ${sm.chars} chars, label: ${sm.label || '(none)'} [${(sm.tags || []).join(', ')}]`);
    lines.push(String(sm.excerpt).split('\n').map((l) => `        | ${l}`).join('\n'));
  }
  if (!s.declaredSamples.length) lines.push('    (none)');
  lines.push('', '  largest LOOSE prose runs from structured messages:');
  for (const sm of s.samples.slice(0, 5)) {
    lines.push(`    - ${sm.chars} chars, ${sm.position}, [${sm.tags.join(', ')}]`);
    lines.push(String(sm.excerpt).split('\n').map((l) => `        | ${l}`).join('\n'));
  }
  if (!s.samples.length) lines.push('    (none)');
  return lines.join('\n');
}

/* ── CLI ────────────────────────────────────────────────────────────────────── */

const invokedDirectly = (() => {
  try { return path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname); }
  catch { return false; }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : metricsPath();
  const s = summariseMetrics(file);
  process.stdout.write(args.includes('--json') ? JSON.stringify(s, null, 2) + '\n' : formatReport(s) + '\n');
}
