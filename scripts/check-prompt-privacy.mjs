#!/usr/bin/env node
/**
 * check-prompt-privacy.mjs — FEAT-172 publication-privacy guard (round 7).
 *
 * The owner's per-operator facts (which provider subscription is abundant vs
 * scarce, the concrete plan/billing, that the machine dual-boots) were scrubbed
 * OUT of the published, injected docs (ROUTING.md / the Working Agreement / the
 * integrations guide) and MOVED into a gitignored operator-local overlay
 * (docs/prompts/OPERATOR.local.md, injected by src/server/templates.ts
 * operatorLocalSection). `.gitignore` keeps the overlay out of commits, but it is
 * not a publication guard: a later canonical edit could re-introduce the budget
 * prose, or someone could `git add -f` the overlay, and `sync:methodology` + the
 * token leak-gate would both faithfully pass. This check closes that gap.
 *
 * ── CONTRACT (what this guard promises, and what it does NOT) ─────────────────
 * THREAT MODEL: an *accidental reintroduction of known personal text* — someone
 * re-syncing an old canonical, copying from the gitignored overlay, or pasting the
 * old guide prose back in. It is NOT an author deliberately rewording personal
 * facts: no regex can stop a determined human rephrasing by construction, and that
 * is out of scope by design (WA §N two-break design review, round 2 → RESCOPE).
 *
 * So the guard catches, over the publication-bound scan set, exactly:
 *   (1) any marker-anchored n-gram DERIVED from the local overlay
 *       (docs/prompts/OPERATOR.local.md) — its facts, verbatim, including when
 *       they wrap a line break (the ONE tokenize() chokepoint folds newlines on
 *       BOTH the derivation and the scan side, so there is no line structure to
 *       be asymmetric about);
 *   (2) the specific KNOWN pre-scrub texts (the budget/capacity/dual-boot prose),
 *       line-wrapped forms included; and
 *   (3) a small GENERIC fallback of personal-ASSERTION patterns, so a machine with
 *       no overlay still catches the known pre-scrub prose.
 * It also (0) FAILS CLOSED: if it cannot enumerate the scan set, or the set is
 * empty, it exits non-zero rather than passing vacuously (round-2 break A).
 *
 * EXPLICITLY OUT OF SCOPE: rephrased/paraphrased personal prose that preserves no
 * generic pattern and no overlay marker-gram. That is the AUTHOR'S responsibility
 * under WA §P security hygiene, not this mechanical guard's. Do NOT "fix" a report
 * of a cleverly-reworded leak by bolting on more rephrasing patterns — that was the
 * round-1/round-2 failure mode; attack the contract stated here, not an imagined one.
 *
 * ── RESIDUAL (round 5 — accepted, bounded) ───────────────────────────────────
 * Two residuals remain, and BOTH fail LOUD (a non-zero exit a human sees), never
 * silently:
 *   • Rephrasing (as above) can still slip a reworded personal fact past the guard.
 *   • A VERY GENERIC overlay — one whose only marker-bearing lines are framing +
 *     a bare date (e.g. a heading that is nothing but "as of <date>") — yields NO
 *     derived signature for those lines (no distinctive token survives the
 *     marker/date/stopword filter). That closes the round-3 over-match (such a line
 *     used to false-FAIL a clean published doc), but it also means a future overlay
 *     that encodes a fact using ONLY framing + dates would not be promoted to a
 *     signature; such a fact is not operator-identifying on its face.
 *
 * ── CRITICAL INVARIANT (round-5 design decision — run 01a129ca) ───────────────
 * The non-leak vocabulary is NEVER derived from scanned content. Round 4 excluded any
 * overlay token that also appeared in the published ROUTING / Working Agreement docs
 * ("shared vocabulary"), loaded live from those files. But those are the very files
 * this guard scans for leaks: pasting an overlay sentence INTO ROUTING.md (or a WA
 * file) promoted that sentence's own tokens to "public", so every n-gram derived over
 * it lost its distinctive token and was dropped — the leak passed SILENTLY (exit 0)
 * while the identical sentence in README.md was caught. Those re-syncable mirror files
 * are exactly the ones most likely to take a leak back. FIX: distinctiveness rests
 * ONLY on the fixed marker/date/STOPWORDS predicates; no file this guard reads may
 * define what counts as non-leaking. regressed-from: FEAT-172 round-4.
 *
 * ── THE LINE-STRUCTURE BREAK CLASS (rounds 1, 5 and 6) and its fix ────────────
 *
 * Three independent breaks all had the SAME shape: some stage of the pipeline
 * reasoned about LINES, and a fact that wraps a line break slipped through the
 * seam. Round 1 matched line-by-line on the SCAN side (a wrapped pre-scrub
 * paragraph passed). Round 5 folded newlines on the scan side but still
 * `split('\n')`-ed the overlay BEFORE normalizing on the DERIVATION side, so a
 * wrapped overlay marker produced NO signature and a verbatim copy passed
 * SILENTLY (run 01a129d7). Patching one seam at a time just moved the seam.
 *   → FIX (round 6 — REDESIGN, single chokepoint): ONE function, tokenize(),
 *     folds a WHOLE document (markdown + ALL whitespace incl. newlines +
 *     punctuation, case-folded) into a flat token stream. BOTH the overlay
 *     derivation AND the scan of every candidate file — AND the known pre-scrub
 *     texts — go through it. Signatures and matching are n-grams over those token
 *     streams. There is NO line splitting and NO line window anywhere in the
 *     matching path, so there is no line seam left to be asymmetric across.
 *     regressed-from: FEAT-172 round-5 (and the same class as round-1 break 1).
 *
 * The OTHER round-1 hole was scope: a 6-file allow-list left README, the worker
 * template, the .example overlay and the rest of docs/guide/* unscanned.
 *   → FIX: ENUMERATE the scan set from the repo (tracked + untracked-but-not-
 *     ignored) and DENY-list the few surfaces that cannot be scanned, each
 *     justified below, so a NEW prose file is covered by default.
 *
 * ── Scan scope (a): deny-list, not allow-list ────────────────────────────────
 * Scanned = every git-tracked OR untracked-not-ignored TEXT file, MINUS:
 *   • source + config (src/, public/, scripts/, .githooks/, deploy/, the .orchard/
 *     method-library CODE/config mirror — .mjs/.json/hooks/lib — and the root
 *     tool/config files): these legitimately carry the product's own vocabulary —
 *     e.g. src/server/fork.ts comments "This user dual-boots…", public/app.js
 *     handles a "5-hour window", scripts describe the 5-hour quota — because the
 *     PRODUCT models usage windows and cross-OS store dirs. Scrubbing code comments
 *     is FEAT-049's fresh-history publish job, not injection-time, and scanning
 *     them here would be nothing but false positives.
 *     NB: .orchard/ PROSE (.orchard/*.md, e.g. .orchard/CONVENTIONS.md — the
 *     conventions doc injected into every session, preferred over legacy
 *     docs/CONVENTIONS.md) IS scanned; only .orchard/ code/config + its ticket
 *     history (.orchard/bugs/) are denied. (round-3 reviewer run 0e762186 found a
 *     blanket .orchard/ deny let overlay prose pasted into CONVENTIONS.md publish.)
 *   • docs/bugs/ — append-only ticket history (board invariant forbids editing it;
 *     the pre-scrub prose it quotes is FEAT-049's publish scrub, per this ticket's
 *     own prior log — explicitly out of scope).
 *   • docs/analysis/ — dated internal cost/usage analyses that legitimately quote
 *     real $ figures and "5-hour windows"; not outsider-facing setup material.
 *     (Residual surface for FEAT-049's publish scrub, like the ticket history.)
 *   • docs/PROVIDERS.md — a provider PRICING reference; "$20/mo", "rolling 5-hour
 *     windows" there are PUBLIC ChatGPT-Plus product facts, not a personal claim.
 *   • docs/assets/ and any binary file (NUL-byte / non-text extension).
 *   • this guard + its .orchard/ mirror necessarily contain the forbidden literals.
 * The scan set is EXACTLY what git would publish or could publish: `git ls-files`
 * plus `--others --exclude-standard`, read `-z` and NUL-split with NO trimming (a
 * leading/trailing space is part of a real path; trimming made readFileSync ENOENT
 * and silently skip the file — round-6 secondary, run 01a129e8).
 *
 * The overlay is handled by GIT'S OWN ignore rules, NOT by a hand-coded deny.
 * `.gitignore` ignores `/docs/prompts/*.local.md`, so the real overlay is in
 * neither `git ls-files` nor the untracked-not-ignored set — git already excludes
 * it. We therefore DO NOT hand-deny `*.local.md`: the old blanket deny skipped
 * EVERY `*.local.md` anywhere, but only `/docs/prompts/*.local.md` is the ignored
 * overlay, so any OTHER `*.local.md` (docs/guide/notes.local.md, a root
 * README.local.md, …) is an un-ignored publication-bound prose file that was being
 * skipped silently — known personal prose in one published unseen (round-6 primary,
 * run 01a129e8). Such files are now scanned like any prose file.
 * Conversely, if a `/docs/prompts/*.local.md` path EVER appears in the candidate
 * set, git is no longer ignoring it (tracked, ignore rule removed, or `git add -f`)
 * and it would be PUBLISHED with the operator's real holdings → assertion (1) FAILS
 * LOUDLY. (This subsumes round-2/3's "tracked overlay" assertion and also catches
 * an un-ignored but untracked overlay.)
 *
 * ── Pattern source (b): derived from the overlay + a generic fallback ─────────
 * When docs/prompts/OPERATOR.local.md exists, it IS the list of personal facts, so
 * we derive signatures FROM it: normalized marker-anchored n-grams (a fragment is
 * only promoted to a signature if it is anchored on a concrete personal datum — a
 * currency amount, an "N-hour" window, a "dual-boots" assertion, a dated stamp —
 * so the overlay's deliberately-shared generic routing prose, e.g. "plan review,
 * adversarial review of finished work", is NEVER promoted and never false-fires on
 * ROUTING.md). On a machine with no overlay, the generic fallback still runs; it
 * must at least catch the known pre-scrub prose quoted above.
 *
 * Exit 0 = clean, 1 = a leak (loud, names file:line). Tolerant of absent files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : path.resolve(HERE, '..');
})();

const OVERLAY_REL = 'docs/prompts/OPERATOR.local.md';
// The gitignored operator overlay(s): `.gitignore` ignores exactly
// `/docs/prompts/*.local.md`. If a path matching this glob EVER shows up in the
// publication-bound candidate set, git is no longer ignoring it (tracked, or the
// ignore rule was removed / `git add -f`), so it WOULD be published with the
// operator's real holdings inside — a loud FAIL (round-6 design).
const OVERLAY_GLOB = /^docs\/prompts\/[^/]*\.local\.md$/;

// ── Deny-list: prefixes/paths that are NOT publication-bound prose (justified in
//    the header). Everything else tracked/untracked-not-ignored & text is scanned.
const DENY_PREFIX = [
  'src/', 'public/', 'scripts/', '.githooks/', 'deploy/',
  'docs/bugs/', 'docs/analysis/', 'docs/assets/',
  'node_modules/', '.git/',
];
const DENY_EXACT = new Set([
  'docs/PROVIDERS.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts',
  '.gitignore', 'LICENSE',
]);
// Binary-ish extensions never carry prose.
const BINARY_EXT = /\.(png|jpe?g|gif|svg|ico|webp|pdf|woff2?|ttf|eot|mp4|mov|webm|zip|gz|tgz|wasm|lock)$/i;

function denied(rel) {
  if (DENY_EXACT.has(rel)) return true;
  // .orchard/ is the method-library CODE + config mirror (.mjs/.json/hooks/lib) —
  // denied like scripts/. BUT it ALSO ships PROSE docs that are injected into every
  // session (e.g. .orchard/CONVENTIONS.md via resolveConventionsFile(), preferred
  // over the legacy docs/CONVENTIONS.md). Those must be scanned — a blanket
  // .orchard/ deny let overlay prose copied into .orchard/CONVENTIONS.md publish
  // unseen (round-3 reviewer, run 0e762186). So: scan .orchard/*.md prose, deny its
  // code/config, and deny .orchard ticket history (append-only, like docs/bugs/).
  if (rel.startsWith('.orchard/')) {
    if (rel.startsWith('.orchard/bugs/')) return true;   // append-only history (FEAT-049)
    if (!/\.md$/i.test(rel)) return true;                // code/config, not prose
    // else: fall through — an .orchard/*.md prose doc IS publication-bound.
  }
  if (DENY_PREFIX.some((p) => rel.startsWith(p))) return true;
  if (BINARY_EXT.test(rel)) return true;
  // the guard itself (either copy) contains the forbidden literals by necessity
  if (/(^|\/)check-prompt-privacy\.mjs$/.test(rel)) return true;
  // NB: we do NOT hand-deny `*.local.md`. Git's own ignore rules already keep the
  // real operator overlay out of the scan set (it is gitignored, so it appears in
  // neither `git ls-files` nor `--others --exclude-standard`). A blanket
  // `*.local.md` deny was WRONG: only `/docs/prompts/*.local.md` is the ignored
  // overlay, so any OTHER `*.local.md` (e.g. docs/guide/notes.local.md, a root
  // README.local.md) is a publication-bound, un-ignored prose file that MUST be
  // scanned — hand-denying it let known personal prose publish silently (round-6
  // reviewer, run 01a129e8). An overlay path that DOES show up as a candidate
  // (git is no longer ignoring it → it would be published) is caught loudly by the
  // OVERLAY_GLOB check in listCandidates, not here.
  return false;
}

function listCandidates() {
  const out = new Set();
  const overlay = new Set();
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const others = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  // FAIL CLOSED (round-2 break A — vacuity): if enumeration cannot run (not a git
  // repo, git missing, permission error) we DO NOT KNOW what is publication-bound,
  // so we must refuse to pass rather than scan 0 files and exit 0. A silent
  // `continue` here let the whole guard pass vacuously whenever git failed.
  for (const r of [tracked, others]) {
    if (r.status !== 0) {
      const msg = ((r.stderr || '').trim() || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 200);
      return { ok: false, reason: `git file enumeration failed — cannot determine the publication-bound scan set (${msg})`, files: [], overlayPublished: [] };
    }
    // NUL-split `git ls-files -z` (the trailing NUL yields an empty final field,
    // dropped by filter(Boolean)). NO `.trim()`: a filename with leading/trailing
    // whitespace is a real, publishable path; trimming it made readFileSync ENOENT
    // and silently skip the file (round-6 secondary finding, run 01a129e8).
    for (const rel of r.stdout.split('\0').filter(Boolean)) {
      if (OVERLAY_GLOB.test(rel)) { overlay.add(rel); continue; }
      if (!denied(rel)) out.add(rel);
    }
  }
  const overlayPublished = [...overlay].sort();
  const files = [...out].sort();
  // Also fail closed on an EMPTY scan set: a real Orchard checkout always has
  // publication-bound prose (README, docs/prompts/*), so 0 candidates means the
  // enumeration ran against the wrong/empty tree — passing would be vacuous.
  if (files.length === 0) {
    return { ok: false, reason: 'enumeration yielded 0 candidate files — refusing to pass vacuously', files, overlayPublished };
  }
  return { ok: true, reason: '', files, overlayPublished };
}

// ── THE CHOKEPOINT: tokenize(text) -> token[] ────────────────────────────────
// Folds a WHOLE document into a flat, case-folded token stream: strip markdown
// emphasis, fold en/em dashes + sentence punctuation to spaces, then split on
// ALL whitespace INCLUDING newlines. A fact that wraps a line break therefore
// becomes a contiguous token run, identically on the derivation side and the
// scan side — no line structure survives for the two sides to disagree about
// (the rounds-1/5/6 break class). `$`, digits, `/`, `+` and the plain hyphen are
// PRESERVED so markers stay intact ("$20", "5-hour", "claude-abundant").
function tokenize(text) {
  return text
    .replace(/[`*_~]+/g, ' ')
    .replace(/[–—]/g, ' ')          // en/em dash
    .replace(/[(),.:;!?"'‘’“”]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
// The same stream as a single normalized string, for the GENERIC regexes and for
// substring containment of a derived n-gram. Space-joined, so a regex `\b` or a
// space-padded signature match respects token boundaries.
function stream(text) {
  return tokenize(text).join(' ');
}
// Best-effort SOURCE LINE for a human-readable report ONLY — never a matching
// decision (matching is always over the whole-document token stream above).
function bestLine(lines, anchorTok) {
  if (!anchorTok) return 0;
  const i = lines.findIndex((l) => tokenize(l).includes(anchorTok));
  return i < 0 ? 0 : i;
}

// ── Generic fallback — PERSONAL ASSERTIONS only (never bare "abundant"/"scarce"/
//    "$N" model pricing / "dual-boot …setup" conditional framing, all of which
//    appear legitimately in the de-personalised published docs). Verified clean on
//    the current scanned tree.
const GENERIC = [
  { re: /\bcapacity here is\b/, why: 'asserts this machine\'s capacity as current fact ("Capacity here is …")' },
  { re: /claude-abundant/, why: 'pre-scrub capacity verdict ("Claude-abundant")' },
  { re: /gpt-scarce/, why: 'pre-scrub capacity verdict ("GPT-scarce")' },
  { re: /\$\s*\d+\s*chatgpt/, why: 'names the operator\'s concrete plan ("$N ChatGPT …")' },
  { re: /\brolling \d+-hour\b/, why: 'names the operator\'s metering window ("rolling N-hour window")' },
  { re: /\babundant here\b/, why: 'asserts this machine\'s capacity as current fact ("abundant here")' },
  { re: /\bscarce (?:here|resource)\b/, why: 'asserts this machine\'s capacity as current fact ("scarce here/resource")' },
  { re: /\bfor this (?:user|operator)\b/, why: 'routes "for this user/operator"' },
  { re: /\bthis user runs\b/, why: 'names the operator ("this user runs …")' },
  { re: /\bthis (?:machine|user|operator) dual-?boots\b/, why: 'asserts the operator\'s OS setup as fact ("this machine dual-boots")' },
  { re: /\bdual-?boots?\s+linux\s*\+\s*windows\b/, why: 'names the operator\'s concrete OS pair ("dual-boots Linux + Windows")' },
  { re: /\banthropic max\b/, why: 'names the operator\'s specific subscription ("Anthropic Max")' },
];

// ── Derived signatures from the overlay: marker-anchored n-grams that carry a
//    DISTINCTIVE token (round-5 design — run 01a129ca).
//
// Round-3's derived set promoted ANY 2–3-token window straddling a marker, and the
// "dated stamp" marker (/^20\d\d(-\d\d){0,2}$/) let a BARE DATE anchor a signature:
// an overlay heading "as of 2026-08-05" produced the gram "as of 2026-08-05", which
// then matched the REAL docs/prompts/ROUTING.md staleness banners ("researched
// 2026-08-05", "as of 2026-08-05") — a genuinely-clean published doc flagged as a
// leak. Dates and framing words ("as", "of", "dated", "researched") are framing
// scaffolding, so they must never anchor a signature on their own.
//
// RULE: an overlay-derived n-gram counts only if it contains ≥1 DISTINCTIVE token —
// one that is NOT a marker, NOT a date and NOT a stopword. A window of only markers +
// dates + framing carries nothing that identifies the operator, so it is dropped.
// This can only SHRINK the derived set, so it cannot introduce a false positive; the
// known pre-scrub facts stay covered by the GENERIC fallback above regardless.
//
// Distinctiveness is derived ONLY from the fixed STOPWORDS/marker/date predicates —
// NEVER from the content this guard scans. Round 4 excluded any token also present in
// the published ROUTING/WA docs; because those are the files scanned for leaks,
// pasting overlay prose into one of them promoted that prose's tokens to "public" and
// silently suppressed its own signatures (round-4 self-suppression break, run
// 01a129ca). No scanned file may ever define the non-leak vocabulary.
function isMarker(tok) {
  return /\$\d/.test(tok)            // currency amount
    || /\d-hour/.test(tok)           // metering window
    || /dual-?boots?/.test(tok)      // OS-setup assertion
    || /^20\d\d(-\d\d){0,2}$/.test(tok); // dated stamp (2026-08-10)
}
function isDate(tok) {
  return /^20\d\d(-\d\d){0,2}$/.test(tok);
}
// Framing / date-scaffolding + common function words. These are never distinctive:
// "as of <date>", "dated <date>", "researched <date>" are exactly how BOTH the overlay
// and the public banners phrase a timestamp, so none of these words anchors a signature.
const STOPWORDS = new Set([
  'as', 'of', 'the', 'a', 'an', 'to', 'for', 'on', 'in', 'at', 'is', 'are', 'and',
  'or', 'but', 'by', 'with', 'from', 'this', 'that', 'these', 'those', 'it', 'its',
  'be', 'was', 'were', 'has', 'have', 'had', 'we', 'our', 'us', 'you', 'your', 'per',
  'via', 'up', 'out', 'no', 'not', 'so', 'if', 'then', 'than', 'when', 'where', 'which',
  'who', 'side', 'both', 'under', 'over', 'into', 'onto', 'about', 'here', 'there',
  'dated', 'researched', 'mo', 'vs', 'etc', 'do', 'does', 'did', 'can', 'will', 'may',
  'treat', 'same', 'all', 'any', 'each', 'one', 'two', 'now', 'new',
]);
// A token is DISTINCTIVE (operator-identifying) if it is not a marker, not a date,
// not a stopword, and long enough to mean something. NOTHING is derived from the
// scanned content: a prior round excluded tokens that appeared in the published
// ROUTING / Working Agreement docs ("shared vocabulary"), but those are the very
// files this guard scans for leaks — pasting overlay prose INTO one of them promoted
// that prose's own tokens to "public" and suppressed its own signatures, a SILENT
// pass of a real leak (round-4 break, run 01a129ca). The design rule now: no
// vocabulary may be derived from scanned content. Distinctiveness rests only on
// markers, dates and stopwords, which also keeps the round-3 "as of <date>"
// over-match fixed (a window of only framing + a bare date has no distinctive token).
function distinctive(tok) {
  if (tok.length < 3) return false;        // too short to identify anyone
  if (isMarker(tok) || isDate(tok)) return false; // a marker/date is not itself distinctive
  if (STOPWORDS.has(tok)) return false;    // framing / function word
  return true;
}
function derivedSignatures(overlayText) {
  const sigs = new Set();
  // tokenize the WHOLE overlay (round-6): the token stream spans former line
  // breaks, so a marker that wrapped onto its own line now anchors n-grams the
  // same way a one-line marker does. No `split('\n')` — that was the round-5 seam.
  const toks = tokenize(overlayText);
  for (let i = 0; i < toks.length; i++) {
    if (!isMarker(toks[i])) continue;
    for (const [s, e] of [[i - 2, i], [i - 1, i + 1], [i, i + 2]]) {
      const a = Math.max(0, s);
      const b = Math.min(toks.length - 1, e);
      if (b - a < 1) continue;
      const gram = toks.slice(a, b + 1);
      // Drop grams that carry no operator-identifying token (bare dates +
      // framing). Distinctiveness is the fixed marker/date/stopword predicate
      // only — nothing is derived from scanned content (round-4/5 invariant).
      if (!gram.some((t) => distinctive(t))) continue;
      sigs.add(gram.join(' '));
    }
  }
  return [...sigs];
}

const failures = [];

// Build the overlay-derived signature set (empty when no overlay present).
let derived = [];
try {
  derived = derivedSignatures(fs.readFileSync(path.join(ROOT, OVERLAY_REL), 'utf8'));
} catch { /* no overlay on this machine — generic fallback still runs */ }

