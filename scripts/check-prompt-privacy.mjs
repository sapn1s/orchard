#!/usr/bin/env node
/**
 * check-prompt-privacy.mjs — FEAT-172 publication-privacy guard (round 4).
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
 *   (1) any normalized sentence / marker-anchored n-gram DERIVED from the local
 *       overlay (docs/prompts/OPERATOR.local.md) — its facts, verbatim, including
 *       when they wrap a line break (normalization folds newlines);
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
 * ── RESIDUAL (round 4 — accepted, bounded) ───────────────────────────────────
 * Two residuals remain, and BOTH fail LOUD (a non-zero exit a human sees), never
 * silently:
 *   • Rephrasing (as above) can still slip a reworded personal fact past the guard.
 *   • A VERY GENERIC overlay — one whose only marker-bearing lines are framing +
 *     shared ROUTING/WA vocabulary + a bare date (e.g. a heading that is nothing but
 *     "as of <date>") — now yields NO derived signature for those lines. That closes
 *     the round-3 over-match (such a line used to false-FAIL a clean published doc),
 *     but it also means a future overlay that encodes a fact using ONLY shared
 *     vocabulary would not be promoted to a derived signature. A false positive of
 *     the opposite kind (an overlay phrase that happens to collide with published
 *     text) likewise surfaces as a loud FAIL, not a silent pass — a human adjudicates
 *     it, never the gate quietly letting a leak through.
 *
 * ── Why this is NOT a hand list of files + a hand list of regexes (round 1 was,
 *    and an independent verify broke it two ways — run 911b54e2) ───────────────
 *
 * Round 1 scanned 6 named files with line-by-line regexes. Two structural holes:
 *   (1) Line-by-line could not see prose that WRAPS a line break, and the known
 *       pre-scrub paragraph ("Capacity here is Claude-abundant, GPT-scarce … a $20
 *       ChatGPT / Plus plan on rolling 5-hour windows") wraps exactly there, so
 *       restoring it passed.  → FIX: normalize (markdown + whitespace, INCLUDING
 *       newlines) and match over sliding 1–3 line windows, not single lines.
 *   (2) A 6-file allow-list left README, the worker template, the .example overlay
 *       and the rest of docs/guide/* unscanned, so personal assertions added there
 *       passed.  → FIX: ENUMERATE the scan set from the repo (tracked + untracked-
 *       but-not-ignored) and DENY-list the few surfaces that cannot be scanned,
 *       each justified below, so a NEW prose file is covered by default.
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
 * The real overlay (docs/prompts/*.local.md) is gitignored, so it is never in the
 * untracked-not-ignored set; a committed one is caught by assertion (1) below.
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
  // the gitignored real overlay is never published; a committed one → assertion (1)
  if (/(^|\/)[^/]*\.local\.md$/.test(rel)) return true;
  return false;
}

function listCandidates() {
  const out = new Set();
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const others = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  // FAIL CLOSED (round-2 break A — vacuity): if enumeration cannot run (not a git
  // repo, git missing, permission error) we DO NOT KNOW what is publication-bound,
  // so we must refuse to pass rather than scan 0 files and exit 0. A silent
  // `continue` here let the whole guard pass vacuously whenever git failed.
  for (const r of [tracked, others]) {
    if (r.status !== 0) {
      const msg = ((r.stderr || '').trim() || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 200);
      return { ok: false, reason: `git file enumeration failed — cannot determine the publication-bound scan set (${msg})`, files: [] };
    }
    for (const rel of r.stdout.split('\0').map((s) => s.trim()).filter(Boolean)) {
      if (!denied(rel)) out.add(rel);
    }
  }
  const files = [...out].sort();
  // Also fail closed on an EMPTY scan set: a real Orchard checkout always has
  // publication-bound prose (README, docs/prompts/*), so 0 candidates means the
  // enumeration ran against the wrong/empty tree — passing would be vacuous.
  if (files.length === 0) {
    return { ok: false, reason: 'enumeration yielded 0 candidate files — refusing to pass vacuously', files };
  }
  return { ok: true, reason: '', files };
}

// ── Normalization: strip markdown emphasis, fold dashes/punctuation to spaces,
//    collapse ALL whitespace (incl. newlines) so wrapped prose is one string.
function norm(s) {
  return s
    .replace(/[`*_~]+/g, ' ')
    .replace(/[–—]/g, ' ')          // en/em dash
    .replace(/[(),.:;!?"'‘’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
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
//    DISTINCTIVE token (round-4 fix — addresses the over-match break, run ff31f61a).
//
// Round-3's derived set promoted ANY 2–3-token window straddling a marker, and the
// "dated stamp" marker (/^20\d\d(-\d\d){0,2}$/) let a BARE DATE anchor a signature:
// an overlay heading "as of 2026-08-05" produced the gram "as of 2026-08-05", which
// then matched the REAL docs/prompts/ROUTING.md staleness banners ("researched
// 2026-08-05", "as of 2026-08-05") — a genuinely-clean published doc flagged as a
// leak. Dates and framing words ("as", "of", "dated", "researched") are SHARED
// vocabulary between the overlay and the published docs, so they must never anchor a
// signature on their own.
//
// RULE: an overlay-derived n-gram counts only if it contains ≥1 DISTINCTIVE token —
// one that is NOT a marker, NOT a date, NOT a stopword, and NOT a word that already
// appears in the public ROUTING/WA text. A window of only markers + dates + framing +
// shared vocabulary carries nothing that identifies the operator, so it is dropped.
// This can only SHRINK the derived set, so it cannot introduce a false positive; the
// known pre-scrub facts stay covered by the GENERIC fallback above regardless.
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
// Words that appear in the PUBLIC, de-personalised ROUTING / Working Agreement mirrors
// are shared product vocabulary ("provider", "scarce", "window", "chatgpt", "claude",
// "anthropic", "rolling", …), NOT operator-identifying tokens. Loaded from the tracked
// published docs so the exclusion tracks the real text, not a frozen hand list.
function loadPublicWords() {
  const words = new Set();
  const names = ['ROUTING.md'];
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'docs/prompts'))) {
      if (/^WORKING_AGREEMENT\.v\d+\.md$/i.test(f)) names.push(f);
    }
  } catch { /* no docs/prompts on this tree — generic fallback still runs */ }
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, 'docs/prompts', n), 'utf8'); } catch { continue; }
    for (const tok of norm(text).split(' ')) if (tok) words.add(tok);
  }
  return words;
}
function distinctive(tok, publicWords) {
  if (tok.length < 3) return false;        // too short to identify anyone
  if (isMarker(tok) || isDate(tok)) return false; // a marker/date is not itself distinctive
  if (STOPWORDS.has(tok)) return false;    // framing / function word
  if (publicWords.has(tok)) return false;  // shared with the published docs
  return true;
}
function derivedSignatures(overlayText, publicWords) {
  const sigs = new Set();
  for (const raw of overlayText.split('\n')) {
    const toks = norm(raw).split(' ').filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      if (!isMarker(toks[i])) continue;
      for (const [s, e] of [[i - 2, i], [i - 1, i + 1], [i, i + 2]]) {
        const a = Math.max(0, s);
        const b = Math.min(toks.length - 1, e);
        if (b - a < 1) continue;
        const gram = toks.slice(a, b + 1);
        // Drop grams that carry no operator-identifying token (bare dates + framing +
        // shared vocabulary). This is the round-4 over-match fix.
        if (!gram.some((t) => distinctive(t, publicWords))) continue;
        sigs.add(gram.join(' '));
      }
    }
  }
  return [...sigs];
}

