/**
 * verdict-contract.mjs — FEAT-061: the EXECUTED-EVIDENCE contract for an
 * independent verification verdict, and its mechanical validator.
 *
 * Why this exists: the agent that writes a fix also writes the fixture, runs
 * it, and reports PASS — so a blind spot that SHAPED the fixture (the classic:
 * one page of test data, so the cursor bug never shows) survives every check we
 * have, including the non-vacuity rule. The countermeasure is a verifier that
 * (a) never saw the fixer's prose and (b) is FORCED to execute something the
 * fixer's fixture does not cover.
 *
 * "Forced" has to be mechanical. A polite instruction to run things produces
 * confident armchair review; so a verdict is INVALID — not a pass, not a fail —
 * unless it literally contains:
 *   1. the FIXER's own test run, with the real command and real output;
 *   2. at least ONE ADVERSARIAL case the fixer's fixture does NOT cover
 *      (boundary / empty / second-page / concurrency / failure-injection),
 *      with its own command (≠ the fixer's) and real output;
 *   3. an explicit UNTESTED statement — what it could not test, and why.
 * A static-only review cannot produce those blocks, so it is rejected by
 * `validateVerdict()` without anyone exercising judgment about it.
 *
 * Shape deliberately mirrors gatekeeper.mjs (VERDICT:/FINDING: + `=== X ===`
 * section banners) so both reviewers speak one dialect.
 *
 * RE-SCOPE (2026-08-11, after the closing clean-room verdict — anthropic/sonnet
 * run 91f78b9b — proved "reject non-execution excuses in ANY wording" is not
 * implementable as a finite regex; every widening is a new closed vocabulary
 * and the verifier broke each one on its first hand-crafted attempt): the
 * load-bearing check is no longer prose parsing. It is ARTIFACT EXISTENCE:
 * the clean room hands the verifier a run recorder (`vrun.mjs`) that executes
 * each command and appends {id, command, exit, output sha256, timestamp} to a
 * manifest OUTSIDE the working copy; `validateVerdict` — when given that
 * manifest — accepts a FIXER-TEST/ADVERSARIAL section ONLY if it cites a
 * recorded run whose id exists and whose exit/command/hash agree. No manifest
 * entry ⇒ the section is UNTESTED, regardless of wording — "Nothing happened;
 * the harness gave up before starting anything." validates nothing because no
 * words validate anything. The prose regexes below (TEMPLATE_RE / INABILITY_RE
 * / NARRATION_RE) remain as a SPECIMEN RATCHET — every real bypass phrasing a
 * clean-room run ever produced stays rejected permanently, and they are the
 * only line of defence in prose-only mode (no manifest supplied) — but they
 * are no longer what the verdict stands on.
 */

export const VERDICT_CONTRACT = `RESPONSE CONTRACT — your answer MUST be EXACTLY this shape, nothing before the
VERDICT line. An answer missing any block below is discarded as INVALID (it is
not counted as a pass and not counted as a fail — it simply does not count), so
do not answer until you have actually RUN the commands and can paste their real
output.

VERDICT: HOLDS
(or)
VERDICT: BROKEN
CLAIM: <the requirement you tested, restated in your own words, on this ONE line>

=== FIXER-TEST ===
RAN: <the exact command you ran for the existing test — one of the commands given to you as "how to run things">
EXIT: <its exit code>
MANIFEST: <if a run recorder (vrun.mjs) was provided: the MANIFEST line it printed for THIS run, copied verbatim without the "MANIFEST:" prefix>
OUTPUT:
<its real output, verbatim — never summarised, never invented>

=== ADVERSARIAL: <boundary|empty|second-page|concurrency|failure-injection|other> ===
WHY-UNCOVERED: <one line: what the existing test does NOT exercise, which this does>
RAN: <the exact command you ran — it MUST NOT be the fixer's test command again>
EXIT: <its exit code>
MANIFEST: <the run recorder's MANIFEST line for THIS run — each section cites its OWN recorded run>
OUTPUT:
<its real output, verbatim>

=== UNTESTED ===
<what you could NOT test and why — be concrete; "nothing" is not an accepted answer>

FINDING: <one line per concrete defect: what breaks, on what input, where>
(FINDING lines are REQUIRED when the verdict is BROKEN; omit them when it HOLDS.)

Rules: VERDICT: HOLDS means "I attempted to break it and failed", never "it looks
right". Only report output you actually observed. If you cannot run anything at
all, say so in UNTESTED and answer VERDICT: BROKEN — an unverifiable change is
not a verified one. If you find a defect, report it as VERDICT: BROKEN in this
same shape with FINDING lines — a prose essay, however correct, does not count.
If a run recorder was provided, evidence is only counted when the section cites
the recorder's MANIFEST line — the harness checks your citations against its own
records after you answer, so output from runs made any other way, or from runs
that did not happen, does not count no matter how it is worded. The harness also
keeps the FULL raw output of every recorded run and compares your OUTPUT block
against it line by line: every line you paste must be a COMPLETE line of the
cited run's recorded output, in the artifact's own order — never a fragment,
never rearranged. Excerpting is fine, but elide ONLY with a line that is a
bare ellipsis — "..." or "[...]" and nothing more. Every other line, including
summaries like "120 lines omitted" or "all checks pass", counts as content: if
the recorded output does not contain it verbatim the whole verdict is INVALID,
and wrapping it in brackets or parentheses does NOT exempt it. This applies to
EVERY line of a FIXER-TEST/ADVERSARIAL section apart from its RAN/EXIT/
MANIFEST/WHY-UNCOVERED fields — leaving out the OUTPUT: label does not exempt
the text either. Do not paraphrase, annotate or summarise inside an evidence
section: the recorded artifact itself is the evidence, never your
transcription of it. Your answer must contain NO text outside the labelled
slots above — no introduction before the VERDICT line, no commentary between
CLAIM and the first === section, no epilogue: unlabelled text is rejected.`;

// ANY `=== ... ===`-shaped line is a section boundary, whatever its case or
// content — the fourteenth closing clean-room verdict (anthropic/sonnet run
// 7a54619d) proved the uppercase-only version was a bypass: a lowercase
// `=== fixer-test: ... ===` block was never recognised as a section, so its
// fabricated evidence hid inside UNTESTED's body, invisible to the duplicate/
// unrecognised/binding checks. Parse first, judge after: unknown banners are
// then rejected by the closed-set rule instead of silently absorbed.
const SECTION_RE = /^===\s*([^=:]+?)(?::\s*([^=]*?))?\s*===\s*$/;

/**
 * Whole-line template/omission tokens: the contract's own angle-bracket
 * placeholders left in place, bracketed excuses, "(omitted)"-style waves.
 */
const TEMPLATE_RE = new RegExp(
  '^(?:' +
  '<[^>]*>' +                                   // <its real output, verbatim>
  '|\\[[^\\]]*\\]' +                            // [Command could not be run …]
  '|\\(?\\s*(?:output\\s+)?(?:omitted|elided|not\\s+run|not\\s+executed|n/?a|none|nothing|nil|todo|same as above|as above|see above|would\\s+print)\\s*\\)?[.]?' +
  ')$',
  'i',
);

/**
 * An assertion of inability-to-run, in ANY wording — not an exact-phrase
 * blacklist but a phrase FAMILY (inability/prevention verb bound to an
 * execution noun in the same clause). The first real clean-room run of the
 * verifier on FEAT-061's own commit proved the exact-phrase version was a
 * bypass: rewording the excuse to "execution was prevented" sailed past
 * "could not run" and a fabricated verdict validated. The requirement is
 * EXECUTED evidence, so any line that narrates non-execution is not evidence,
 * whatever words it picks.
 *
 * Deliberately NOT applied to `=== UNTESTED ===` (see below) — inability
 * statements are that section's REQUIRED content.
 */
