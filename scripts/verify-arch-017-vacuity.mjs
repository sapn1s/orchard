#!/usr/bin/env node
/**
 * ARCH-017 — THE STANDING VACUITY SCANNER.
 *
 * Six rounds running, a fixture has been blind in a NEW place, and each round
 * fixed the specific assertions that were named. A cross-provider reviewer put
 * it exactly right: *"sweep for the property, not the idiom — fixing only the
 * three named guarantees a seventh."* Rounds 4 and 5 added cardinality guards
 * before `.every()`; round 6's findings were the cases that were not `.every()`.
 *
 * THE PROPERTY: an assertion whose truth is PRESERVED BY AN EMPTY COLLECTION
 * proves nothing unless something else in the same check pins the size of that
 * collection. Every vacuously-true-on-empty idiom is enumerated below, not just
 * the one that bit us last:
 *
 *   xs.every(...)            true on []          xs.filter(...).length === 0   true on []
 *   !xs.some(...)            true on []          xs.length === 0               true on []
 *   deepEqual(xs, [])        true on []          for (const x of xs) assert(…)  runs zero times
 *   xs.find(...) == null     true on []          xs.includes(...) === false     true on []
 *
 * For each `check(...)` / `mustFail(...)` block in the ARCH-017 suites, this
 * finds those idioms and requires the SAME block to also assert a cardinality:
 * `assert.equal(xs.length, N)`, `assert.ok(xs.length > 0)`, `nonEmpty(xs)`, or a
 * `precondition:` assertion naming a count. A block with a vacuity-prone
 * assertion and no size anywhere is reported.
 *
 * Exit 0 only when nothing is unguarded. This is a SOURCE check, deliberately:
 * it catches the class before a fixture ever has a chance to be blind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  'scripts/verify-arch-017-drain.mjs',
  'scripts/verify-arch-017-rail.mjs',
  'scripts/verify-lane-ledger.mjs',
];

/*
 * Idioms whose truth survives an empty collection.
 *
 * ROUND 8 — ONLY UNIVERSAL-OVER-ELEMENTS IDIOMS, not assert-EMPTINESS ones.
 * `assert.deepEqual(xs, [])` and `xs.length === 0` ASSERT the collection is
 * empty — a legitimate claim, false on a non-empty collection — and whether that
 * empty is the RIGHT empty is a prior-state question no static scan can answer
 * (round 7 chased it into false positives on `railAfter`/`offenders`). The
 * checkable class is a UNIVERSAL over the elements — `every`, `!some`,
 * `filter(p).length === 0`, an assertion loop — which is vacuously true on `[]`
 * and needs the collection pinned non-empty. Those, and only those, are flagged.
 */
const VACUOUS = [
  { re: /\b([A-Za-z_$][\w$.]*)\s*\.every\s*\(/g, kind: '.every()' },
  { re: /!\s*([A-Za-z_$][\w$.]*)\s*\.some\s*\(/g, kind: '!.some()' },
  { re: /\b([A-Za-z_$][\w$.]*)\s*\.filter\s*\([^;]*?\)\s*\.length\s*===?\s*0/g, kind: '.filter().length === 0' },
  /*
   * ROUND 6 — THE SCANNER WAS BLIND TO AN IDIOM ITS OWN HEADER ADVERTISES.
   *
   * The comment above has listed `xs.includes(...) === false` as a covered
   * idiom since the scanner was written, but it was never added to this array.
   * A checker that documents a guarantee it does not implement is worse than
   * one that says nothing, because the documentation is what people audit
   * against. Adding it found FOUR live unguarded blocks, one of them the exact
   * "open-group item assertion" a cross-provider reviewer had named as passing
   * on empty input.
   */
  { re: /!\s*([A-Za-z_$][\w$.]*)\s*\.includes\s*\(/g, kind: '!.includes()' },
  { re: /\b([A-Za-z_$][\w$.]*)\s*\.includes\s*\([^;]*?\)\s*===?\s*false/g, kind: '.includes() === false' },
  { re: /\b([A-Za-z_$][\w$.]*)\s*\.find\s*\([^;]*?\)\s*===?\s*(null|undefined)\b/g, kind: 'find() == null' },
  /*
   * NOTE: the `for…of + assert` idiom is NOT here — it is detected by
   * `loopCollections` against the block BODY, not against `claims`. Round 6 put
   * it in this array, which is scanned against the extracted assertion
   * expressions only; a `for (const x of xs) { … }` wrapper never appears there,
   * so an UNREACHED assertion loop (finding 4, `unreached exit=0`) slipped past
   * the one idiom meant to catch it. A loop whose collection is empty runs its
   * body zero times, so the collection it iterates is vacuity-prone exactly like
   * the enumerated idioms above.
   */
];

/** Balanced `{…}` from `src[openIdx]` (which must be `{`). */
function balancedBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(openIdx + 1, i); }
  }
  return src.slice(openIdx + 1);
}