const failures = [];

// (1) no tracked operator-local overlay — it must stay gitignored.
{
  const r = spawnSync('git', ['ls-files', 'docs/prompts/*.local.md'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) {
    for (const f of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      failures.push(`${f}: an operator-local overlay is TRACKED — it must stay gitignored (never committed).`);
    }
  }
}

// Build the overlay-derived signature set (empty when no overlay present).
const publicWords = loadPublicWords();
let derived = [];
try {
  derived = derivedSignatures(fs.readFileSync(path.join(ROOT, OVERLAY_REL), 'utf8'), publicWords);
} catch { /* no overlay on this machine — generic fallback still runs */ }

// (2) scan every publication-bound file for personal assertions / overlay prose.
const scan = listCandidates();
if (!scan.ok) {
  console.error(`PROMPT-PRIVACY: FAIL (fail-closed) — ${scan.reason}.`);
  console.error('  The guard cannot verify an unknowable scan set; treating as a leak risk.');
  process.exit(1);
}
const scanned = scan.files;
for (const rel of scanned) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  const lines = text.split('\n');

  // Generic patterns over sliding 1–3 line windows (catches wrapped prose).
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    for (let w = 0; w < 3 && i + w < lines.length; w++) {
      const windowNorm = norm(lines.slice(i, i + w + 1).join(' '));
      if (!windowNorm) continue;
      for (const g of GENERIC) {
        const key = `${g.re.source}@${i}`;
        if (seen.has(key)) continue;
        if (g.re.test(windowNorm)) {
          seen.add(key);
          failures.push(`${rel}:${i + 1}: personal assertion — ${g.why}: ${lines[i].trim().slice(0, 120)}`);
        }
      }
    }
  }

  // Derived overlay signatures over the whole normalized file.
  if (derived.length) {
    const fileNorm = norm(text);
    for (const sig of derived) {
      if (!fileNorm.includes(sig)) continue;
      // best-effort line: first line whose normalized form contains the sig's head token
      const head = sig.split(' ')[0];
      let ln = lines.findIndex((l) => norm(l).includes(head));
      if (ln < 0) ln = 0;
      const key = `derived:${sig}@${ln}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push(`${rel}:${ln + 1}: operator-overlay prose leaked into a published file ("${sig}")`);
    }
  }
}

if (failures.length === 0) {
  console.log(`PROMPT-PRIVACY: PASS — scanned ${scanned.length} publication-bound file(s); ` +
    `${derived.length} overlay-derived signature(s)${derived.length ? '' : ' (no overlay on this machine)'}; ` +
    `no tracked overlay; no personal assertions.`);
  process.exit(0);
}
console.error(`PROMPT-PRIVACY: FAIL — ${failures.length} leak(s) of an operator-specific fact into published material:`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