const INABILITY_RE = new RegExp(
  // "execution/invocation/launching/the command/tests was prevented|blocked|
  //  prohibited|not permitted|not launched|…"  (the closing clean-room run
  //  contributed "Launching was prohibited" and "Policy blocked invocation" —
  //  the execution-noun family must cover invocation/launch/spawn/start too)
  '(?:\\b(?:execution|invocations?|invoking|launch(?:ing|es)?|spawn(?:ing)?|start(?:ing|up)?|run(?:ning)?|runs?|commands?|tests?|scripts?|bash|shell|subprocess(?:es)?)\\b[^\\n]{0,60}?\\b(?:was|were|is|are|has\\s+been|have\\s+been|got)\\s+(?:prevented|blocked|denied|refused|disallowed|forbidden|prohibited|stopped|impossible|unavailable|disabled|not\\s+(?:possible|permitted|allowed|available|run|executed|launched|invoked|spawned|started))\\b)' +
  // "prevented (the) execution / blocked invocation / prohibited launching" —
  // requires a real word gap, so a hyphenated label like "blocked-execution"
  // does not trip it
  '|(?:\\b(?:prevented|blocked|denied|refused|disallowed|forbade|prohibited|stopped)\\b\\s+(?:\\w+\\s+){0,4}?(?:execution|running|executing|invocation|invoking|launch(?:ing)?|spawning|start(?:ing)?|from\\s+(?:running|executing|launching|starting))\\b)' +
  // "could not / cannot / unable / no way / not possible … run|execute|collect|capture"
  '|(?:\\b(?:could\\s*not|couldn[\'’]t|cannot|can[\'’]t|unable|not\\s+able|no\\s+way|n[\'’]t\\s+possible|not\\s+possible|impossible)\\b[^\\n]{0,60}?\\b(?:run|running|rerun|execute[d]?|executing|execution|spawn\\w*|launch\\w*|invoke\\w*|start(?:ed)?|collect(?:ed)?|captured?)\\b)' +
  // "did not / never / neither … (actually) run|execute|launch|invoke"
  '|(?:\\b(?:did\\s+not|didn[\'’]t|never|neither\\s+\\w+\\s+was)\\s+(?:actually\\s+)?(?:run|execute[d]?|launch(?:ed)?|invoke[d]?|spawn(?:ed)?|start(?:ed)?)\\b)' +
  // "no output/results were available|captured|…|exist to include|to paste"
  '|(?:\\bno\\s+(?:test\\s+)?(?:output|results?)\\b[^\\n]{0,40}?\\b(?:available|captured|produced|collected|exists?|paste|include|report|show)\\b)' +
  // approval/permission/policy excuses and the non-interactive-session excuse
  '|(?:\\brequires?\\s+(?:approval|permission)\\b)' +
  '|(?:\\bnon-interactive\\s+(?:mode|session)\\b)',
  'i',
);

/**
 * The closing clean-room run (anthropic/sonnet, session
 * c3f0b046-bc49-4c49-a20d-090833e299bb) proved INABILITY_RE is still a CLOSED
 * vocabulary: "I was not permitted to execute …" and "my role … does not
 * extend to trying commands" both validated. Chasing phrasings is an arms
 * race, so this rule is structural instead: captured command output does not
 * NARRATE. A line inside an OUTPUT block that (a) speaks in the first person
 * ("I", "my", "we") about anything execution-shaped, or (b) combines ANY
 * denial/absence/permission word with ANY execution-family word in the same
 * line, is meta-narration about running, not output OF a run. Deliberately
 * over-broad: excuse lines never COUNT (they are discarded, not fatal), and
 * genuine multi-line output survives incidental matches because its other
 * lines carry the evidence minimum. The residual — fabricated output that
 * avoids both first person and every denial word — is no longer an excuse at
 * all but invented program output, which no text validator can detect; that
 * limit is recorded in FEAT-061 as residual risk.
 */
const EXEC_WORDS =
  'execut\\w*|unexecuted|run(?:s|ning)?|ran|rerun|command\\w*|test\\w*|suite\\w*' +
  '|script\\w*|launch\\w*|invok\\w*|invocation\\w*|spawn\\w*|start(?:ed|ing)?' +
  '|bash|shell|subprocess\\w*|results?|outputs?|evidence';
const DENIAL_WORDS =
  'not?|none|never|without|absent|absence|unable|cannot|can[\'’]t|couldn[\'’]t' +
  '|denied|den(?:y|ies)|withheld|withhold\\w*|refus\\w*|block\\w*|prevent\\w*' +
  '|prohibit\\w*|forbid\\w*|forbade|disallow\\w*|unexecuted|unrun|untried' +
  '|unavailable|missing|lack\\w*|impossible|stayed|remained|policy|policies' +
  '|permission\\w*|permitted|approval|rights|sandbox\\w*|restrict\\w*|confin\\w*';
// The co-occurrence gap must contain whitespace: prose narration separates its
// words ("blocked execution", "not permitted to execute"), while a hyphenated
// LABEL quoted inside genuine output ("blocked-execution", the suite's own
// adversarial-case tag) joins them — same hazard INABILITY_RE documents.
const NARRATION_RE = new RegExp(
  `(?:\\b(?:I|my|we|our|me)\\b[^\\n]{0,79}?\\s(?:${EXEC_WORDS})\\b)` +
  `|(?:\\b(?:${DENIAL_WORDS})\\b[^\\n]{0,79}?\\s(?:${EXEC_WORDS})\\b)` +
  `|(?:\\b(?:${EXEC_WORDS})\\b[^\\n]{0,79}?\\s(?:${DENIAL_WORDS})\\b)`,
  'i',
);

/** Whole-line filler that says nothing: used for UNTESTED, where inability
 * wording is legitimate but "nothing"/"n/a"/a leftover template token is not. */
const FILLER_RE = /^(?:<[^>]*>|\(?\s*(?:n\/?a|none|nothing|nil|todo)\s*\)?[.!]?|[-–—*]+)$/i;

/** A real run reports a real exit code. "Unable to execute" does not parse. */
const EXIT_RE = /^-?\d{1,3}$/;

/** Split a verdict body into { banner, label, body } sections in order. */
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = { banner: null, label: null, lines: [] };
  for (const line of lines) {
    const m = SECTION_RE.exec(line.trim());
    if (m) {
      out.push(cur);
      cur = { banner: m[1].trim().toUpperCase(), label: (m[2] ?? '').trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out.map((s) => ({ ...s, body: s.lines.join('\n') }));
}

function field(body, name) {
  const m = new RegExp(`^\\s*${name}:\\s*(.*)$`, 'mi').exec(body);
  return m ? m[1].trim() : null;
}

/**
 * The OUTPUT: block of a section = any text inline on the OUTPUT: line itself
 * PLUS everything after it. The fifth closing clean-room verdict (anthropic/
 * sonnet run b7be44fd) proved the old inline fallback — which captured ONLY the
 * header line's trailing text — silently dropped every subsequent line, so
 * `OUTPUT: PASS` followed by invented narrative smuggled unlimited fabricated
 * evidence past binding. Every line after the header is part of the block.
 */
function outputBlock(body) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => /^\s*OUTPUT:/i.test(l));
  if (i === -1) return null;
  const inline = lines[i].replace(/^\s*OUTPUT:\s*/i, '');
  const rest = lines.slice(i + 1);
  return (inline ? [inline, ...rest] : rest).join('\n');
}

/**
 * Positive-shape check for an OUTPUT block: after discarding template tokens
 * and inability-in-any-wording lines, is there still ≥ minChars of actual
 * observed output? Excuse lines never COUNT as evidence (the old rule only
 * rejected when EVERY line was a recognised excuse, so one reworded excuse
 * line ≥ 20 chars passed — the "execution was prevented" bypass).
 *
 * Returns { ok, why: 'missing'|'empty'|'inability'|'thin', excuse } so the
 * violation message can name what it saw.
 */
function executedOutput(block, minChars) {
  if (block == null) return { ok: false, why: 'missing', excuse: null };
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, why: 'empty', excuse: null };
  const isExcuse = (l) => TEMPLATE_RE.test(l) || INABILITY_RE.test(l) || NARRATION_RE.test(l);
  const excuses = lines.filter(isExcuse);
  const evidence = lines.filter((l) => !isExcuse(l));
  if (evidence.join('\n').length < minChars) {
    return {
      ok: false,
      why: excuses.length ? 'inability' : 'thin',
      excuse: excuses[0] ?? null,
    };
  }
  return { ok: true, why: null, excuse: null };
}

function outputViolation(where, r) {
  if (r.why === 'inability') {
    return `${where} \`OUTPUT:\` asserts the command was not executed (“${(r.excuse ?? '').slice(0, 80)}”) — an inability statement in ANY wording is not executed output; a verdict claiming execution it did not perform is rejected`;
  }
  return `${where} has no real \`OUTPUT:\` block (a verdict with no executed output is a STATIC review — rejected)`;
}

