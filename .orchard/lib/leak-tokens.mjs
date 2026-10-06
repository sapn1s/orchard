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
  { kind: 'project', name: 'private project A (bot)',      re: new RegExp('saa' + 'sis', 'i') },
  { kind: 'project', name: 'private project B (uploader)', re: new RegExp('img' + 'ixie', 'i') },
  { kind: 'project', name: 'private project C',            re: new RegExp('map' + '_of_' + 'world', 'i') },
  { kind: 'project', name: 'private project D',            re: new RegExp('job' + '_intel', 'i') },
  { kind: 'project', name: 'private project E',            re: new RegExp('reddit' + '_marketing', 'i') },
  { kind: 'project', name: 'private project F',            re: new RegExp('trump' + '[_-]muketika', 'i') },
  { kind: 'project', name: 'private project G',            re: new RegExp('gpu-' + 'research-lab', 'i') },
  { kind: 'project', name: 'private project H (win)',      re: new RegExp('shadow' + '[-_ ]studio', 'i') },
  // I–P (FEAT-104): the class the gate was blind to — private project names that
  // survived at HEAD in ticket prose because no token ever covered them. Each is
  // aliased in the docs as `external-project-<letter>`; the alias note below is
  // the only mapping key, and the real name deliberately appears NOWHERE in the
  // repo (this gate now enforces that). O/P are matched on their distinctive
  // stem so the short forms used in prose are caught too, not just the full name.
  { kind: 'project', name: 'private project I (-> external-project-I)', re: new RegExp('workspace' + '-to-text', 'i') },
  { kind: 'project', name: 'private project J (-> external-project-J)', re: new RegExp('discord' + '-mcp-bot', 'i') },
  { kind: 'project', name: 'private project K (-> external-project-K)', re: new RegExp('\\b' + 'ani' + 'wait\\b', 'i') },
  { kind: 'project', name: 'private project L (-> external-project-L)', re: new RegExp('chatbots' + '-tg', 'i') },
  { kind: 'project', name: 'private project M (-> external-project-M)', re: new RegExp('crypto' + '_gem', 'i') },
  { kind: 'project', name: 'private project N (-> external-project-N)', re: new RegExp('docs' + '-llm', 'i') },
  { kind: 'project', name: 'private project O (-> external-project-O)', re: new RegExp('docker' + '_template', 'i') },
  { kind: 'project', name: 'private project P (-> external-project-P)', re: new RegExp('remote' + '_wrapper', 'i') },
  // Q (FEAT-049, second pass): found by a DIFFERENT method than remembering a
  // name — enumerating every directory that actually exists under this
  // machine's project roots and grepping the tree for each one. It had survived
  // in an archived ticket's breadth-sweep notes since 2026-08-04.
  { kind: 'project', name: 'private project Q (-> external-project-Q)', re: new RegExp('bug' + '-bounty', 'i') },
  // A CLASS THE PROJECT-NAME TOKENS DO NOT COVER (FEAT-049, second pass): words
  // lifted verbatim out of the user's own session transcripts. A verifier that
  // greps a REAL rollout needs a real needle, and the needle it hardcoded was a
  // client's name and their product line. The names below are that incident;
  // the general defence is the rule, not the list — a verifier must DERIVE its
  // needle from the artifact it discovered, never carry one in its source.
  { kind: 'client', name: 'client name (transcript content)',   re: new RegExp('kna' + 'uf', 'i') },
  { kind: 'client', name: 'client product (transcript content)', re: new RegExp('sad' + 'olin', 'i') },
  { kind: 'client', name: 'client product (transcript content)', re: new RegExp('easy' + 'care', 'i') },
  { kind: 'client', name: 'client term (transcript content)',    re: new RegExp('sperr' + 'grund', 'i') },
  { kind: 'identity', name: 'home path',                    re: new RegExp('/home/' + 'sa' + 'p\\b') },
  { kind: 'identity', name: 'encoded home path',            re: new RegExp('-home-' + 'sa' + 'p\\b') },
  { kind: 'identity', name: 'encoded win path',             re: new RegExp('C--Users-' + 'sa' + 'p\\b') },
  { kind: 'identity', name: 'username (bare word)',         re: new RegExp('\\b' + 'sa' + 'p' + '\\b') },
  { kind: 'identity', name: 'github handle',                re: new RegExp('sa' + 'pn1s', 'i') },
  { kind: 'identity', name: 'email',                        re: new RegExp('sa' + 'ptional', 'i') },
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
// FEAT-130 round 5 — the allow list is SPLIT by match discipline, because a blanket
// `domain === e || domain.endsWith('.' + e)` waived any SUBDOMAIN of a registered
// maintainer domain (round-2/3 verifier: a personal address at a SUB-host of a
// maintainer domain — `alice@corp.<the-domain>` — slipped through). A registered domain must match
// EXACTLY; only the RESERVED pseudo-domains — RFC-2606 reserved TLDs and the
// systemd/mDNS pseudo-hosts, which can never be a real deliverable personal
// address at ANY depth — keep the suffix match (systemd `user@x.service`,
// `host.local`, `foo@bar.example.com` are all still non-personal).
export const ALLOWED_EMAIL_SUFFIX = [
  'invalid', 'test', 'example', 'local', 'localhost', 'service',
  'example.com', 'example.org', 'example.net',
];
// REGISTERED, real-world-deliverable domains that are public by PUBLICATION, not a
// personal slip (the structurally-public noreply identities and the documented
// dependency-maintainer addresses). EXACT domain match only — a personal address at
// a SUBDOMAIN of one of these is NOT waived.
export const ALLOWED_EMAIL_DOMAIN_EXACT = [
  'users.noreply.github.com', 'noreply.github.com',
  'microsoft.com', 'oraios-ai.de',
];
// Kept for back-compat with any consumer importing the old flat list (it is the
// union of the two lists above; new code should use the split lists).
export const ALLOWED_EMAIL_DOMAINS = [...ALLOWED_EMAIL_SUFFIX, ...ALLOWED_EMAIL_DOMAIN_EXACT];
const ALLOWED_EMAIL_EXACT = ['noreply@github.com', 'noreply@anthropic.com', 'git@github.com'];
/** The ONE sanctioned committer identity for a public repo: the GitHub noreply. */
export const NOREPLY_IDENTITY_RE = /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/i;

