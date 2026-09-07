#!/usr/bin/env node
/**
 * leak-tokens.mjs — the ONE private-token list, shared (FEAT/BUG for the
 * ticket-write leak-guard).
 *
 * This module holds nothing but the token definitions and a `findLeaks(text)`
 * helper over them. It was extracted VERBATIM out of scripts/leak-gate.mjs so
 * there is exactly ONE matcher: the commit-time gate (leak-gate.mjs) and the
 * authoring-time guard (board-tool.mjs `file`/`update`) both import THIS list.
 * Two detectors that disagree would be a worse bug than the one being fixed, so
 * there is only ever this one.
 *
 * SELF-IMMUNITY. Every literal private string is deliberately split
 * ('saa'+'sis') so this file does not trip its own gate when it ships in the
 * public mirror — exactly as leak-gate.mjs did before the split-out. That same
 * convention is how a ticket legitimately DISCUSSES a token shape without
 * leaking it: describe the shape or split the literal; never paste the value.
 * The guard's predicate is identical to the gate's, so anything the guard
 * refuses the gate would also have refused, and anything that passes the guard
 * passes the gate — the guard adds no new false-positive surface, it only moves
 * the same decision earlier (to the moment of writing).
 */

export const TOKENS = [
  { name: 'private project A (bot)',      re: new RegExp('saa' + 'sis', 'i') },
  { name: 'private project B (uploader)', re: new RegExp('img' + 'ixie', 'i') },
  { name: 'private project C',            re: new RegExp('map' + '_of_' + 'world', 'i') },
  { name: 'private project D',            re: new RegExp('job' + '_intel', 'i') },
  { name: 'private project E',            re: new RegExp('reddit' + '_marketing', 'i') },
  { name: 'private project F',            re: new RegExp('trump' + '[_-]muketika', 'i') },
  { name: 'private project G',            re: new RegExp('gpu-' + 'research-lab', 'i') },
  { name: 'private project H (win)',      re: new RegExp('shadow' + '[-_ ]studio', 'i') },
  // I–P (FEAT-104): the class the gate was blind to — private project names that
  // survived at HEAD in ticket prose because no token ever covered them. Each is
  // aliased in the docs as `external-project-<letter>`; the alias note below is
  // the only mapping key, and the real name deliberately appears NOWHERE in the
  // repo (this gate now enforces that). O/P are matched on their distinctive
  // stem so the short forms used in prose are caught too, not just the full name.
  { name: 'private project I (-> external-project-I)', re: new RegExp('workspace' + '-to-text', 'i') },
  { name: 'private project J (-> external-project-J)', re: new RegExp('discord' + '-mcp-bot', 'i') },
  { name: 'private project K (-> external-project-K)', re: new RegExp('\\b' + 'ani' + 'wait\\b', 'i') },
  { name: 'private project L (-> external-project-L)', re: new RegExp('chatbots' + '-tg', 'i') },
  { name: 'private project M (-> external-project-M)', re: new RegExp('crypto' + '_gem', 'i') },
  { name: 'private project N (-> external-project-N)', re: new RegExp('docs' + '-llm', 'i') },
  { name: 'private project O (-> external-project-O)', re: new RegExp('docker' + '_template', 'i') },
  { name: 'private project P (-> external-project-P)', re: new RegExp('remote' + '_wrapper', 'i') },
  // Q (FEAT-049, second pass): found by a DIFFERENT method than remembering a
  // name — enumerating every directory that actually exists under this
  // machine's project roots and grepping the tree for each one. It had survived
  // in an archived ticket's breadth-sweep notes since 2026-08-04.
  { name: 'private project Q (-> external-project-Q)', re: new RegExp('bug' + '-bounty', 'i') },
  // A CLASS THE PROJECT-NAME TOKENS DO NOT COVER (FEAT-049, second pass): words
  // lifted verbatim out of the user's own session transcripts. A verifier that
  // greps a REAL rollout needs a real needle, and the needle it hardcoded was a
  // client's name and their product line. The names below are that incident;
  // the general defence is the rule, not the list — a verifier must DERIVE its
  // needle from the artifact it discovered, never carry one in its source.
  { name: 'client name (transcript content)',   re: new RegExp('kna' + 'uf', 'i') },
  { name: 'client product (transcript content)', re: new RegExp('sad' + 'olin', 'i') },
  { name: 'client product (transcript content)', re: new RegExp('easy' + 'care', 'i') },
  { name: 'client term (transcript content)',    re: new RegExp('sperr' + 'grund', 'i') },
  { name: 'home path',                    re: new RegExp('/home/' + 'sa' + 'p\\b') },
  { name: 'encoded home path',            re: new RegExp('-home-' + 'sa' + 'p\\b') },
  { name: 'encoded win path',             re: new RegExp('C--Users-' + 'sa' + 'p\\b') },
  { name: 'username (bare word)',         re: new RegExp('\\b' + 'sa' + 'p' + '\\b') },
  { name: 'github handle',                re: new RegExp('sa' + 'pn1s', 'i') },
  { name: 'email',                        re: new RegExp('sa' + 'ptional', 'i') },
];