/**
 * UNTESTED gets a DIFFERENT bar than OUTPUT, on purpose. A real clean-room
 * verdict was falsely ruled INVALID here because its honest one-paragraph
 * UNTESTED ("…could not run because spawning `git` … failed with EPERM")
 * matched the old inability blacklist and the whole paragraph was discarded
 * as "placeholder". Inability statements are that section's REQUIRED content;
 * only genuine filler ("nothing", "n/a", a leftover template token) fails it.
 */
function honestProse(block, minChars) {
  if (block == null) return false;
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.filter((l) => !FILLER_RE.test(l)).join('\n').length >= minChars;
}

const normCmd = (c) => (c ?? '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');

/**
 * BUG-066. Command IDENTITY, robust to the RECORDER's own normalization.
 *
 * The harness supplies fixer-test commands verbatim, and a command may carry an
 * environment-assignment prefix (`FOO=1 node t.mjs`). The recording layer writes
 * that back as an explicit `env FOO=1 node t.mjs` — so a raw string match brands
 * a verifier that ran EXACTLY the supplied command as having run "a stand-in",
 * burning a whole clean-room verification. The prefix is introduced by the
 * recorder, not the model, so no amount of verifier compliance can avoid it.
 *
 * The comparison therefore canonicalizes BOTH sides into
 * `{ assignments (a SET), rest }`: leading `env` tokens are dropped and leading
 * `NAME=value` tokens collected and sorted. Assignments stay part of the
 * identity — `FOO=1 x` and `FOO=2 x` are DIFFERENT commands — so this is
 * identity-preserving normalization, not a forgery hole: a different program or a
 * different assignment value still fail to match. (DISTINCTNESS is the opposite
 * question and does NOT go through here — see `sameProgram` below: an adversarial
 * case wearing an unused env prefix over the fixer's byte-identical command is the
 * SAME command there, hole #19.) `env` with option flags (`env -i`, `env -u
 * X`) is left alone conservatively: nothing after a flag is treated as a prefix.
 */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
function canonCmd(c) {
  const s = normCmd(c);
  if (!s) return s;
  const toks = s.split(' ');
  const assigns = [];
  let i = 0;
  while (i < toks.length) {
    if (toks[i] === 'env') { i += 1; continue; }
    if (ENV_ASSIGN_RE.test(toks[i])) { assigns.push(toks[i]); i += 1; continue; }
    break;
  }
  const rest = toks.slice(i).join(' ');
  if (!rest) return s; // nothing but a prefix — compare literally rather than to ''
  return [...assigns].sort().concat(rest).join(' ');
}
const sameCmd = (a, b) => canonCmd(a) === canonCmd(b);

/**
 * hole #19 (closing run 1ab8fc96). Command identity is ASYMMETRIC by design.
 *
 * `sameCmd`/`canonCmd` above are for CITATION matching (cited RAN vs the recorded
 * run, cited fixer vs the harness-supplied command): there, assignments PARTICIPATE
 * in identity, because a compliant verifier's `env`-normalized prefix must still be
 * recognized as THE supplied command, while a different assignment VALUE runs a
 * different test (BUG-066 and its negatives). That path is unchanged.
 *
 * DISTINCTNESS — "does the adversarial run merely re-run the fixer's command?" —
 * is the opposite question and must strip ALL leading env assignments (and `env`
 * tokens) from BOTH sides first. Two commands whose underlying program+args are
 * identical are the SAME command regardless of assignment sets: an env var CAN
 * change behavior, but the contract cannot verify that it DID, so it must not grant
 * distinctness credit for it. Otherwise `UNUSED_ENV_VAR=1 <cmd>` reads as DISTINCT
 * from a byte-identical `<cmd>` and a verifier satisfies "distinct adversarial run"
 * with zero additional testing. A verifier wanting an env-dependent adversarial case
 * must vary the program/args the harness can SEE (e.g. a wrapper invocation).
 */
function bareCmd(c) {
  const s = normCmd(c);
  if (!s) return s;
  const toks = s.split(' ');
  let i = 0;
  while (i < toks.length) {
    if (toks[i] === 'env') { i += 1; continue; }
    if (ENV_ASSIGN_RE.test(toks[i])) { i += 1; continue; }
    break;
  }
  const rest = toks.slice(i).join(' ');
  return rest || s; // all-prefix: compare literally (mirrors canonCmd)
}
const sameProgram = (a, b) => bareCmd(a) === bareCmd(b);

/* ------------------------------------------------- the RUN MANIFEST (2026-08-11) */

/**
 * Parse a run manifest (JSONL written by the clean room's `vrun.mjs`, one
 * {id, cmd, exit, sha256, bytes, ts} object per line). Malformed lines are
 * dropped, never fatal — a corrupt manifest simply backs fewer sections.
 */
export function parseManifest(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.id === 'string' && typeof e?.cmd === 'string' && Number.isInteger(e?.exit) && typeof e?.sha256 === 'string') {
        // `output` (the preserved <id>.out content) is optional here — the
        // HARNESS attaches it when the artifact file exists. When present it
        // arms OUTPUT-BINDING (see bindOutput); when absent, only the metadata
        // (id/exit/cmd/hash) is checkable — the documented 5288429d hole.
        out.push(e);
      }
    } catch { /* dropped */ }
  }
  return out;
}

/** A `MANIFEST:` citation: `<id> sha256=<hash> exit=<n>` (the vrun line, prefix stripped). */
const MANIFEST_REF_RE = /([A-Fa-f0-9]{8,64})\b(?:.*?\bsha256=([A-Fa-f0-9]{8,64}))?/;

/**
 * OUTPUT-BINDING (2026-08-11, the 5288429d fix): when the cited manifest entry
 * carries its recorded raw output (`entry.output` — the harness attaches the
 * preserved `<id>.out` whenever the artifact exists), the verdict's pasted
 * OUTPUT block is bound to THAT entry's artifact, per entry — which also kills
 * the sibling dodge (cite run A's exit, quote run B's output), because the
 * comparison target is always the artifact of the run this section cites.
 *
 * The rule, stated so truncation is handled and documented:
 *  - every non-empty pasted line must BE a complete recorded line of the
 *    cited run's artifact (whitespace-normalised equality, per line, never
 *    substrings or splices), in the artifact's own order — see bindOutput;
 *    anything else is fabricated evidence ⇒ INVALID;
 *  - a verbatim EXCERPT is therefore fine — elide freely, but ONLY with a
 *    pure-ellipsis marker (`...` / `[...]`, see isElision). Three closing
 *    clean-room verdicts each broke a richer marker rule in turn: ded40513
 *    (any ()/[]-enclosed line was weightless → wrap the fabricated sentence
 *    in parens), b99ee4de (digits stripped as marker lexemes → fabricate
 *    tallies as bare digit lines), 9c60bf20 (ellipsis gate + digit strip →
 *    "47..."). Elision is the ABSENCE of content; any line with content is a
 *    claim, and claims must bind;
 *  - the pasted prose carries no evidentiary weight at all: the recorded
 *    artifact IS the evidence, so the prose-minimum/narration checks
 *    (executedOutput) are superseded for a bound section — an empty or
 *    marker-only paste with a good citation is acceptable, because the
 *    harness holds the real output either way.
 */
// An elision marker is ONLY a pure ellipsis, optionally bracketed: `...`,
// `…`, `[...]`, `(...)`. Nothing else — no digits, no words, no "N lines
// omitted" vocabulary. Two closing clean-room runs proved that ANY richer
// marker language is a laundering channel: run b99ee4de fabricated tallies as
// bare digit lines (`\d+` stripped unconditionally), and run 9c60bf20 laundered
// them again as "47..." (ellipsis gate + digit strip). A number is content — a
// tally, an id, a count — and so is every word; if the verifier wants them in
// evidence they must come from the artifact. Elision is the absence of
// content, so the marker shape permits none.
function isElision(t) {
  return /^[\[(]?\s*(?:\.{2,}|…)\s*[\])]?$/.test(t);
}
/**
 * In bound mode the comparison target is the WHOLE evidence-section body, not
 * just what follows an `OUTPUT:` header. The seventh closing clean-room
 * verdict (anthropic/sonnet run b07ef2aa) proved header-scoped binding was the
 * bypass: omit the `OUTPUT:` label and paste the invented narrative straight
 * after `MANIFEST:`, and outputBlock() returned null — "nothing to check".
 * So: structure fields (RAN/EXIT/MANIFEST/WHY-UNCOVERED, and the OUTPUT header
 * itself) are structure; every other line in an evidence section is claimed
 * output and must bind to the artifact.
 */