/**
 * Collections iterated by a `for…of`/`.forEach` whose body makes an ASSERTION.
 * An empty collection runs the body zero times, so every assertion inside is
 * unreached — the `unreached` blind spot (finding 4). The iterated collection is
 * returned so `guardsCardinality` can demand the SAME block pin it non-empty.
 */
function loopCollections(body) {
  const names = new Set();
  const asserts = (s) => /\bassert\.\w+\s*\(/.test(s) || /\b(?:check|mustFail)\s*\(/.test(s);
  const forOf = /\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+([A-Za-z_$][\w$.]*)\s*\)\s*(\{)?/g;
  let m;
  while ((m = forOf.exec(body))) {
    let region;
    if (m[2] === '{') region = balancedBrace(body, m.index + m[0].length - 1);
    else { const semi = body.indexOf(';', m.index + m[0].length); region = body.slice(m.index + m[0].length, semi < 0 ? body.length : semi); }
    if (asserts(region)) names.add(m[1]);
  }
  const forEach = /([A-Za-z_$][\w$.]*)\s*\.forEach\s*\(/g;
  while ((m = forEach.exec(body))) {
    const region = balanced(body, m.index + m[0].length - 1);
    if (asserts(region)) names.add(m[1]);
  }
  return [...names];
}

/**
 * Is the predicate `length OP n` TRUE when the collection is empty (length 0)?
 * A "guard" that is true on empty pins nothing — it is exactly the vacuity this
 * scanner exists to catch, wearing a cardinality assertion's clothes.
 * `assert.ok(xs.length >= 0)` and `assert.equal(xs.length, 0)` are the reviewer's
 * "zero-length guards" (finding 4): they certify a block whose real assertion is
 * trivially true on `[]`.
 */
function emptyPasses(op, n) {
  switch (op) {
    case '>': return 0 > n;
    case '>=': return 0 >= n;
    case '<': return 0 < n;
    case '<=': return 0 <= n;
    case '==': case '===': return 0 === n;
    case '!=': case '!==': return 0 !== n;
    default: return true;
  }
}

/**
 * Remove the BODY of every loop that iterates `baseEsc` from the block, so a
 * guard written INSIDE such a loop is not counted — it runs only when the base is
 * already non-empty, so it cannot prove the base non-empty (finding 4,
 * `unreached_guard exit=0`: `for (const x of xs) { assert.ok(xs.length > 0); … }`).
 */
function stripLoopsOver(block, baseEsc) {
  let s = block;
  const cuts = [];
  let m;
  const forOf = new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+[\\w$]+\\s+of\\s+${baseEsc}(?![\\w$])\\s*\\)\\s*`, 'g');
  while ((m = forOf.exec(s))) {
    const after = m.index + m[0].length;
    if (s[after] === '{') { const body = balancedBrace(s, after); cuts.push([m.index, after + body.length + 2]); }
    else { const semi = s.indexOf(';', after); cuts.push([m.index, semi < 0 ? s.length : semi + 1]); }
  }
  const forEach = new RegExp(`${baseEsc}(?![\\w$])\\s*\\.forEach\\s*\\(`, 'g');
  while ((m = forEach.exec(s))) {
    const paren = m.index + m[0].length - 1;
    const args = balanced(s, paren);
    cuts.push([m.index, paren + args.length + 2]);
  }
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [a, b] of cuts) s = s.slice(0, a) + s.slice(b);
  return s;
}

/**
 * Does the block pin THIS collection non-empty?
 *
 * ROUND 8 — CONSERVATIVE AND HONEST, because static idiom-matching cannot win the
 * enumeration race (see the header). Four more evasions were measured this round —
 * `relative`, `filtered`, `prefix`, `unreached_guard` — every one a "guard" that
 * did not actually pin the asserted collection non-empty. Rather than add four
 * more special cases, the rule is narrowed to what a source scan can soundly
 * assert: a cardinality claim on the collection's OWN name (word-bounded, so `xs`
 * is not `xsOther`), FALSE on the empty collection, and OUTSIDE any loop over it.
 * Cross-variable inference — a sibling with the same initialiser, an identifier
 * the collection was `.filter()`ed from, a relative `xs.length === ys.length` —
 * is dropped: each was a measured evasion (a filtered/sibling collection can be
 * empty though its source is not; two empty collections are equal). A block that
 * genuinely needs those now states its own count; the mutation harness is the
 * authoritative backstop for anything this lint cannot see.
 */
function guardsCardinality(block, name, claims = '', allowRelative = true) {
  const rawBase = name.split('.')[0];
  const base = rawBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const B = `${base}(?![\\w$])`;            // word-bounded: `xs` ≠ `xsOther`
  const b = stripLoopsOver(block, base);    // a guard inside a loop over base is unreachable

  let m;
  // assert.equal(base.length, N>=1)
  const eqLen = new RegExp(`assert\\.(?:equal|strictEqual)\\(\\s*${B}[\\w$.]*\\.length\\s*,\\s*(-?\\d+)`, 'g');
  while ((m = eqLen.exec(b))) if (Number(m[1]) >= 1) return true;
  // assert.equal(base.filter(...).length, N>=1) — a positive SUBSET ⇒ base non-empty.
  const eqFilter = new RegExp(`assert\\.(?:equal|strictEqual)\\(\\s*${B}[\\w$.]*\\.filter\\((?:[^()]|\\([^()]*\\))*\\)\\.length\\s*,\\s*(-?\\d+)`, 'g');
  while ((m = eqFilter.exec(b))) if (Number(m[1]) >= 1) return true;
  // `base.length OP n` — a guard only when 0 OP n is FALSE. BARE, not only inside
  // `assert.ok(...)`: a check VERDICT states the count directly (A4's
  // `onDisk.length === records.length && records.length > 0`). The digit bound and
  // the loop-strip keep the evasions caught (`ys.length === xs.length` has no digit
  // RHS; a guard inside a loop over the base is already removed).
  const okCmp = new RegExp(`${B}[\\w$.]*\\.length\\s*(===?|!==?|>=?|<=?)\\s*(-?\\d+)`, 'g');
  while ((m = okCmp.exec(b))) if (!emptyPasses(m[1], Number(m[2]))) return true;
  // assert.ok(base.length) — bare truthiness, false on empty (0 is falsy).
  if (new RegExp(`assert\\.ok\\(\\s*${B}[\\w$.]*\\.length\\s*[),]`).test(b)) return true;
  if (new RegExp(`nonEmpty\\(\\s*${B}`).test(b)) return true;
  // A SIBLING property of the same object asserted positive pins its shape
  // (`expanded.apiItems > 12` guarding `expanded.missing`).
  if (new RegExp(`${B}\\.[A-Za-z_$]\\w*\\s*[><]\\s*[1-9]`).test(b)) return true;
  // A `precondition`-labelled length assertion ON THE BASE.
  if (new RegExp(`precondition[^\\n]*${B}[\\w$.]*\\.length`).test(b)) return true;
  if (new RegExp(`${B}[\\w$.]*\\.length[^\\n]*precondition`).test(b)) return true;
  /*
   * RELATIVE cardinality — `base.length === other.length` — but ONLY when the
   * OTHER side is itself pinned non-empty in this block. That is the difference
   * between the reviewer's `relative` evasion (`xs.length === ys.length`, both
   * empty) and A4's sound `onDisk.length === records.length && records.length > 0`.
   * One level of recursion (relative disabled on the inner call) checks it.
   */
  if (allowRelative) {
    const rel = new RegExp(`${B}[\\w$.]*\\.length\\s*===?\\s*([A-Za-z_$][\\w$.]*)\\.length|([A-Za-z_$][\\w$.]*)\\.length\\s*===?\\s*${B}[\\w$.]*\\.length`, 'g');
    let mm;
    while ((mm = rel.exec(b))) {
      const other = (mm[1] || mm[2]);
      if (other && guardsCardinality(block, other, claims, false)) return true;
    }
  }
  // A POSITIVE membership assertion on the base pins it non-empty.
  const positiveMembership = new RegExp(`(?<![!\\w$.])${B}[\\w$.]*\\.includes\\s*\\(`);
  return positiveMembership.test(claims);
}

/** Split a suite into its check/mustFail blocks, keeping line numbers. */
function blocks(src) {
  const out = [];
  const re = /(?:await\s+)?(check|checkAsync|mustFail)\(\s*(['`])([^'`]*)\2/g;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ at: m.index, name: m[3] });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ name: starts[i].name, body: src.slice(from, to), line: src.slice(0, from).split('\n').length });
  }
  return out;
}

/**
 * ONLY ASSERTIONS COUNT. The hazard is a vacuous ASSERTION, not a vacuous
 * computation: `rows.every(...)` inside a `page.evaluate` that merely gathers a
 * number, which is then asserted WITH a cardinality guard outside, is fine. A
 * scanner that cannot tell those apart produces noise, and a noisy checker gets
 * ignored — which would put us right back where we started.
 *
 * So the scan is restricted to `assert.*(…)` calls and to the boolean argument
 * of `check(…)`/`mustFail(…)`, which are the only places a claim is made.
 */
function balanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) return src.slice(openIdx + 1, i); }
  }
  return src.slice(openIdx + 1);
}
/*
 * TOP-LEVEL COMMAS, SKIPPING STRINGS.
 *
 * This has to be string-aware or it is worse than useless here: every block in
 * these suites begins with a prose title, and those titles contain commas —
 * `check('P4 — over the bound with held results: capacity() reports it, nothing
 * is deleted, recording CONTINUES', () => {…})`. A naive scan treats the comma
 * after "reports it" as the end of argument one, so the "verdict" becomes a
 * fragment of the title and the real assertions are never examined. (The paren
 * pair inside `capacity()` balances, so depth-counting alone does not save it.)
 *
 * Nothing noticed while the extractor kept "everything after the first comma",
 * because the tail still contained the whole callback by accident. Narrowing
 * the extractor to the second argument is what made the latent bug bite: P4 and
 * S4 silently dropped out of the scan entirely. A checker quietly scanning
 * FEWER things is the failure mode that matters, since it still reports 0
 * unguarded and nobody looks twice.
 */
function topLevelCommas(src) {
  const at = [];
  let d = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    else if (ch === ',' && d === 0) at.push(i);
  }
  return at;
}

function assertionExprs(body) {
  const out = [];
  const re = /assert\.\w+\s*\(/g;
  let m;
  while ((m = re.exec(body))) out.push(balanced(body, m.index + m[0].length - 1));
  // the verdict argument of check(name, <verdict>, observed)
  const c = /(?:await\s+)?(?:check|checkAsync|mustFail)\s*\(/g;
  while ((m = c.exec(body))) {
    const args = balanced(body, m.index + m[0].length - 1);
    /*
     * THE VERDICT ONLY — the second argument, not "everything after the
     * first comma". The header above has always said the scan is restricted
     * to the boolean argument, but the code kept the OBSERVED payload too, so
     * a collection merely *printed* in the observed object counted as a claim
     * about it. That is how rail C1 came back "guarded" on the strength of
     * `pulledTheUnreadyOne: pulled.includes(…)` — a debug field, not an
     * assertion. Observed payloads describe; they do not claim.
     */
    const commas = topLevelCommas(args);
    if (commas.length >= 1) out.push(args.slice(commas[0] + 1, commas.length >= 2 ? commas[1] : args.length));
  }
  return out;
}

let offenders = 0;
let scanned = 0;
let guarded = 0;
for (const rel of SUITES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const b of blocks(src)) {
    const claims = assertionExprs(b.body).join('\n;;\n');
    const hits = [];
    for (const { re, kind } of VACUOUS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(claims))) {
        const name = m[1];
        if (/^(JSON|Object|Array|Math|String|Number|assert|console)$/.test(name.split('.')[0])) continue;
        hits.push({ kind, name });
      }
    }
    // Unreached assertion loops — scanned against the BODY, not `claims`.
    for (const name of loopCollections(b.body)) {
      if (/^(JSON|Object|Array|Math|String|Number|assert|console)$/.test(name.split('.')[0])) continue;
      hits.push({ kind: 'assertion loop runs zero times on []', name });
    }
    if (!hits.length) continue;
    scanned++;
    const unguarded = [...new Map(hits.map((h) => [`${h.kind}:${h.name}`, h])).values()].filter((h) => !guardsCardinality(b.body, h.name, claims));
    if (!unguarded.length) { guarded++; continue; }
    offenders++;
    console.log(`UNGUARDED ${path.basename(rel)}:${b.line}  ${b.name.slice(0, 82)}`);
    for (const h of unguarded) {
      console.log(`          ${h.kind} on \`${h.name}\` — true on an empty collection, and nothing here pins its size`);
    }
    /*
     * ALSO SPEAK THE HARNESS'S LANGUAGE. `verify-arch-017-mutation.mjs` names a
     * mutant's killer by scanning for `^FAIL <name>:`, so a scanner that only
     * ever printed `UNGUARDED` could not kill anything: it exited non-zero, the
     * harness found no NAMED killer, and deliberately declined to credit the
     * kill (that rule exists so a crashing sandbox is never mistaken for
     * coverage). Round 6 measured it — W6 and W7 SURVIVED against a scanner
     * that had in fact caught both. The one check nothing was checking could
     * not be checked, for want of a prefix.
     */
    console.log(`FAIL ${b.name}: a vacuous assertion — ${unguarded.map((h) => `${h.kind} on ${h.name}`).join(', ')}`);
  }
}

console.log(`\nRESULT ${guarded} guarded / ${offenders} UNGUARDED  (${scanned} check blocks contain an empty-true assertion)`);
/* The machine-readable twin, in the shape every other suite here prints, so
 * the mutation harness can report this scanner's score like any other. */
console.log(`RESULT ${guarded} PASS / ${offenders} FAIL`);
if (offenders) {
  console.log('An assertion that survives an empty collection proves nothing unless the same check asserts how big that collection is.');
}
process.exit(offenders ? 1 : 0);