// (2) scan every publication-bound file for personal assertions / overlay prose.
const scan = listCandidates();
if (!scan.ok) {
  console.error(`PROMPT-PRIVACY: FAIL (fail-closed) — ${scan.reason}.`);
  console.error('  The guard cannot verify an unknowable scan set; treating as a leak risk.');
  process.exit(1);
}
// (1) The operator overlay must stay gitignored. If a `docs/prompts/*.local.md`
// path shows up in the publication-bound set at all, git is no longer ignoring it
// (tracked, or the ignore rule was removed / force-added), so it WOULD be published
// with the operator's real holdings — FAIL LOUDLY. This subsumes the old
// "tracked overlay" assertion and also catches an un-ignored untracked overlay.
for (const f of scan.overlayPublished) {
  failures.push(`${f}: the operator-local overlay is NOT gitignored (it appears in the publishable set) — it would be published with the operator's real holdings. Keep it matched by \`/docs/prompts/*.local.md\` in .gitignore and never \`git add -f\` it.`);
}
const scanned = scan.files;
for (const rel of scanned) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  // Matching is over the WHOLE-document token stream (one chokepoint). `lines` is
  // used ONLY to report a best-effort human-readable source line, never to match.
  const lines = text.split('\n');
  const fileStream = stream(text);

  // (a) Generic personal-assertion patterns over the whole normalized stream.
  for (const g of GENERIC) {
    const m = g.re.exec(fileStream);
    if (!m) continue;
    const anchor = tokenize(m[0])[0];
    const ln = bestLine(lines, anchor);
    failures.push(`${rel}:${ln + 1}: personal assertion — ${g.why}: ${lines[ln].trim().slice(0, 120)}`);
  }

  // (b) Derived overlay signatures: space-padded containment over the same stream
  //     so an n-gram only matches on token boundaries.
  if (derived.length) {
    const padded = ` ${fileStream} `;
    for (const sig of derived) {
      if (!padded.includes(` ${sig} `)) continue;
      const ln = bestLine(lines, sig.split(' ')[0]);
      failures.push(`${rel}:${ln + 1}: operator-overlay prose leaked into a published file ("${sig}")`);
    }
  }
}

if (failures.length === 0) {
  console.log(`PROMPT-PRIVACY: PASS — scanned ${scanned.length} publication-bound file(s); ` +
    `${derived.length} overlay-derived signature(s)${derived.length ? '' : ' (no overlay on this machine)'}; ` +
    `overlay gitignored (not in the publishable set); no personal assertions.`);
  process.exit(0);
}
console.error(`PROMPT-PRIVACY: FAIL — ${failures.length} leak(s) of an operator-specific fact into published material:`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