/**
 * THE ONE SANCTIONED EXCEPTION (FEAT-049 licence).
 *
 * Every token above is a leak everywhere — except the copyright line of the
 * LICENSE file, where the licensor's identity is the POINT rather than a slip.
 * PolyForm Noncommercial grants rights from "the licensor" and sends anyone
 * wanting commercial terms to that licensor; a licence naming nobody grants
 * from nobody and gives the reader no one to ask, which is precisely the
 * failure mode of a hand-written licence. The repository is published under
 * this handle, so the handle is public by construction the moment it ships.
 *
 * Scoped as narrowly as it can be, on purpose: ONE file, ONE token, and ONLY
 * on a line matching PolyForm's own `Required Notice:` form. The same handle
 * one line lower in LICENSE, or in any other file, still FAILS. This is an
 * exemption from a token, never a hole in the gate — allowed hits are counted
 * and REPORTED on every run (below), so the exception can never be silent.
 *
 * NOTE: this file-scoped exemption is meaningful only for the whole-repo gate.
 * The ticket-write guard scans ticket CONTENT (never LICENSE), so no allowance
 * applies there — a ticket carrying any token is refused, full stop.
 */
export const ALLOWED_HITS = [
  {
    file: 'LICENSE',
    token: 'github handle',
    line: /^Required Notice: Copyright \d{4} /,
    why: 'the licence must name an identifiable, contactable licensor to be worth anything',
  },
];

export const allowedHitFor = (rel, tokenName, line) =>
  ALLOWED_HITS.find((a) => a.file === rel && a.token === tokenName && a.line.test(line));

/* ────────────────────────────────────────────────────────────────────────
 * FEAT-130 — credential / secret / generic-email detection.
 *
 * The literal-string TOKENS above catch the user's own private artifacts
 * (project names, home path, handle). They catch ZERO credentials and only one
 * email by coincidence. This section adds the classes a public-bound commit
 * actually risks: API keys, tokens, private keys, secret assignments,
 * password-bearing connection strings, and any personal email.
 *
 * PRECISION IS THE HARD PART, not the patterns. This codebase is security-heavy
 * and full of LEGITIMATE mentions: tickets that name a token SHAPE, `sk-…`
 * SESSION-KEY slugs (`sk-notification-woken`), `*_TOKEN` constants (`MAX_TOKEN`,
 * `FUZZ_TOKEN`), documented dependency-maintainer emails, RFC-2606 fixture
 * addresses, systemd `user@1000.service` cgroup paths, the LICENSE notice line,
 * and the GitHub `noreply` committer identity. A gate that floods on those gets
 * `--no-verify`'d and is worse than none. So every matcher below is tuned to a
 * REAL secret's shape (high-entropy body, structured prefix) and skips
 * placeholders / code references / reserved domains. Proven low-false-positive
 * against the real tree (FEAT-130 worker log).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Structural placeholder MARKERS — a value containing any of these is a template,
 * never a live secret (`<your-key>`, `${VAR}`, `%TOKEN%`, `xxxx…`, `…`, `***`).
 */