export function emailAllowed(addr) {
  const a = String(addr ?? '').toLowerCase();
  if (ALLOWED_EMAIL_EXACT.includes(a)) return true;
  const domain = a.split('@')[1] ?? '';
  if (ALLOWED_EMAIL_DOMAIN_EXACT.includes(domain)) return true;      // exact only — no subdomain waiver
  return ALLOWED_EMAIL_SUFFIX.some((e) => domain === e || domain.endsWith('.' + e));
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
// FEAT-130 round 8 — the key/value SEPARATOR is a property of the SYNTAX, not of
// each key (ARCH-010), so it is expressed ONCE here and reused by every
// assignment regex below. Besides bare `key=value` / `key: value`, it accepts a
// QUOTED KEY: in JSON/YAML the key's own closing quote sits BETWEEN the key name
// and the `:` (`"token": "secret"`), which the previous `\s*[:=]` anchoring could
// not cross — so every quoted-key config secret (`"password"`, `"api_key"`,
// `"token"`, …) was silently MISSED (round-7 verifier finding). The optional
// `["']?` consumes that closing quote; the opening quote before the key needs no
// handling (no matcher left-anchors the key to an alnum char). One point of
// truth, not a duplicated pattern per key.
const KV_SEP = '["\']?\\s*[:=]\\s*';
// FEAT-130 round 4 — all three assignment regexes carry the `g` flag and are
// iterated with `matchAll` (below), never `.exec` once. `.exec` returned only the
// FIRST assignment on a line, so a placeholder assignment written before a real
// one masked it (`PASSWORD=your-key-here; PASSWORD=<real>` → round-3 verifier
// BROKEN #2). Iterating every match on the line closes that: a benign first
// assignment can no longer hide a malicious later one.
const ASSIGN_DOTENV = new RegExp('(?:^|[\\s;])([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|APIKEY|ACCESS_?KEY|CLIENT_?SECRET|PRIVATE_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|BOT_?TOKEN|SLACK_?TOKEN|GITHUB_?TOKEN|GH_?TOKEN|NPM_?TOKEN)[A-Z0-9_]*)=([^\\s"\'#]{6,})', 'g');
const ASSIGN_QUOTED = new RegExp(SECRET_KEY_SRC + KV_SEP + '(["\'])([^"\']{6,})\\1', 'ig');
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
const ASSIGN_BARE = new RegExp(SECRET_KEY_SRC + KV_SEP + '([^\\s"\'`#,;<>{}()\\[\\]]{6,})', 'ig');
// FEAT-130 round 6 — GENERIC (high-frequency, low-signal) secret key synonyms.
// Kept in a SEPARATE list from SECRET_KEY_SRC because these fire only behind the
// strict `looksHighEntropySecret` floor (above); the high-signal keys keep their
// looser floor. A leading negative-lookbehind `(?<![A-Za-z0-9_])` anchors the key
// to a word boundary so `oauth=`/`mysession=`/`author:` do NOT match `auth`/
// `session`/`auth`. The key is captured (group 1) for the reported label.
const GENERIC_SECRET_KEY_SRC =
  '(?<![A-Za-z0-9_])(token|auth|pwd|passphrase|credentials?|cred|cookie|session|api[_-]?secret|secret[_-]?token|private[_-]?token|session[_-]?(?:token|key|secret)|client[_-]?key|access[_-]?secret)';
const ASSIGN_GENERIC_BARE = new RegExp(GENERIC_SECRET_KEY_SRC + KV_SEP + '([^\\s"\'`#,;<>{}()\\[\\]]{18,})', 'ig');
const ASSIGN_GENERIC_QUOTED = new RegExp(GENERIC_SECRET_KEY_SRC + KV_SEP + '(["\'])([^"\']{18,})\\2', 'ig');
// proto://user:password@host — the inline password is the leak. FEAT-130 round 5:
// the userinfo user part is `*` not `+`, so a PASSWORD-ONLY URL (`redis://:pass@host`,
// the common redis/amqp shape where the username is empty) is matched too — the
// round-2 verifier MEDIUM. The password capture still requires ≥1 char and the
// placeholder/code-ref guards below still gate it, so an empty-user URL with a
// benign or templated password does not flood.
const CONN_STRING = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]*:([^\s:/@]+)@[^\s/'"]+/;
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
// FEAT-130 round 12 — the SINGLE-CLASS length threshold. A value with ≥2 char
// classes is always secret-ish; a single-class value (all lowercase, all caps, all
// digits) needs a minimum length to distinguish a real passphrase / long token from
// a short dictionary/type word. Round 10 set this at 24, which regressed recall: the
// quoted high-signal path (which pre-round-10 gated on isSecretValue ALONE) stopped
// firing on real single-class passphrases of 17–23 chars (`correcthorsebattery`,
// `supersecretpasswd`). The round-9 schema/OpenAPI false-positive WORDS it was meant
// to reject — `string`,`boolean`,`integer`,`number`,`required`,`optional` — are all
// ≤ 8 chars, so a threshold anywhere in 9..16 separates the two sets cleanly; 16 is
// the conservative end of that gap (fewest new false positives). Measured flip:
// single-class value CAUGHT at ≥16, MISSED at ≤15 — so the narrowest real single-class
// secret still missed is a 15-char one; every ≥2-class value is caught at any length ≥6.
// Expressed ONCE here and shared by both the bare and quoted high-signal forms via
// isHighSignalSecretValue (ARCH-010) — the two forms can never drift to different tunings.
const SINGLE_CLASS_MIN_LEN = 16;
function looksSecretish(v) {
  const s = String(v ?? '');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  return classes >= 2 || s.length >= SINGLE_CLASS_MIN_LEN;
}

/**
 * The value predicate for the HIGH-SIGNAL assignment class, expressed ONCE and
 * shared by BOTH value forms — bare (`password: value`) and quoted
 * (`"password": "value"`) — per ARCH-010, exactly as `KV_SEP` shares the key/value
 * separator. FEAT-130 round 10: the quoted form previously gated on `isSecretValue`
 * ALONE while the bare form already gated on `isSecretValue && looksSecretish`, so a
 * single-class type-name value (`"password": "string"`, `"secret": "boolean"`) in an
 * OpenAPI / JSON-schema / doc file cleared the quoted path and FALSE-POSITIVED — the
 * cry-wolf failure the round-6 value-shape floor exists to prevent. Applying the
 * same `looksSecretish` shape floor to the quoted path closes it while a genuinely
 * secret-looking quoted value (a real provider token / mixed-class password) still
 * fires. `looksSecretish` is DELIBERATELY looser than the round-6 generic floor:
 * the high-signal key names (`password`, `api_key`, `client_secret`, …) rarely name
 * an ordinary variable, so their values need only look non-trivial (≥2 char classes
 * or ≥24 chars), not clear the strict 3-class/entropy floor the low-signal generic
 * keys require.
 */
function isHighSignalSecretValue(v) {
  return isSecretValue(v) && looksSecretish(v);
}

/* ────────────────────────────────────────────────────────────────────────
 * FEAT-130 round 6 — GENERIC assignment-key detection, behind a VALUE-SHAPE FLOOR.
 *
 * The high-signal `SECRET_KEY_SRC` keys above (password, api_key, client_secret,
 * …) are safe to match on their key name alone because those words rarely appear
 * as an ordinary variable. The GENERIC synonyms the user asked for in round 6 —
 * bare `token`, `auth`, `pwd`, `cred`, `cookie`, `session`, `passphrase` — are the
 * OPPOSITE: this repo is full of code that legitimately writes them (`token`,
 * `session`, `auth`, `cookie` fill src/server and public/app.js). Matching them on
 * the key name alone would flood the gate, and a noisy gate gets `--no-verify`'d —
 * a worse outcome than the recall we gain. So the whole point of this class is the
 * FLOOR: the VALUE must look like an actual random secret, never an identifier,
 * word, path, expression, or short literal.
 *
 * THE FLOOR (both a length minimum AND an entropy/charset test, deliberately
 * strict — see the round-6 whole-tree false-positive measurement in the ticket):
 *   - length ≥ 18 (real API tokens/keys are long; kills `token=abc`, `auth=basic`,
 *     `pwd=x`, and every short identifier reference),
 *   - passes `isSecretValue` (so a placeholder `<redacted>`, a code-ref/template
 *     `$PASSWORD` / `${env.AUTH}` / `process.env.X`, prose with a space, or a bare
 *     number is already excluded),
 *   - character-CLASS diversity = 3 (lowercase AND uppercase AND digit all
 *     present) — a random credential mixes all three; identifiers, dictionary
 *     words, filesystem paths, lowercase-hex digests (git SHAs, md5/sha) and
 *     base64-of-lowercase do NOT, so they never trip this class,
 *   - Shannon entropy ≥ 3.2 bits/char (guards a long, 3-class-but-repetitive value
 *     like a templated `Aaaa1Bbbb2Cccc3…` from passing on charset alone).
 * A value that already matches a known KEY_SHAPE (an `sk-`/`ghp_`/`AIza…` key
 * assigned to a generic `token=`) is NOT re-reported here — that secret is already
 * caught by its provider matcher; double-reporting it would just be noise.
 * ──────────────────────────────────────────────────────────────────────── */
function shannonBits(s) {
  const str = String(s ?? '');
  const n = str.length;
  if (!n) return 0;
  const freq = new Map();
  for (const c of str) freq.set(c, (freq.get(c) ?? 0) + 1);
  let e = 0;
  for (const c of freq.values()) { const p = c / n; e -= p * Math.log2(p); }
  return e;
}
function looksHighEntropySecret(v) {
  const s = String(v ?? '');
  if (s.length < 18) return false;                 // real tokens are long
  if (!isSecretValue(s)) return false;             // placeholder / code-ref / prose / numeric
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length;
  if (classes < 3) return false;                   // random secrets mix all three; identifiers/words/paths/hex do not
  if (shannonBits(s) < 3.2) return false;          // a long-but-repetitive 3-class value is not a secret
  return true;
}
/**
 * FEAT-156 round 3 — EVERY distinct match of `re` in `s`, never just the first.
 *
 * `s.match(re)` without the `g` flag returns only the FIRST occurrence. Every
 * scanner here used it, which made each (pattern, line) pair ONE decision taken
 * on whichever occurrence came first: a waived or placeholder occurrence could
 * then hide a different, real one later on the same line. Concretely (cross-
 * provider clean-room verify, run 01a0ed77): a project token whose regex
 * admits two spellings recorded only the first; a `match:` allowlist entry for
 * that approved spelling cleared the line's single hit and an UNAPPROVED second
 * spelling of the same foreign name committed. The same shape hid a real key
 * behind a placeholder key (`guard` rejected the first match, the second was
 * never looked at) and a real connection-string password behind a placeholder
 * one. So every scanner iterates all matches, deduped by matched value, and
 * each distinct value is its own hit, judged on its own.
 */
/**
 * FEAT-156 round 4 — THE one matcher every scanner in this module goes through.
 *
 * Round 3's `matchAll` still lost matches, because `matchAll` is NON-OVERLAPPING:
 * it resumes at the END of each match, so a candidate that is then SKIPPED
 * (placeholder, guard-rejected, allowed email) had already consumed text that
 * could START another candidate. Cross-provider verify run 01a0ed84:
 * `postgres://u:password@mysql://u:<real>@h2/db` — the placeholder URL's greedy
 * tail swallowed the real URL's scheme, the placeholder was skipped, and the real
 * credential was never seen (raw gate, agent guard and dashboard all passed it).
 *
 * The design that closes the whole family, not that regex:
 *   1. CANDIDATES AT EVERY START POSITION. After any match the search resumes at
 *      `match.index + 1`, never at its end — so no candidate, recorded or not,
 *      can consume the start of another.
 *   2. EACH CANDIDATE JUDGED ALONE by `accept` (the scanner's guard / placeholder
 *      / allowed-email predicate).
 *   3. The only candidates dropped are exact duplicates by value and pure
 *      SUB-SPANS of an ACCEPTED candidate of the same pattern — text that is
 *      literally inside a hit already being reported. A rejected candidate
 *      shadows nothing.
 * Per start the engine yields its preferred (greedy) match; every guard used here
 * is monotone in the span (a longer match of the same start contains every
 * high-entropy chunk of a shorter one), so the preferred match is the strictest.
 */
function scanAll(re, s, accept = () => true) {
  const str = String(s ?? '');
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const acc = [];
  let i = 0;
  while (i <= str.length) {
    g.lastIndex = i;
    const m = g.exec(str);
    if (!m) break;
    if (m[0] !== '' && accept(m)) acc.push(m);
    i = m.index + 1;
  }
  // `acc` is in strictly increasing start order (one candidate per start), so
  // "inside an earlier accepted candidate" is just "ends no later than the
  // furthest end seen so far" — O(k), not the O(k²) pairwise check.
  const seen = new Set();
  const out = [];
  let maxEnd = -1;
  for (const c of acc) {
    const end = c.index + c[0].length;
    const inside = end <= maxEnd;
    if (end > maxEnd) maxEnd = end;
    if (inside || seen.has(c[0])) continue;
    seen.add(c[0]);
    out.push(c);
  }
  return out;
}

/** True when a value is ALREADY a known provider KEY_SHAPE (so don't double-report). */
function valueMatchesKnownShape(v) {
  const s = String(v ?? '');
  return KEY_SHAPES.some((k) => scanAll(k.re, s, (m) => !k.guard || k.guard(m[0])).length > 0);
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
    for (const m of scanAll(k.re, s, (x) => !k.guard || k.guard(x[0]))) out.push({ token: k.name, match: m[0] });
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
  for (const a of scanAll(ASSIGN_DOTENV, s, (x) => isSecretValue(x[2]))) pushAssign(`${a[1]}=…`);
  for (const a of scanAll(ASSIGN_QUOTED, s, (x) => isHighSignalSecretValue(x[2]))) {
    pushAssign(`${a[0].split(/[:=]/)[0].replace(/["']/g, '').trim()}=…`);
  }
  for (const a of scanAll(ASSIGN_BARE, s, (x) => isHighSignalSecretValue(x[1]))) {
    pushAssign(`${a[0].split(/[:=]/)[0].replace(/["']/g, '').trim()}=…`);
  }
  // FEAT-130 round 6 — GENERIC key synonyms, gated by the strict value-shape floor
  // (length ≥ 18, all three char classes, entropy ≥ 3.2), and NOT re-reporting a
  // value already caught as a known provider KEY_SHAPE.
  for (const a of scanAll(ASSIGN_GENERIC_BARE, s, (x) => looksHighEntropySecret(x[2]) && !valueMatchesKnownShape(x[2]))) pushAssign(`${a[1]}=…`);
  for (const a of scanAll(ASSIGN_GENERIC_QUOTED, s, (x) => looksHighEntropySecret(x[3]) && !valueMatchesKnownShape(x[3]))) pushAssign(`${a[1]}=…`);
  for (const c of scanAll(CONN_STRING, s, (x) => !CONN_PLACEHOLDER.test(x[1]) && !isPlaceholder(x[1]) && !isCodeRef(x[1]))) {
    out.push({ token: 'connection string password', match: c[0].replace(c[1], '…') });
  }
  for (const m of scanAll(EMAIL_RE, s, (x) => !emailAllowed(x[0]))) out.push({ token: 'personal email', match: m[0] });
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
    const [m] = scanAll(k.re, s, (x) => !k.guard || k.guard(x[0]));
    if (m) out.push({ token: k.name, match: m[0] });
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
  // Every distinct occurrence of every token is its OWN hit (FEAT-156 round 3):
  // a waiver judged on one spelling can never clear a different one.
  for (const t of TOKENS) {
    for (const m of scanAll(t.re, s)) out.push({ token: t.name, match: m[0] });
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

/* ────────────────────────────────────────────────────────────────────────
 * FEAT-156 — the two waivers a TARGET repo can get, and the classes neither
 * can ever touch.
 *
 * Every waiver below is REPORTED by the gate on every run (never silent), and
 * neither can reach a credential: a waiver is an exemption from a WORD, never a
 * hole in the secret scan.
 * ──────────────────────────────────────────────────────────────────────── */

/** Credential / secret classes — never waivable by anything (FEAT-156). */
export const CREDENTIAL_CLASSES = new Set([
  ...KEY_SHAPES.map((k) => k.name),
  'secret assignment',
  'connection string password',
]);

const tokenByName = new Map();
for (const t of TOKENS) if (!tokenByName.has(t.name)) tokenByName.set(t.name, t.kind);

/**
 * The kind of a hit label: 'project' | 'client' | 'identity' (a literal TOKEN),
 * 'credential' (a secret shape), 'email' (personal email), or null (unknown).
 */
export function tokenKindOf(label) {
  if (tokenByName.has(label)) return tokenByName.get(label);
  if (CREDENTIAL_CLASSES.has(label)) return 'credential';
  if (label === 'personal email') return 'email';
  return null;
}

const nonGlobal = (re) => new RegExp(re.source, re.flags.replace(/g/g, ''));

/**
 * OWN-PROJECT EXEMPTION (FEAT-156). `names` are the registered names of the
 * project(s) the HOST resolved this repo to (registry is the authority — the
 * gate never derives identity itself, ARCH-010). A token is the project's own
 * iff it is PROJECT-kind, matches a registered name, AND matches the basename
 * of the repo's real toplevel — the directory can veto, never grant (so a
 * rename in the registry alone, or a symlink alias, cannot self-grant).
 * Identity / client / credential tokens are never own-waivable.
 * Returns the waivable token LABELS (never the names).
 */
export function ownProjectTokens(names, repoBasename) {
  const out = new Set();
  const base = String(repoBasename ?? '');
  for (const t of TOKENS) {
    if (t.kind !== 'project') continue;
    const re = nonGlobal(t.re);
    if (!re.test(base)) continue;
    if ((names ?? []).some((n) => re.test(String(n ?? '')))) out.add(t.name);
  }
  return out;
}

/** Minimal glob → RegExp over posix rel paths: `**` any depth, `*` one segment, `?` one char. */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const ALLOWLIST_FILE = '.leakgate-allow';
const MIN_REASON = 10;

/**
 * Parse a `.leakgate-allow` (FEAT-156). One waiver per line:
 *   token:<hit label> [match:<exact matched text>] [in:<path glob>] because: <reason>
 *   match:<exact matched text> [in:<path glob>] because: <reason>
 * `#` comments and blank lines are ignored. Returns `{ entries, errors }`; ANY
 * error makes the gate exit 2 (fail closed) — a malformed allowlist is never
 * half-applied. Refused (error): no reason / short reason; unknown key or label;
 * an identity or credential label; `personal email` without an exact `match:`;
 * a `match:` value that is itself a credential or identity token; a bare
 * `*`/`**` glob (omit `in:` to mean everywhere).
 */
export function parseAllowlist(text) {
  const entries = [];
  const errors = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const err = (m) => errors.push(`${ALLOWLIST_FILE}:${lineNo}: ${m}`);
    const bi = line.search(/(^|\s)because:/);
    if (bi < 0) return err('every entry needs a reason — end the line with `because: <why this is not a leak>`');
    const reason = line.slice(line.indexOf('because:', bi) + 'because:'.length).trim();
    if (reason.length < MIN_REASON) return err(`the reason is too short (${reason.length} chars; need ≥ ${MIN_REASON}) — say why this hit is not a leak`);
    const sel = line.slice(0, bi).trim();
    const keyRe = /(^|\s)(token|match|in):/g;
    const marks = [...sel.matchAll(keyRe)].map((m) => ({ key: m[2], at: m.index + m[1].length, valAt: m.index + m[0].length }));
    if (!marks.length || marks[0].at !== 0) return err('expected `token:<label>` or `match:<text>` at the start of the line (keys: token:, match:, in:, because:)');
    const e = { lineNo, reason };
    for (let k = 0; k < marks.length; k++) {
      const { key, valAt } = marks[k];
      if (key in e) return err(`duplicate key \`${key}:\``);
      const val = sel.slice(valAt, k + 1 < marks.length ? marks[k + 1].at : sel.length).trim();
      if (!val) return err(`\`${key}:\` has no value`);
      e[key] = val;
    }
    if (!e.token && !e.match) return err('an entry needs `token:<label>` and/or `match:<text>`');
    if (e.in !== undefined) {
      if (/\s/.test(e.in)) return err('`in:` glob must not contain whitespace');
      if (e.in === '*' || e.in === '**' || e.in === '**/*') return err('a bare `*`/`**` glob is refused — omit `in:` to mean every file, deliberately');
      e.glob = globToRegExp(e.in);
    }
    if (e.token) {
      const kind = tokenKindOf(e.token);
      if (kind === null) return err(`unknown token label [${e.token}] — copy the label exactly as the gate printed it inside [ ]`);
      if (kind === 'credential') return err(`[${e.token}] is a credential class and can NEVER be allowlisted — remove the secret instead`);
      if (kind === 'identity') return err(`[${e.token}] is a personal-identity token (home path / username / handle / email) and cannot be allowlisted`);
      if (kind === 'email' && !e.match) return err('[personal email] can only be allowlisted for one exact address — add `match:<the address>`');
    }
    if (e.match) {
      const bad = [...scanLine(e.match), ...scanKeyShapes(e.match)]
        .filter((h) => { const k = tokenKindOf(h.token); return k === 'credential' || k === 'identity'; });
      if (bad.length) return err(`the \`match:\` value is itself a ${bad.map((h) => `[${h.token}]`).join(', ')} hit — credentials and personal identity can never be allowlisted`);
    }
    entries.push(e);
  });
  return { entries, errors };
}

/** Is this hit class waivable by an allowlist entry at all? (credentials/identity: never.) */
function allowlistable(hit, entry) {
  const kind = tokenKindOf(hit.token);
  if (kind === 'project' || kind === 'client') return true;
  if (kind === 'email') return Boolean(entry.match); // one exact address, never the class
  return false;
}

/**
 * The allowlist entry that waives ONE hit `{ token, match }` in file `rel`, or
 * undefined. Per HIT, never per line: every other hit on the same line is
 * judged on its own.
 */
export function allowlistEntryFor(entries, rel, hit) {
  return (entries ?? []).find((e) =>
    (!e.token || e.token === hit.token)
    && (!e.match || e.match === hit.match)
    && (!e.glob || e.glob.test(rel))
    && allowlistable(hit, e));
}