const STRUCTURE_FIELD_RE = /^\s*(RAN|EXIT|MANIFEST|WHY-UNCOVERED):/i;
function sectionContent(body) {
  // Each structure field is structure ONCE — its first occurrence, the same
  // occurrence `field()` reads. The ninth closing clean-room verdict
  // (anthropic/sonnet run a758c4d9) proved the strip-anywhere version was the
  // bypass: fabricated narrative pasted inside the OUTPUT block and DISGUISED
  // with a structure prefix (`EXIT: FATAL crash …`) was silently excluded from
  // binding. A second `RAN:`/`EXIT:`/`MANIFEST:`/`WHY-UNCOVERED:`/`OUTPUT:`
  // line is content like any other, and content must bind to the artifact.
  const seen = new Set();
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const f = STRUCTURE_FIELD_RE.exec(line);
    if (f) {
      const name = f[1].toUpperCase();
      if (!seen.has(name)) { seen.add(name); continue; }
      out.push(line);
      continue;
    }
    const m = /^\s*OUTPUT:\s*(.*)$/i.exec(line);
    if (m && !seen.has('OUTPUT')) { seen.add('OUTPUT'); out.push(m[1]); continue; }
    out.push(line);
  }
  return out.join('\n');
}

function bindOutput({ where, block, entry, violations }) {
  // Matching is WHOLE-LINE and IN-ORDER, by construction:
  //  - whole lines: the eighth closing verdict (anthropic/sonnet run c04d673d)
  //    proved substring matching lets a fabricator chop a false claim into
  //    fragments that each occur SOMEWHERE in the artifact ("Test 2:" from one
  //    line, "PASS" from another) and reassemble them into a claim the run
  //    never printed. A pasted line must BE a recorded line (whitespace-
  //    normalised equality), never merely occur inside one;
  //  - per-line, never across lines: the second closing verdict (run 582597b5)
  //    proved a flattened-artifact fallback lets the tail of one real line be
  //    spliced onto the head of another;
  //  - in order: an excerpt is the artifact with lines REMOVED, so the pasted
  //    lines must appear as an in-order subsequence of the recorded lines —
  //    reordering real lines is also an editorial claim the run never made.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const recorded = entry.output.split('\n').map(norm);
  let cursor = 0;
  for (const line of (block ?? '').split('\n')) {
    const t = line.trim();
    if (!t || isElision(t)) continue;
    const tn = norm(t);
    const idx = recorded.indexOf(tn, cursor);
    if (idx !== -1) { cursor = idx + 1; continue; }
    if (recorded.indexOf(tn) !== -1) {
      violations.push(`${where} \`OUTPUT:\` line “${t.slice(0, 80)}” is a recorded line of manifest run ${entry.id} but OUT OF ORDER — an excerpt is the artifact with lines removed, never rearranged`);
      continue;
    }
    violations.push(`${where} \`OUTPUT:\` line “${t.slice(0, 80)}” does not appear in the recorded output of manifest run ${entry.id} — a pasted line must BE a complete recorded line; fragments, splices and invented text are fabricated evidence, however plausible they read`);
  }
}

/**
 * ARTIFACT-EXISTENCE check for one evidence section, against the manifest the
 * harness itself recorded. This is the load-bearing rule: prose cannot satisfy
 * it and prose cannot bypass it, because it never reads the prose — only the
 * citation, and only against records the verifier did not write.
 * Returns the cited entry when one was found (so the caller can arm
 * OUTPUT-BINDING against it), else null.
 */
function manifestCheck({ where, body, cmd, exitStr, entries, usedIds, violations }) {
  const ref = field(body, 'MANIFEST');
  if (!ref) {
    violations.push(`${where} has no \`MANIFEST:\` reference — the run manifest is active, and a section with no recorded run is UNTESTED regardless of how its prose reads`);
    return null;
  }
  const m = MANIFEST_REF_RE.exec(ref);
  if (!m) {
    violations.push(`${where} \`MANIFEST:\` does not name a recorded run id (got: ${ref.slice(0, 60)})`);
    return null;
  }
  const id = m[1].toLowerCase();
  const entry = entries.find((e) => e.id.toLowerCase() === id);
  if (!entry) {
    violations.push(`${where} cites manifest run ${id} which the harness never recorded — a reference to a run that did not happen is forged evidence`);
    return null;
  }
  if (m[2] && entry.sha256.toLowerCase() !== m[2].toLowerCase()) {
    violations.push(`${where} manifest run ${entry.id}: cited output hash ${m[2]} does not match the recorded ${entry.sha256} — the cited evidence is not the recorded run`);
  }
  if (exitStr != null && EXIT_RE.test(exitStr) && Number(exitStr) !== entry.exit) {
    violations.push(`${where} \`EXIT: ${exitStr}\` does not match manifest run ${entry.id} (recorded exit ${entry.exit})`);
  }
  if (cmd && !sameCmd(cmd, entry.cmd)) {
    violations.push(`${where} \`RAN:\` (${normCmd(cmd).slice(0, 80)}) is not the command manifest run ${entry.id} recorded (${normCmd(entry.cmd).slice(0, 80)})`);
  }
  if (usedIds.has(entry.id)) {
    violations.push(`${where} re-cites manifest run ${entry.id} already used by another section — each section needs its OWN recorded run`);
  }
  usedIds.add(entry.id);
  return entry;
}

/**
 * Mechanically validate a verifier's answer against the executed-evidence
 * contract. Judgment-free: every rule is presence/shape, never quality.
 *
 * Two modes, deliberately distinct:
 *  - ARTIFACT mode (`opts.manifest` is an array — possibly empty — of runs the
 *    harness itself recorded): the load-bearing check. Every evidence section
 *    must cite a recorded run whose id/exit/command/hash agree. This is what
 *    the live clean-room path always uses.
 *  - PROSE-ONLY mode (`opts.manifest` undefined): the pre-rescope behavior —
 *    specimen-ratchet regexes only. Kept for `--check-only` on bare verdict
 *    files and as the honest record of what prose parsing can and cannot do.
 *
 * @returns {{ valid: boolean, verdict: 'HOLDS'|'BROKEN'|null, findings: string[],
 *             violations: string[], adversarial: string[], manifestChecked: boolean }}
 */