const STRUCTURAL_PLACEHOLDER = /<[^>]*>|\$\{|\{\{|`|%[A-Za-z0-9_]+%|xxxx+|\.\.\.|…|\*\*\*+/;
/**
 * Dictionary placeholder WORDS. Only consulted for a value that has NO
 * high-entropy chunk (see below): `your-key-here`, `not-a-real-token`, `sample`.
 */
const PLACEHOLDER_WORD_ANY =
  /not[-_ ]?a[-_ ]?real|not[-_ ]?real|example|placeholder|redacted|dummy|sample|changeme|foobar|\bfake\b|\byour\b|xxx+|\bhere\b|\bTODO\b|goes[-_ ]?here|test[-_ ]?(?:token|key|secret|value)|dummy|replace[-_ ]?me/i;
/**
 * FEAT-130 round 4 — the placeholder decision is made PER-TOKEN, entropy FIRST.
 *
 * Round 3 anchored the test to the whole value but still consulted the structural
 * marker BEFORE entropy (`if (STRUCTURAL_PLACEHOLDER.test(s)) return true;` came
 * first). That let a benign marker override a co-located real secret: splicing a
 * structural marker (an `xxxx` run) INTO a single high-entropy alnum run waived
 * the whole value even though the run itself is a live credential (round-3 verifier
 * BROKEN #1). The decision must be made per-token: if ANY `[^A-Za-z0-9]`-delimited
 * run is itself secret-shaped, the value is a live secret — no marker elsewhere
 * (or spliced inside a different run) can waive it. Only when NO run is
 * secret-shaped do we consult the structural marker / placeholder word.
 *
 * Entropy therefore has to be a per-token property that a spliced marker cannot
 * fake AND that a marker run cannot satisfy. So `hasEntropyChunk` now requires
 * genuine CLASS DIVERSITY (dropping the old single-class `length >= 20` branch):
 * a run of identical characters (`xxxx…x`, a `***` marker, an em-dash fill) is
 * one class and is NOT entropy, so a pure placeholder still waives; but a real
 * mixed-case+digit body — even with `xxxx` spliced in — stays mixed-class and is
 * caught. A real credential is never a single repeated character; a value with
 * no marker and no placeholder word is never waived regardless (see below), so
 * this tightening removes waivers without ever hiding a live key.
 */
function hasEntropyChunk(v) {
  return String(v ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean).some((t) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(t)).length;
    return (t.length >= 12 && classes >= 2) || (t.length >= 8 && classes >= 3);
  });
}
function isPlaceholder(v) {
  const s = String(v ?? '').trim();
  if (!s) return true;
  if (hasEntropyChunk(s)) return false; // a real high-entropy run → NOT a placeholder, even if a marker is spliced beside it
  if (STRUCTURAL_PLACEHOLDER.test(s)) return true;
  return PLACEHOLDER_WORD_ANY.test(s);
}

/** A value that is a code reference / interpolation, not a hard-coded literal. */
const CODE_REF =
  /^(?:process\.env|import\.meta|os\.environ|Deno\.env|getenv|\$\{|\$[A-Za-z_(]|%[A-Za-z_]+%|<%|\{\{|`|secrets?\.|config\.|env\.|opts?\.|this\.|process\[)/i;
const isCodeRef = (v) => CODE_REF.test(String(v ?? ''));

/**
 * Emails that are NOT a personal-email leak. Reserved/documentation/test domains
 * (RFC 2606 + `.local`/`.localhost`, systemd `.service` pseudo-hosts), the
 * structurally-public noreply identities, and the documented third-party
 * dependency-maintainer addresses already present in the supply-chain audit
 * records (Playwright/Microsoft, Serena/Oraios AI) — public by publication, not
 * a personal slip. Adding a new dependency's maintainer email will (correctly)
 * fail-closed until it is reviewed and added here.
 */
export const ALLOWED_EMAIL_DOMAINS = [
  'invalid', 'test', 'example', 'local', 'localhost', 'service',
  'example.com', 'example.org', 'example.net',
  'users.noreply.github.com', 'noreply.github.com',
  'microsoft.com', 'oraios-ai.de',
];
const ALLOWED_EMAIL_EXACT = ['noreply@github.com', 'noreply@anthropic.com', 'git@github.com'];
/** The ONE sanctioned committer identity for a public repo: the GitHub noreply. */
export const NOREPLY_IDENTITY_RE = /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/i;

export function emailAllowed(addr) {
  const a = String(addr ?? '').toLowerCase();
  if (ALLOWED_EMAIL_EXACT.includes(a)) return true;
  const domain = a.split('@')[1] ?? '';
  return ALLOWED_EMAIL_DOMAINS.some((e) => domain === e || domain.endsWith('.' + e));
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g;

/**
 * Key/token SHAPES. Each `re` is tuned so a ticket naming the shape or a repo
 * slug does NOT trip it — the discriminator is a real secret's high-entropy
 * body, not merely the prefix.
 *   - sk-: requires a ≥24-char CONTINUOUS alphanumeric run after `sk-`. Repo
 *     `sk-…` slugs are dash-separated words (max run 13), so they never match;
 *     a real OpenAI (48) / Anthropic (~93) key body always contains such a run.
 *   - gh*_ / AKIA / xox: require the full high-entropy body length, never the
 *     bare prefix a ticket would write.
 *   - PEM: the literal private-key header; a ticket discusses it by NAME.
 *   - Bearer: a long token body; `Bearer <token>` / placeholders are skipped.
 */
const KEY_SHAPES = [
  { name: 'openai/anthropic api key (sk-)', re: /\bsk-[A-Za-z0-9_-]*?[A-Za-z0-9]{24,}/, guard: (m) => !isPlaceholder(m) },
  { name: 'github token (gh*_)',            re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'aws access key id (AKIA/ASIA)',  re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'slack token (xox…)',             re: /\bxox[baprs]-[A-Za-z0-9]{8,}-[A-Za-z0-9]{8,}[A-Za-z0-9-]*/ },
  { name: 'private key (PEM header)',       re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'bearer token',                   re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, guard: (m) => !isPlaceholder(m) },
  // FEAT-130 round 3 — major provider formats the round-2 verifier proved slip
  // past scanLine (each is a REAL secret under the "any real-shaped secret" bar).
  // Bodies are pinned to the provider's real length/charset so a ticket writing
  // the shape with an ellipsis (`AIza…`) does NOT trip. Note Stripe/GitHub use an
  // UNDERSCORE (`sk_`, `github_pat_`) that the `sk-`/`gh[pousr]_` matchers miss.
  // The trailing terminator is a NEGATIVE LOOKAHEAD, not `\b`: an AIza body may
  // end in `-` or `_`, and `\b` fails after a non-word char, so a key whose 35th
  // body char is a hyphen was missed (round-3 verifier BROKEN #3). `(?![body])`
  // pins the body to exactly 35 chars regardless of what the last one is.
  { name: 'google api key (AIza)',          re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { name: 'stripe key (sk_/rk_ live/test)', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { name: 'github fine-grained token',      re: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/ },
  { name: 'sendgrid api key (SG.)',         re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: 'npm token (npm_)',               re: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { name: 'pypi token (pypi-AgE)',          re: /\bpypi-AgE[A-Za-z0-9_+/=-]{20,}/ },
  { name: 'json web token (jwt)',           re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, guard: (m) => !isPlaceholder(m) },
];

// Secret assignments. Two accepted forms so precision stays high:
//   (a) dotenv-style — an ALL-CAPS KEY=value with no spaces (env files),
//   (b) a QUOTED literal value.
// Bare `TOKEN` is deliberately NOT a key here (the repo is full of innocuous
// *_TOKEN constants); only high-signal secret key names are matched.
const SECRET_KEY_SRC =
  '(?:password|passwd|secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bot[_-]?token|slack[_-]?token|github[_-]?token|gh[_-]?token|npm[_-]?token)';
// FEAT-130 round 4 — all three assignment regexes carry the `g` flag and are
// iterated with `matchAll` (below), never `.exec` once. `.exec` returned only the
// FIRST assignment on a line, so a placeholder assignment written before a real
// one masked it (`PASSWORD=your-key-here; PASSWORD=<real>` → round-3 verifier
// BROKEN #2). Iterating every match on the line closes that: a benign first
// assignment can no longer hide a malicious later one.
const ASSIGN_DOTENV = new RegExp('(?:^|[\\s;])([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|APIKEY|ACCESS_?KEY|CLIENT_?SECRET|PRIVATE_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|BOT_?TOKEN|SLACK_?TOKEN|GITHUB_?TOKEN|GH_?TOKEN|NPM_?TOKEN)[A-Z0-9_]*)=([^\\s"\'#]{6,})', 'g');
const ASSIGN_QUOTED = new RegExp(SECRET_KEY_SRC + '\\s*[:=]\\s*(["\'])([^"\']{6,})\\1', 'ig');
// FEAT-130 round 2 — the recall gap the round-1 verify hit: a LOWERCASE,
// UNQUOTED secret assignment (a lowercase api-key/password `=`/`:` a bare
// high-entropy value) slipped both forms above (dotenv needs ALL-CAPS, quoted
// needs quotes). This closes it for any case and either `=`/`:` separator, on
// the SAME high-signal key list — bare `token=`/`key=` are still NOT keys, so
// URLs-as-docs and config prose do not flood. The value char class stops at
// whitespace, quotes, comment `#`, common delimiters AND markdown/code
// punctuation (backtick, brackets, angle) so a prose fragment like
// `...HasSecret:true` does not drag trailing punctuation into a 6-char "value".
// Extra precision on top of isSecretValue: an unquoted bare value must ALSO look
// secret-shaped (looksSecretish) so a plain prose word (a config key documented
// as "required"/"optional") is not mistaken for a live credential.
const ASSIGN_BARE = new RegExp(SECRET_KEY_SRC + '\\s*[:=]\\s*([^\\s"\'`#,;<>{}()\\[\\]]{6,})', 'ig');
// proto://user:password@host — the inline password is the leak.
const CONN_STRING = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]+)@[^\s/'"]+/;
const CONN_PLACEHOLDER = /^(?:pass|passwd|password|user|username|secret|token|xxx+|changeme)$/i;

/** True when an assignment/connstring VALUE looks like a live secret literal. */
function isSecretValue(v) {
  const s = String(v ?? '');
  if (s.length < 6) return false;
  if (/\s/.test(s)) return false;          // prose, not a secret
  if (/^\d+$/.test(s)) return false;        // numeric literal (MAX_TOKEN = 200)
  if (isPlaceholder(s)) return false;
  if (isCodeRef(s)) return false;
  if (!/[A-Za-z0-9]/.test(s)) return false;
  return true;
}

/**
 * A stricter shape test for the UNQUOTED bare-assignment class (FEAT-130 r2).
 * A dotenv/quoted secret is a deliberate declaration; a bare `key: value` in
 * prose or config is far more common, so its value must actually look like a
 * credential — ≥2 character classes (a real key/password mixes case+digits) or
 * a long high-entropy run — before we call it a leak. This keeps a documented
 * config key (value "required"/"optional" — single-class dictionary words) from
 * flooding while still catching a real mixed-case+digit key or password body.
 */
function looksSecretish(v) {
  const s = String(v ?? '');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  return classes >= 2 || s.length >= 24;
}

/**
 * Scan ONE line for credential/secret/email shapes. Returns `[{ token, match }]`.
 * Shared by the commit-time gate and the ticket-write guard so the two can never
 * disagree — exactly as the literal TOKENS list is shared.
 */
export function scanSecrets(line) {
  const out = [];
  const s = String(line ?? '');
  for (const k of KEY_SHAPES) {
    const m = s.match(k.re);
    if (m && (!k.guard || k.guard(m[0]))) out.push({ token: k.name, match: m[0] });
  }
  // Iterate EVERY assignment on the line (not just the first) so a placeholder
  // written before a real secret cannot mask it. Dedupe by the reported key label
  // so the same key matched by two forms (dotenv AND bare) reports once.
  const seenAssign = new Set();
  const pushAssign = (label) => {
    if (seenAssign.has(label)) return;
    seenAssign.add(label);
    out.push({ token: 'secret assignment', match: label });
  };
  for (const a of s.matchAll(ASSIGN_DOTENV)) {
    if (isSecretValue(a[2])) pushAssign(`${a[1]}=…`);
  }
  for (const a of s.matchAll(ASSIGN_QUOTED)) {
    if (isSecretValue(a[2])) pushAssign(`${a[0].split(/[:=]/)[0].trim()}=…`);
  }
  for (const a of s.matchAll(ASSIGN_BARE)) {
    if (isSecretValue(a[1]) && looksSecretish(a[1])) pushAssign(`${a[0].split(/[:=]/)[0].trim()}=…`);
  }
  const c = CONN_STRING.exec(s);
  if (c && !CONN_PLACEHOLDER.test(c[1]) && !isPlaceholder(c[1]) && !isCodeRef(c[1])) {
    out.push({ token: 'connection string password', match: c[0].replace(c[1], '…') });
  }
  for (const m of s.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0])) out.push({ token: 'personal email', match: m[0] });
  }
  return out;
}

/**
 * Scan raw text for high-signal KEY/PEM shapes ONLY (no email/assignment/token
 * classes). Used to look INTO binary / skipped files (fonts, pdf, minified
 * blobs, NUL-containing files) for an embedded credential without the
 * false-positive noise the other classes would produce on binary noise. A
 * secret in a binary was the leak-gate's blind spot before FEAT-130.
 */
export function scanKeyShapes(text) {
  const out = [];
  const s = String(text ?? '');
  for (const k of KEY_SHAPES) {
    for (const m of s.matchAll(new RegExp(k.re.source, k.re.flags.includes('g') ? k.re.flags : k.re.flags + 'g'))) {
      if (!k.guard || k.guard(m[0])) { out.push({ token: k.name, match: m[0] }); break; }
    }
  }
  return out;
}

/**
 * FEAT-130 round 3 — scan binary / NUL-containing / image blob content for
 * credential shapes. The round-2 gate downgraded any NUL-bearing or
 * binary-extension blob (and skipped images entirely) to KEY/PEM-only scanning,
 * so a staged `apikey=<body>` + one trailing NUL, or a `github_pat_` inside a
 * text `.svg`, shipped. This runs the KEY/PEM/provider shapes across the whole
 * blob AND the assignment / connection-string classes over each newline/NUL-
 * delimited chunk. EMAIL is deliberately excluded — the generic email pattern
 * floods on binary noise (that was the reason binary got the narrow scan). A
 * blob's chunks are deduped so the same embedded key is reported once.
 */
export function scanBinary(text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (token, match) => {
    const k = `${token} ${match}`;
    if (!seen.has(k)) { seen.add(k); out.push({ token, match }); }
  };
  for (const { token, match } of scanKeyShapes(s)) push(token, match);
  for (const chunk of s.split(/[\r\n\x00]+/)) {
    for (const h of scanSecrets(chunk)) {
      if (h.token === 'personal email') continue; // floods on binary noise
      push(h.token, h.match);
    }
  }
  return out;
}

/**
 * The unified per-line matcher: literal private TOKENS + credential/secret/email
 * shapes. Returns `[{ token, match }]`. This is THE matcher the commit-time gate
 * iterates and the ticket-write guard builds on.
 */
export function scanLine(line) {
  const out = [];
  const s = String(line ?? '');
  for (const t of TOKENS) {
    const m = s.match(t.re);
    if (m) out.push({ token: t.name, match: m[0] });
  }
  out.push(...scanSecrets(s));
  return out;
}

/**
 * Scan a committer identity (name + email). The ONLY sanctioned identity for a
 * public repo is the GitHub noreply (numeric-id + handle @ users.noreply.github.com);
 * when the email is that shape the whole identity is waived (the name is the
 * handle by construction). Any other identity is scanned in full — a personal
 * email as committer is caught. Returns `[{ token, match }]`.
 */
export function scanIdentity(name, email) {
  const e = String(email ?? '').trim();
  if (NOREPLY_IDENTITY_RE.test(e)) return [];
  const out = [];
  if (e && !emailAllowed(e)) out.push({ token: 'personal email (committer identity)', match: e });
  for (const hit of scanLine(e)) out.push({ token: `${hit.token} (committer identity)`, match: hit.match });
  for (const hit of scanLine(String(name ?? ''))) out.push({ token: `${hit.token} (committer name)`, match: hit.match });
  return out;
}

/**
 * Scan a block of text for private tokens AND credential/secret/email shapes.
 * Returns one entry per offending (line, token) pair: `{ lineNo (1-based), line,
 * token }`. Callers get the raw material to report a refusal — the same
 * file:line + token-class shape the gate prints — without re-implementing the
 * match. No ALLOWED_HITS logic here: this is for scanning content that has no
 * sanctioned exemption (ticket bodies, commit messages).
 */
export function findLeaks(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    for (const { token } of scanLine(line)) out.push({ lineNo: i + 1, line, token });
  });
  return out;
}