export function validateVerdict(text, opts = {}) {
  const violations = [];
  const raw = String(text ?? '');
  const manifest = Array.isArray(opts.manifest) ? opts.manifest : null;
  const usedIds = new Set();

  const verdictLines = raw.split('\n').filter((l) => /^\s*VERDICT:/i.test(l));
  let verdict = null;
  if (verdictLines.length === 0) {
    violations.push('no `VERDICT:` line (static prose is not a verdict)');
  } else if (verdictLines.length > 1) {
    violations.push(`${verdictLines.length} \`VERDICT:\` lines — exactly one is allowed`);
  } else {
    const m = /^\s*VERDICT:\s*(HOLDS|BROKEN)\s*$/i.exec(verdictLines[0]);
    if (!m) violations.push(`\`VERDICT:\` must be HOLDS or BROKEN (got: ${verdictLines[0].trim().slice(0, 60)})`);
    else verdict = m[1].toUpperCase();
  }

  const secs = sections(raw);
  const claim = field(secs[0]?.body ?? raw, 'CLAIM');
  if (!claim || claim.length < 20) violations.push('missing/too-short `CLAIM:` line (restate the requirement you tested)');

  // No UNLABELLED text. The tenth closing clean-room verdict (anthropic/sonnet
  // run 15aad64e) proved the preamble — everything before the first section
  // banner — was an unchecked region: a fully invented crash narrative there
  // rode on legitimate sections. The principled boundary: labelled slots are
  // speech acts (CLAIM/WHY-UNCOVERED/UNTESTED/FINDING are the verifier's
  // words; OUTPUT is the machine's words, bound to the artifact); UNLABELLED
  // text is neither, so in artifact mode it may not exist. CLAIM is a SINGLE
  // line — the thirteenth closing verdict (anthropic/sonnet run c9a49cab)
  // proved a continuation allowance is a smuggling channel: any line placed
  // directly under CLAIM: was exempt from every check.
  if (manifest) {
    // Only the FIRST CLAIM: line is the CLAIM slot — the fifteenth closing
    // verdict (anthropic/sonnet run 0322f40e) proved the prefix exemption
    // applied to EVERY such line, so a second `CLAIM:` line carried fabricated
    // narrative unchecked. (A second VERDICT: line is already fatal via the
    // exactly-one count above.)
    const stray = [];
    let claimSeen = false;
    for (const line of (secs[0]?.lines ?? [])) {
      const t = line.trim();
      if (!t) continue;
      if (/^\s*VERDICT:/i.test(line)) continue;
      if (/^\s*CLAIM:/i.test(line) && !claimSeen) { claimSeen = true; continue; }
      stray.push(t);
    }
    if (stray.length) {
      violations.push(`${stray.length} unlabelled line(s) outside every section (first: “${stray[0].slice(0, 80)}”) — with the run recorder active, narrative may exist only in the contract's labelled slots; unlabelled text can masquerade as evidence and is rejected`);
    }
  }

  // Sections are a CLOSED set, and the singular ones are singular. The sixth
  // closing clean-room verdict (anthropic/sonnet run a4d1a342) proved the
  // find-first lookup was a smuggling channel: a verdict carried one
  // legitimate, manifest-bound FIXER-TEST and appended a SECOND one full of
  // fabricated, uncited output that nothing ever checked. Any duplicate
  // singular section, and any banner the contract does not define, is
  // rejected — an unchecked container cannot be allowed to look like evidence.
  const KNOWN_BANNERS = new Set(['FIXER-TEST', 'ADVERSARIAL', 'UNTESTED']);
  for (const s of secs) {
    if (s.banner && !KNOWN_BANNERS.has(s.banner)) {
      violations.push(`unrecognised section \`=== ${s.banner} ===\` — the contract defines only FIXER-TEST / ADVERSARIAL / UNTESTED, and a section the validator does not check cannot be allowed to carry evidence-shaped text`);
    }
  }
  for (const banner of ['FIXER-TEST', 'UNTESTED']) {
    const n = secs.filter((s) => s.banner === banner).length;
    if (n > 1) violations.push(`${n} \`=== ${banner} ===\` sections — exactly one is allowed; a duplicate is an unchecked container for fabricated evidence`);
  }
  // Banner LABELS are identifiers, not prose. The twelfth closing clean-room
  // verdict (anthropic/sonnet run 0ab9b4db) proved the free-text label field
  // (`=== ADVERSARIAL: <label> ===`, SECTION_RE's unbounded capture) was the
  // one remaining unchecked region: a fabricated crash narrative rode inside
  // the banner line itself. With the recorder active a label must be a short
  // case tag, and the singular banners take no label at all.
  if (manifest) {
    for (const s of secs) {
      if (!s.banner) continue;
      if (s.banner === 'ADVERSARIAL') {
        if (s.label && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s.label)) {
          violations.push(`adversarial case label “${s.label.slice(0, 60)}” is not a short case tag — with the recorder active, labels are identifiers (letters/digits/hyphen/underscore, max 40 chars); narrative in a banner is unbound text and is rejected`);
        }
      } else if (s.label) {
        violations.push(`\`=== ${s.banner} ===\` carries label text (“${s.label.slice(0, 60)}”) — this banner takes no label; text there is unbound narrative and is rejected`);
      }
    }
  }

  const fixer = secs.find((s) => s.banner === 'FIXER-TEST');
  let fixerCmd = null;
  if (!fixer) {
    violations.push('missing `=== FIXER-TEST ===` section — the fixer\'s own test must be RE-RUN by you, not taken on trust');
  } else {
    fixerCmd = field(fixer.body, 'RAN');
    if (!fixerCmd) violations.push('`=== FIXER-TEST ===` has no `RAN:` command');
    // When the harness supplied the fixer-test command(s), the FIXER-TEST
    // section must have run exactly one of THEM — a recorder residual (the
    // 3609cf7c analysis) is that a verifier can honestly record a command that
    // merely PRINTS its desired evidence; pinning RAN to the supplied command
    // closes that for this section (the adversarial command is by design
    // novel, so there it stays visible-on-the-face-of-the-verdict instead).
    const known = Array.isArray(opts.knownRuns) ? opts.knownRuns.map(normCmd).filter(Boolean) : null;
    if (known && known.length && fixerCmd && !known.some((k) => sameCmd(k, fixerCmd))) {
      violations.push(`\`=== FIXER-TEST ===\` \`RAN:\` (${normCmd(fixerCmd).slice(0, 80)}) is not the harness-supplied fixer test command — "the fixer's own test" means THE fixer's test, not a stand-in`);
    }
    const ex = field(fixer.body, 'EXIT');
    if (!ex || !EXIT_RE.test(ex)) {
      violations.push(`\`=== FIXER-TEST ===\` has no numeric \`EXIT:\` code (got: ${ex ?? 'nothing'}) — a command that was never run has no exit code`);
    }
    const entry = manifest
      ? manifestCheck({ where: '`=== FIXER-TEST ===`', body: fixer.body, cmd: fixerCmd, exitStr: ex, entries: manifest, usedIds, violations })
      : null;
    if (entry && typeof entry.output === 'string') {
      // OUTPUT-BINDING supersedes the prose checks: the artifact is the
      // evidence — and the whole section body binds, not just the OUTPUT block.
      bindOutput({ where: '`=== FIXER-TEST ===`', block: sectionContent(fixer.body), entry, violations });
    } else {
      const out = executedOutput(outputBlock(fixer.body), 20);
      if (!out.ok) violations.push(outputViolation('`=== FIXER-TEST ===`', out));
    }
  }

  const advs = secs.filter((s) => s.banner === 'ADVERSARIAL');
  if (!advs.length) {
    violations.push('missing `=== ADVERSARIAL: <case> ===` section — a verdict that only re-runs the fixer\'s own fixture inherits the fixer\'s blind spot');
  }
  const adversarial = [];
  for (const a of advs) {
    const label = a.label || '(unlabelled)';
    if (!a.label) violations.push('`=== ADVERSARIAL ===` section has no case label (boundary/empty/second-page/concurrency/failure-injection/other)');
    if (!field(a.body, 'WHY-UNCOVERED')) violations.push(`adversarial case "${label}" has no \`WHY-UNCOVERED:\` line`);
    const cmd = field(a.body, 'RAN');
    if (!cmd) violations.push(`adversarial case "${label}" has no \`RAN:\` command`);
    const aex = field(a.body, 'EXIT');
    if (!aex || !EXIT_RE.test(aex)) {
      violations.push(`adversarial case "${label}" has no numeric \`EXIT:\` code (got: ${aex ?? 'nothing'}) — it was described, not run`);
    }
    if (cmd && fixerCmd && sameProgram(cmd, fixerCmd)) {
      violations.push(`adversarial case "${label}" re-runs the fixer's own command (${normCmd(cmd)}) — that covers exactly what the fixture already covered (leading env assignments cannot make it distinct)`);
    }
    const entry = manifest
      ? manifestCheck({ where: `adversarial case "${label}"`, body: a.body, cmd, exitStr: aex, entries: manifest, usedIds, violations })
      : null;
    if (entry && typeof entry.output === 'string') {
      // Bound per-entry: quoting a DIFFERENT recorded run's output here fails,
      // because the comparison target is the artifact of the run THIS section
      // cites — and the whole section body binds, not just the OUTPUT block.
      bindOutput({ where: `adversarial case "${label}"`, block: sectionContent(a.body), entry, violations });
    } else {
      const aout = executedOutput(outputBlock(a.body), 20);
      if (!aout.ok) {
        violations.push(aout.why === 'inability'
          ? `adversarial case "${label}" \`OUTPUT:\` asserts the command was not executed (“${(aout.excuse ?? '').slice(0, 80)}”) — an inability statement in ANY wording is not executed output`
          : `adversarial case "${label}" has no real \`OUTPUT:\` block (claimed, not executed)`);
      }
    }
    adversarial.push(label);
  }

  const untested = secs.find((s) => s.banner === 'UNTESTED');
  if (!untested) {
    violations.push('missing `=== UNTESTED ===` section — an honest statement of what you could NOT test is mandatory');
  } else {
    // UNTESTED is the LAST section, so its raw body swallows the trailing
    // FINDING: lines — which would let a one-word "nothing" ride on their
    // length. Measure only the section's own prose. (Caught by this feature's
    // own test suite; the first implementation passed "UNTESTED: nothing".)
    // Measured with honestProse, NOT executedOutput: "could not run X because Y"
    // is exactly what this section is for (a real verdict was falsely rejected
    // here when the inability blacklist ate its one-paragraph UNTESTED body).
    const own = untested.body.split('\n').filter((l) => !/^\s*FINDING:/i.test(l)).join('\n');
    if (!honestProse(own, 20)) violations.push('`=== UNTESTED ===` is empty or a placeholder ("nothing"/"n/a" is not an accepted answer)');
  }

  // Findings are the verifier's OWN FINDING slot ONLY. In the closed shape,
  // FINDING lines follow the last section (UNTESTED), so they live in its body.
  // HOLE #18 (clean-room run e4a9d6c9): a whole-document scan (`raw.split`) also
  // swept up FINDING:-shaped lines originating in a cited run's REAL recorded
  // stdout, composed into a FIXER-TEST/ADVERSARIAL OUTPUT block — a fabricated
  // finding smuggled purely via program output, counted and printed as genuine.
  // Composed OUTPUT content must carry zero structural weight anywhere: scope
  // the extraction to the UNTESTED-section body, never the whole document.
  const findings = (untested?.body ?? '').split('\n').filter((l) => /^\s*FINDING:/i.test(l)).map((l) => l.trim());
  if (verdict === 'BROKEN' && !findings.length) {
    violations.push('`VERDICT: BROKEN` with no `FINDING:` line — name the defect');
  }

  return { valid: violations.length === 0, verdict, findings, violations, adversarial, manifestChecked: manifest !== null };
}

/* ============== HARNESS-EMITTED EVIDENCE (2026-08-11 structural pivot) ==== */
/**
 * The 15-verdict closing loop on FEAT-061 ended in a structural conclusion:
 * a text-shaped evidence contract is attacker-controlled input, and parsing it
 * is an unwinnable arms race — each of fifteen consecutive clean-room runs
 * broke the then-current parser on its first attempt. So on the live path the
 * harness no longer accepts verifier-authored evidence text AT ALL. The
 * verifier's whole answer is a CITATION BLOCK: which recorded runs constitute
 * its evidence (by id), a one-line CLAIM, a VERDICT, and its designated speech
 * slots (WHY-UNCOVERED / UNTESTED / FINDING — unbound prose by design, and
 * documented as such). The harness then composes the FIXER-TEST / ADVERSARIAL
 * / OUTPUT sections of the final verdict ITSELF, from its own in-memory
 * records (command, exit, output excerpts it selects itself). Nothing the
 * verifier types can fabricate evidence, because evidence text never passes
 * through it — and nothing it types is ever echoed into the harness's report,
 * so a fabricated "OUTPUT" in the reply cannot even be QUOTED into existence.
 *
 * validateVerdict (above) is kept intact and still runs on the COMPOSED text
 * as a belt-and-suspenders self-check (all fifteen ratchets stay live), and as
 * the engine of `--check-only` on bare verdict files.
 */

export const CITATION_CONTRACT = `RESPONSE CONTRACT — your ENTIRE answer is a CITATION BLOCK, nothing else. You
do NOT paste command output: the harness holds the full recorded output of
every run you made through ./vrun.mjs, and after you answer it composes the
evidence sections of the final verdict ITSELF from its own records. Text you
type cannot become evidence and is never echoed into the report; an answer
containing anything but the labelled lines below is INVALID (not a pass, not a
fail — it simply does not count).

VERDICT: HOLDS
(or)
VERDICT: BROKEN
CLAIM: <the requirement you tested, restated in your own words, on this ONE line>
FIXER-TEST: run <id>
ADVERSARIAL: <case-slug> run <id>
WHY-UNCOVERED: <one line: what the existing test does NOT exercise, which this adversarial run does>
UNTESTED: <what you could NOT test and why — concrete; "nothing" is not accepted>
FINDING: <one line per concrete defect: what breaks, on what input, where>

Rules:
- <id> is the run id the recorder printed (the FIRST token of its MANIFEST:
  line). Cite only runs you made through ./vrun.mjs — the harness validates
  every citation against its own records, so an id it never recorded, a
  re-cited id, or an exit code inconsistent with your verdict makes the answer
  INVALID.
- FIXER-TEST must cite your run of the harness-supplied test command, exactly
  as given under "HOW TO RUN THINGS". An ADVERSARIAL case must cite a run of a
  DIFFERENT command (write your own scratch test and run it through ./vrun.mjs).
- Repeat the ADVERSARIAL + WHY-UNCOVERED pair (in that order) for each extra
  adversarial case. At least one is required. Each cites its OWN recorded run.
- UNTESTED may span several lines; put the UNTESTED: label on EVERY line.
- FINDING lines are REQUIRED when the verdict is BROKEN; omit them when it
  HOLDS. VERDICT: HOLDS means "I attempted to break it and failed" — write your
  adversarial test to exit 0 when the code survives it, because a HOLDS verdict
  citing any run with a non-zero exit is inconsistent and INVALID.
- Every non-empty line of your answer MUST start with one of the labels above.
  No preamble, no headings, no === sections, no output excerpts, no epilogue.`;

const CITE_LINE_RE = /^(VERDICT|CLAIM|FIXER-TEST|ADVERSARIAL|WHY-UNCOVERED|UNTESTED|FINDING):\s*(.*)$/i;
const CITE_ID_RE = /^run\s+([A-Fa-f0-9]{6,64})$/i;
const CITE_ADV_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+run\s+([A-Fa-f0-9]{6,64})$/i;
// LENIENT id extraction (BUG-097): the SUBSTANCE bar is "this line cites a run
// the harness recorded", not "the label around the id is exactly shaped". Pull
// the recorder id out of anywhere on a citation line; the manifest is the
// source of truth that then decides whether that id is real, distinct and
// consistent. Missing id ⇒ still a violation (no evidence); ugly shape ⇒
// normalised, not discarded.
const CITE_ID_ANYWHERE_RE = /\brun\s+([A-Fa-f0-9]{6,64})\b/i;

/**
 * Normalise a free-text adversarial case tag into a valid short slug
 * (`^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`, the shape the composed verdict's banner
 * label must satisfy). BUG-097's real failure was a descriptive 47-char slug
 * ("provider-routing-layer-is-hardcoded-not-derived") that overran the 40-char
 * cap and made the whole ADVERSARIAL line — and its orphaned WHY-UNCOVERED —
 * unparseable, discarding a verdict backed by four recorded runs. The slug is a
 * LABEL, never evidence (the cited run id is the evidence), so it is safe to
 * sanitise rather than reject on.
 */
function slugifyCaseTag(raw, index) {
  let s = String(raw ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')     // non-slug chars → hyphen
    .replace(/^[-_]+/, '')             // must start with a letter/digit
    .slice(0, 40)
    .replace(/[-_]+$/, '');            // no trailing separators after the cut
  if (!/^[a-z0-9]/.test(s)) s = ('case-' + s).replace(/[-_]+$/, '').slice(0, 40);
  if (!s) s = `adversarial-${index + 1}`;
  return s;
}

/**
 * Parse a verifier's citation reply. PARSE LENIENTLY, JUDGE STRICTLY (BUG-097):
 * the SUBSTANCE bar is unchanged and unmoved — a verdict is still INVALID unless
 * it carries (i) a FIXER-TEST run id, (ii) at least one ADVERSARIAL run id with
 * a substantive WHY-UNCOVERED, and (iii) a real UNTESTED statement; the cited
 * ids are then checked against the harness's manifest downstream, which is where
 * "did this run actually happen / is it distinct / is the exit consistent" is
 * decided. What is RELAXED here is only line SHAPE: a run id is pulled from
 * anywhere on its citation line, an over-long or oddly-punctuated case tag is
 * normalised to a valid slug instead of discarding the line, and free prose is
 * ignored (it is never echoed or counted as evidence) rather than being fatal.
 * Cosmetic fix-ups are recorded in `normalized` (surfaced as `format-normalized`
 * by the harness), never as violations — so a dispatch that DID the work is not
 * thrown away over a label.
 */
export function parseCitationReply(text) {
  const violations = [];
  const normalized = [];
  const adversarial = [];
  const untested = [];
  const findings = [];
  let verdict = null, claim = null, fixerId = null;
  let verdicts = 0, fixers = 0, extraClaims = 0, stray = 0;
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = CITE_LINE_RE.exec(t);
    if (!m) {
      // Unlabelled free text. It can never become evidence (the harness composes
      // the verdict from its own records, and never echoes the reply), so it is
      // IGNORED with a note rather than discarding the whole verdict. A reply
      // that is ONLY prose still fails the substance checks below (no VERDICT /
      // no FIXER-TEST / no ADVERSARIAL id), so leniency here opens no hole.
      stray++;
      continue;
    }
    const label = m[1].toUpperCase();
    const rest = m[2].trim();
    if (label === 'VERDICT') {
      verdicts++;
      if (verdicts === 1) {
        if (/^(HOLDS|BROKEN)$/i.test(rest)) verdict = rest.toUpperCase();
        else violations.push('`VERDICT:` must be HOLDS or BROKEN');
      }
    } else if (label === 'CLAIM') {
      // Only the FIRST CLAIM: line is the CLAIM slot (0322f40e lineage) — and
      // extras are rejected outright rather than merely ignored.
      if (claim == null) claim = rest;
      else extraClaims++;
    } else if (label === 'FIXER-TEST') {
      fixers++;
      if (fixers === 1) {
        const idm = CITE_ID_ANYWHERE_RE.exec(rest);
        if (idm) {
          fixerId = idm[1].toLowerCase();
          if (!CITE_ID_RE.test(rest)) normalized.push(`FIXER-TEST line ${i + 1}: extra text around the citation ignored (cited run ${fixerId})`);
        } else {
          violations.push('`FIXER-TEST:` must cite the recorder id of your run of the supplied test command, as `run <id>`');
        }
      }
    } else if (label === 'ADVERSARIAL') {
      const idm = CITE_ID_ANYWHERE_RE.exec(rest);
      if (!idm) {
        violations.push(`\`ADVERSARIAL:\` line ${i + 1} cites no recorded run — it must reference a run you made through ./vrun.mjs as \`run <id>\``);
      } else {
        const id = idm[1].toLowerCase();
        const rawSlug = rest.slice(0, idm.index).trim();
        const slug = slugifyCaseTag(rawSlug, adversarial.length);
        if (!CITE_ADV_RE.test(rest)) normalized.push(`ADVERSARIAL line ${i + 1}: case tag normalised to "${slug}" (the evidence is cited run ${id}, not the label shape)`);
        adversarial.push({ slug, id, why: null });
      }
    } else if (label === 'WHY-UNCOVERED') {
      const open = [...adversarial].reverse().find((a) => a.why == null);
      if (!open) violations.push(`\`WHY-UNCOVERED:\` line ${i + 1} does not follow an \`ADVERSARIAL:\` line that lacks one`);
      else open.why = rest;
    } else if (label === 'UNTESTED') {
      untested.push(rest);
    } else if (label === 'FINDING') {
      findings.push(`FINDING: ${rest}`);
    }
  }
  if (stray) normalized.push(`${stray} unlabelled line(s) ignored — free text is not parsed, not counted and never echoed`);
  if (verdicts === 0) violations.push('no `VERDICT:` line (static prose is not a verdict)');
  if (verdicts > 1) violations.push(`${verdicts} \`VERDICT:\` lines — exactly one is allowed`);
  if (extraClaims) violations.push(`${extraClaims + 1} \`CLAIM:\` lines — CLAIM is a single line and only the first could count; extras are rejected (0322f40e lineage)`);
  if (!claim || claim.length < 20) violations.push('missing/too-short `CLAIM:` line (restate the requirement you tested)');
  if (fixers === 0) violations.push('no `FIXER-TEST: run <id>` citation — the fixer\'s own test must be re-run through the recorder and cited');
  if (fixers > 1) violations.push(`${fixers} \`FIXER-TEST:\` lines — exactly one is allowed`);
  if (!adversarial.length) violations.push('no `ADVERSARIAL: <case-slug> run <id>` citation — a verdict that only re-runs the fixer\'s fixture inherits the fixer\'s blind spot');
  for (const a of adversarial) {
    if (a.why == null || a.why.length < 10) violations.push(`adversarial case "${a.slug}" has no substantive \`WHY-UNCOVERED:\` line`);
  }
  if (!honestProse(untested.join('\n'), 20)) violations.push('missing/empty `UNTESTED:` lines ("nothing"/"n/a" is not an accepted answer)');
  if (verdict === 'BROKEN' && !findings.length) violations.push('`VERDICT: BROKEN` with no `FINDING:` line — name the defect');
  // Specimen-ratchet belt on the few verifier-authored lines that remain:
  // a leftover template/placeholder token is never speech.
  for (const s of [claim ?? '', ...adversarial.map((a) => a.why ?? ''), ...untested, ...findings.map((f) => f.replace(/^FINDING:\s*/, ''))]) {
    if (s && TEMPLATE_RE.test(s)) {
      violations.push('a verifier-authored line is a leftover template/placeholder token — the contract\'s angle-bracket examples are not answers');
      break;
    }
  }
  return { verdict, claim, fixerId, adversarial, untested, findings, violations, normalized };
}

// The ONE closed vocabulary of structure-shaped lines the composed document
// owns — every section banner (SECTION_RE) plus every labelled slot the
// composed verdict or the citation contract uses. It is a SINGLE constant so
// there is no second hand-maintained list to drift: both the masquerade guard
// on the verifier's speech (`quoteSpeech`) and the escape of harness-composed
// OUTPUT excerpts (`excerptOutput`) derive from `isStructureShaped`, so a new
// slot added to the contract is automatically covered by both. `MANIFEST:` and
// friends are in the set, so a MANIFEST-shaped citation is caught either way.
const STRUCTURE_SHAPED_RE = /^\s*(VERDICT|CLAIM|FIXER-TEST|ADVERSARIAL|WHY-UNCOVERED|UNTESTED|FINDING|RAN|EXIT|MANIFEST|OUTPUT)\s*:/i;
const isStructureShaped = (l) => SECTION_RE.test(String(l).trim()) || STRUCTURE_SHAPED_RE.test(String(l));

/**
 * The harness's OWN excerpt of a recorded output — deterministic, never
 * verifier-selected (under the pasted-output contract a verifier could CURATE
 * its excerpt: quote only the PASS lines of an artifact that also says FAIL,
 * in order, and bind cleanly — evidence by omission). Whole output when short;
 * head + bare-ellipsis + tail when long.
 *
 * HOLE #18 (clean-room run e4a9d6c9, ratcheted): a recorded run's REAL stdout
 * is attacker-influenced — a verifier's adversarial command need only
 * `console.log('FINDING: …')` (or CLAIM:/RAN:/EXIT:/MANIFEST:/a `=== … ===`
 * banner) to have that structure-shaped line composed verbatim into the final
 * verdict, where `validateVerdict` counts it as a real finding / mis-parses the
 * document. So EVERY structure-shaped line (the full closed slot/banner
 * vocabulary — `isStructureShaped`, the same set `quoteSpeech` guards, NOT a
 * second list) is replaced with a bare elision marker. The full artifact stays
 * in harness memory either way; binding treats the marker as elision.
 */
export function excerptOutput(output, { head = 40, tail = 15 } = {}) {
  const all = String(output ?? '').split('\n');
  while (all.length && !all[all.length - 1].trim()) all.pop();
  const safe = all.map((l) => isStructureShaped(l) ? '[...]' : l);
  if (safe.length <= head + tail + 5) return safe.join('\n');
  return [...safe.slice(0, head), '[...]', ...safe.slice(-tail)].join('\n');
}

// A verifier speech line composed into the UNTESTED body must not be able to
// masquerade as document structure; such lines are visibly quoted instead.
// Everything else is composed verbatim — these slots are unbound prose by
// design and documented as such.
//
// HOLE #17 (clean-room run 791c0681, ratcheted): the first version only
// escaped `=== … ===` banners and `VERDICT:` lines, so a verifier could
// fabricate a complete fake evidence block — `RAN:` / `EXIT:` /
// `MANIFEST: deadc0deface0 sha256=… exit=0` / `OUTPUT:` / fake PASS lines —
// inside its UNTESTED/FINDING speech and have it compose verbatim,
// indistinguishable from the harness's own mechanical sections. Now ANY
// structure-shaped speech line (`isStructureShaped`) is visibly quoted.
// The label prefix `FINDING:`/`UNTESTED:` on the composed line itself stays
// harness-owned (cross-provider review finding #1: quoting the whole FINDING
// line would erase the finding from validateVerdict's view) — only the
// PAYLOAD is inspected and quoted.
const quoteSpeech = (l) => isStructureShaped(l) ? `> ${l}` : l;
// Composed FINDING lines: the label is the harness's, the payload is speech.
const composeFinding = (f) => {
  const payload = String(f).replace(/^FINDING:\s*/, '');
  return `FINDING: ${quoteSpeech(payload)}`;
};

/**
 * Compose the final verdict HARNESS-SIDE from the verifier's citations and the
 * harness's own records. Referential validation first — ids exist, sections
 * cite distinct runs, the fixer-test command is the harness-supplied one, an
 * adversarial run is of a different command, and exits are consistent with the
 * verdict's direction where checkable (HOLDS means every break attempt failed,
 * so every cited run must have exited 0). Only then is text emitted, and every
 * evidence byte of it comes from the manifest entries, never from the reply.
 *
 * @returns {{ text: string|null, violations: string[] }}
 */
export function composeVerdict(cite, opts = {}) {
  const violations = [];
  const entries = Array.isArray(opts.manifest) ? opts.manifest : [];
  const used = new Set();
  const lookup = (id, where) => {
    const e = entries.find((x) => String(x.id).toLowerCase() === String(id ?? '').toLowerCase());
    if (!e) { violations.push(`${where} cites run ${id ?? '(none)'}, which the harness never recorded — a citation of a run that did not happen is forged evidence`); return null; }
    if (used.has(e.id)) { violations.push(`${where} re-cites run ${e.id} already used by another section — each section needs its OWN recorded run`); return null; }
    used.add(e.id);
    return e;
  };
  const fixer = cite.fixerId ? lookup(cite.fixerId, '`=== FIXER-TEST ===`') : null;
  if (!cite.fixerId) violations.push('no fixer-test citation to compose evidence from');
  const known = (Array.isArray(opts.knownRuns) ? opts.knownRuns : []).map(normCmd).filter(Boolean);
  if (fixer && known.length && !known.some((k) => sameCmd(k, fixer.cmd))) {
    violations.push(`\`=== FIXER-TEST ===\` cites run ${fixer.id}, whose recorded command (${normCmd(fixer.cmd).slice(0, 80)}) is not the harness-supplied fixer test command — "the fixer's own test" means THE fixer's test, not a stand-in`);
  }
  const advs = [];
  for (const a of cite.adversarial ?? []) {
    const e = lookup(a.id, `adversarial case "${a.slug}"`);
    if (e && ((fixer && sameProgram(e.cmd, fixer.cmd)) || known.some((k) => sameProgram(k, e.cmd)))) {
      violations.push(`adversarial case "${a.slug}" cites a run of the fixer's own command (${normCmd(e.cmd).slice(0, 80)}) — that covers exactly what the fixture already covered (leading env assignments cannot make it distinct)`);
    }
    if (e) advs.push({ ...a, entry: e });
  }
  if (cite.verdict === 'HOLDS') {
    for (const e of [fixer, ...advs.map((x) => x.entry)]) {
      if (e && e.exit !== 0) violations.push(`\`VERDICT: HOLDS\` is inconsistent with cited run ${e.id} exiting ${e.exit} — HOLDS means every break attempt failed, and a failed break attempt exits 0`);
    }
  }
  if (violations.length || !fixer || !advs.length) {
    if (!violations.length) violations.push('nothing composable — no usable citations');
    return { text: null, violations };
  }
  const section = (banner, why, e) => [
    banner,
    ...(why ? [`WHY-UNCOVERED: ${why}`] : []),
    `RAN: ${normCmd(e.cmd)}`,
    `EXIT: ${e.exit}`,
    `MANIFEST: ${e.id} sha256=${e.sha256} exit=${e.exit}`,
    'OUTPUT:',
    excerptOutput(e.output),
  ].join('\n');
  const text = [
    `VERDICT: ${cite.verdict}`,
    `CLAIM: ${cite.claim}`,
    '',
    section('=== FIXER-TEST ===', null, fixer),
    '',
    ...advs.map((a) => section(`=== ADVERSARIAL: ${a.slug} ===`, a.why, a.entry) + '\n'),
    '=== UNTESTED ===',
    ...cite.untested.map(quoteSpeech),
    '',
    ...cite.findings.map(composeFinding),
    '',
  ].join('\n');
  return { text, violations: [] };
}

/**
 * `Verified-by:` — architectural enforcement (FEAT-061 user correction).
 *
 * The line must name a DISPATCH RUN: provider (+optional model) and the run /
 * transcript id the dispatch printed. An orchestrator Task subagent has no
 * dispatch id, so an in-process "verification" cannot forge a satisfying line
 * without fabricating an id — the check is on the SHAPE of the evidence, which
 * is the point: enforcement in architecture, not etiquette.
 *
 *   - **Verified-by:** dispatch anthropic/claude-haiku-4-5 run 0f8c… — VERDICT: BROKEN
 */
export const VERIFIED_BY_RE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?Verified-by:?(?:\*\*)?:?\s*dispatch\s+(anthropic|openai)(?:\/([^\s]+))?\s+run\s+([A-Za-z0-9][A-Za-z0-9._:-]{5,})/im;

export function parseVerifiedBy(text) {
  const m = VERIFIED_BY_RE.exec(String(text ?? ''));
  if (!m) return null;
  return { provider: m[1], model: m[2] ?? null, runId: m[3] };
}

export function formatVerifiedBy({ provider, model, runId, verdict }) {
  return `- **Verified-by:** dispatch ${provider}${model ? `/${model}` : ''} run ${runId}` +
    ` (clean-room, \`scripts/independent-verify.mjs\`)${verdict ? ` — VERDICT: ${verdict}` : ''}`;
}

/**
 * A `Verified-by:` line WRAPS. `formatVerifiedBy` emits one long line, but a
 * human writing the same record — or an editor reflowing it — puts the run id
 * on one line and `— VERDICT: X` on the next:
 *
 *     - **Verified-by:** dispatch anthropic/sonnet run 78fb…04cd (clean-room,
 *       `scripts/independent-verify.mjs`) — VERDICT: HOLDS
 *
 * Every reader of these records scanned ONE PHYSICAL LINE, so the verdict of a
 * wrapped record was simply not there: `extractVerificationRecords` recorded
 * `invalid` and `provenance-check.mjs` recorded `none`. Six real records on this
 * board are written that way, and the damage was silent in both directions —
 * three `VERDICT: BROKEN` records on `FEAT-061` were transcribed as `invalid`,
 * and on `FEAT-062` the same run id appeared wrapped and unwrapped, so the two
 * readings disagreed with each other and quarantined a ticket that says one
 * consistent thing.
 *
 * So the record's text is its list item's FIRST PARAGRAPH, not its first line.
 * A continuation is an indented, non-blank line that does not itself open
 * something new — a new list item, a heading, a fence, a table row, or another
 * `Verified-by:` record, which must never be swallowed into the one above it.
 * A blank line ends the paragraph, and with it the record.
 *
 * ABSORPTION IS BOUNDED ON PURPOSE. Joining is how text that a ticket does not
 * assert could become a verdict it never wrote, which is exactly the class
 * ARCH-009 exists to close — so the join STOPS at the first `VERDICT:` token.
 * A record's own sentence is complete once its verdict is in it; nothing beyond
 * that point can change what the record says. Measured over the 196 real ticket
 * files: identical results with and without the early stop, and the early stop
 * reads at most one continuation line for every record whose verdict wrapped.
 *
 * Returns the joined text for the record whose head line is `lines[i]`. Callers
 * keep iterating physical lines: a continuation can never match
 * `VERIFIED_BY_RE` or a `### <date>` heading, so nothing is double-counted.
 */
export function joinVerdictContinuation(lines, i) {
  const VERDICT = /VERDICT:\s*[A-Za-z]+/i;
  let text = String(lines[i] ?? '');
  if (VERDICT.test(text)) return text;
  for (let j = i + 1; j < lines.length; j++) {
    const line = String(lines[j] ?? '');
    if (!isVerdictContinuationLine(line)) break;
    text += ` ${line.trim()}`;
    if (VERDICT.test(text)) break;
  }
  return text;
}

/** Indented prose belonging to the list item above it — and nothing else. */
export function isVerdictContinuationLine(line) {
  const s = String(line ?? '');
  if (!/^[ \t]+\S/.test(s)) return false;              // blank, or starts at col 0
  if (/^[ \t]*(?:[-*+]\s|\d+[.)]\s)/.test(s)) return false; // a new list item
  if (/^[ \t]*#/.test(s)) return false;                // a heading
  if (/^[ \t]*(?:`{3,}|~{3,})/.test(s)) return false;  // a fence
  if (/^[ \t]*(?:>|\|)/.test(s)) return false;         // a quote or a table row
  return !new RegExp(VERIFIED_BY_RE.source, 'i').test(s); // another record
}
