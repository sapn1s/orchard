/**
 * BUG-203 — best-effort lint for the git-view async-token invariant.
 *
 * NOT A PROOF. This is a single-file, best-effort LINT, not a soundness
 * guarantee. It hand-lexes one file without a real parser and CAN BE FOOLED by
 * deliberate obfuscation — four verify rounds each found new accepting
 * constructs (line-regex 5/5, lexer 7/7, fail-closed-on-`/` 3/3, and r5's
 * comment-terminator / identifier-escape / dynamic-`.then` / shadowed-guard /
 * moved-to-git-view-fmt.js 5/5). Making it sound would need an actual JS parser.
 * Treat a PASS as "no accidental violation in ordinary code", never as a
 * security boundary or a guarantee that no violation exists. The BUG-203 product
 * fix is verified behaviourally (driven-in-a-browser harnesses), not by this scan.
 *
 * ---
 * BUG-203 r3 — STRUCTURAL guard for the git-view async-token invariant, redesigned.
 *
 * The redesign (see public/lib/git-view.js): every async operation is
 * `await guard(token, <promise>)`, where `guard` resolves only while the token
 * is current and otherwise never settles. So reaching the code after an
 * `await guard(...)` IS the proof the token is current — no caller has to
 * remember a `superseded` check, and forgetting one is not possible because the
 * ONLY await is of guard() itself.
 *
 * This scan enforces exactly that, structurally:
 *   (1) every `await` operand is a call to `guard(` whose FIRST argument is a
 *       plain identifier (not a literal — that would be a vacuous guard);
 *   (2) no `.then` / `.catch` / `.finally` method call anywhere EXCEPT inside the
 *       one-line `guard` helper.
 * A previous round's heuristic (line regex for the word `superseded`) was fooled
 * 5/5 by the clean room (a guard after the touch, a vacuous guard, a then-chain,
 * helper indirection, a second async fn on a guarded line). This one is not a
 * line regex: it lexes the whole file — blanking comments, strings, templates
 * and regex literals so keywords inside them never count, while KEEPING `${…}`
 * expression code — then checks the two rules on real tokens. All 5 fooling
 * patterns are encoded below as must-FAIL fixtures.
 *
 * No AST parser is installed (typescript here is v7-native with no JS compiler
 * API; no acorn/@babel/parser/rollup). This lexer is the "real parse" that the
 * discipline needs; adding a parser dependency was intentionally avoided.
 *
 *   node scripts/verify-gitview-async-token.mjs
 *   GV_FILE=/tmp/old.js node scripts/verify-gitview-async-token.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Blank out comments, string/template LITERAL text and regex literals (replace
// with spaces, preserving newlines and offsets) while KEEPING `${…}` expression
// code, so the token checks below see only real code. Stack-based so nested
// templates (`${`…`${…}`…`}`) are handled.
function clean(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0; const n = src.length;
  // stack frames: 'code' (top-level or a ${} expr) carry a brace depth; 'tpl' is a template literal.
  const stack = [{ kind: 'code', brace: 0 }];
  let lastSig = '';
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const f = top(); const c = src[i], c2 = src[i + 1];
    if (f.kind === 'code') {
      if (c === '/' && c2 === '/') { i += 2; blank(i - 2); blank(i - 1); while (i < n && src[i] !== '\n') { blank(i); i++; } continue; }
      if (c === '/' && c2 === '*') { blank(i); blank(i + 1); i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; } if (i < n) { blank(i); blank(i + 1); i += 2; } continue; }
      if (c === "'" || c === '"') { const q = c; blank(i); i++; while (i < n && src[i] !== q) { if (src[i] === '\\') { blank(i); i++; } blank(i); i++; } if (i < n) { blank(i); i++; } lastSig = 'x'; continue; }
      if (c === '`') { blank(i); i++; stack.push({ kind: 'tpl' }); continue; }
      // NB: regex literals are NOT detected/blanked here. Divide-vs-regex is
      // undecidable without a full parser, and guessing is exactly what the r3/r4
      // clean rooms fooled (a regex after `return`/`)` misread as divide, blanking
      // a following await). Instead git-view.js carries NO bare `/` in code (all
      // division + regex literals live in git-view-fmt.js), and Rule D below fails
      // closed on ANY `/` that survives cleaning here (BUG-203 r5).
      if (c === '{') { f.brace++; i++; if (!/\s/.test(c)) lastSig = c; continue; }
      if (c === '}') { if (f.brace > 0) { f.brace--; i++; lastSig = c; continue; } if (stack.length > 1) { stack.pop(); i++; continue; } i++; continue; }
      if (!/\s/.test(c)) lastSig = c;
      i++; continue;
    } else { // template literal text
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { blank(i); i++; stack.pop(); lastSig = 'x'; continue; }
      if (c === '$' && c2 === '{') { i += 2; stack.push({ kind: 'code', brace: 0 }); lastSig = ''; continue; }
      blank(i); i++; continue;
    }
  }
  return out.join('');
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
// A vacuous token: a literal, or the LIVE `generation` (compared against itself
// at resolve time, so `guard(generation, …)` always reads current — BUG-203 r4).
const LITERAL_WORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'generation']);

// First argument text of a `guard(` call starting at index `open` (the '(').
function firstArg(s, open) {
  let depth = 0, i = open, start = open + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 1) break;
  }
  // depth started at 0 at the '('; we entered depth1 after it. Recompute simply:
  depth = 0;
  for (i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depth++; if (depth === 1) start = i + 1; }
    else if (c === ')') { depth--; if (depth === 0) return s.slice(start, i).trim(); }
    else if (c === ',' && depth === 1) return s.slice(start, i).trim();
  }
  return s.slice(start).trim();
}

export function scan(src) {
  const s = clean(src);
  const violations = [];
  const guardStart = s.indexOf('const guard');
  // Exempt ONLY the guard helper's own first `.then` — not its whole line, so a
  // stray `.then(...)` sharing the guard line is still caught (BUG-203 r4).
  const guardThen = guardStart >= 0 ? s.indexOf('.then', guardStart) : -1;

  // Rule 1: every `await` operand is guard(<identifier>, …), token not vacuous.
  let awaitCount = 0;
  for (const m of s.matchAll(/\bawait\b/g)) {
    awaitCount++;
    let j = m.index + 5; while (j < s.length && /\s/.test(s[j])) j++;
    if (!/^guard\s*\(/.test(s.slice(j, j + 12))) { violations.push({ type: 'await-not-guard', index: m.index, snippet: src.slice(m.index, m.index + 40).replace(/\n/g, ' ') }); continue; }
    const arg = firstArg(s, s.indexOf('(', j));
    if (!IDENT.test(arg) || LITERAL_WORDS.has(arg)) violations.push({ type: 'vacuous-guard-token', index: m.index, snippet: `guard(${arg}, …)` });
  }
  // Rule 2: no `.then`/`.catch`/`.finally` outside the guard's own `.then`,
  // FAIL-CLOSED across whitespace/newline after the dot AND computed access
  // (`p. then(`, `p.\nthen(`, `p['then'](`) — the r3 lexer missed all three.
  for (const m of s.matchAll(/\.\s*(then|catch|finally)\b/g)) {
    if (m.index === guardThen) continue;
    violations.push({ type: `stray-.${m[1]}`, index: m.index, snippet: src.slice(Math.max(0, m.index - 15), m.index + 20).replace(/\n/g, ' ') });
  }
  // Computed access needs the STRING key, which clean() blanks — so match the
  // ORIGINAL source, but only where the `[` survives cleaning (real code, not a
  // comment/string), so a `['then']` inside a comment does not false-match.
  for (const m of src.matchAll(/\[\s*(['"`])(then|catch|finally)\1\s*\]/g)) {
    if (s[m.index] === '[') violations.push({ type: `computed-.${m[2]}`, index: m.index, snippet: src.slice(m.index, m.index + 20).replace(/\n/g, ' ') });
  }
  // Rule 3 (fail closed): `++`/`--` make a following `/` un-disambiguable
  // (postfix-then-divide reads as a regex start), so the lexer cannot be trusted
  // around them. Rather than guess, forbid them in this one file we control
  // (BUG-203 r4 — the module was simplified to `+= 1` to satisfy this).
  for (const m of s.matchAll(/\+\+|--/g)) {
    violations.push({ type: 'increment-operator', index: m.index, snippet: src.slice(Math.max(0, m.index - 12), m.index + 8).replace(/\n/g, ' ') });
  }
  // Rule 4 (fail closed on `/`): after comments/strings/templates are blanked,
  // any surviving `/` is a division or a regex literal — the one construct whose
  // divide-vs-regex reading the lexer cannot decide. Rather than guess, forbid
  // it: git-view.js keeps every `/` in git-view-fmt.js (which the scan does not
  // read), so the scanned file has none. This closes the ambiguity class for good.
  for (const m of s.matchAll(/\//g)) {
    violations.push({ type: 'bare-slash', index: m.index, snippet: src.slice(Math.max(0, m.index - 12), m.index + 12).replace(/\n/g, ' ') });
  }
  return { violations, awaitCount, guardFound: guardStart >= 0 };
}

// The clean room's 5 fooling patterns — each MUST be rejected by the scan.
// `guard` on its own line (its real shape); the offending code on a separate
// line. FIXTURES are the round-3 clean room's 7 fooling forms (the ones the
// parsed lexer missed) plus the earlier variants — each MUST now be rejected.
const G = `const guard=(t,p)=>p.then(v=>superseded(t)?N:v,e=>superseded(t)?N:Promise.reject(e));\n`;
const FIXTURES = {
  // #1/#2 — postfix ++/-- before a divide (r3 misread it as a regex start,
  // blanking a real unguarded await). Now failed-closed on the operator itself.
  'postfix ++ before divide': `${G}async function f(t){ let x=0; z = x++ / 2; const v=await api.q(); use(v); }`,
  'postfix -- before divide': `${G}async function f(t){ let n=9; z = n-- / 2; const v=await api.q(); use(v); }`,
  // #3/#4/#5 — then-chain via whitespace / newline / computed access.
  'then via space (p. then()': `${G}function f(){ p. then(v=>{ data=v; }); }`,
  'then via newline (p.\\nthen()': `${G}function f(){ p.\n  then(v=>{ data=v; }); }`,
  'then via computed (p[\'then\']())': `${G}function f(){ p['then'](v=>{ data=v; }); }`,
  // #6 — stray .then sharing the guard line (whole-line exemption bug).
  'stray .then on the guard line': `const guard=(t,p)=>p.then(v=>v); api.x().then(v=>{ data=v; });`,
  // #7 — vacuous token: the LIVE generation always reads current.
  'vacuous live-generation token': `${G}async function f(){ const v=await guard(generation, api.q()); use(v); }`,
  // r5 — a regex literal in an ambiguous position misread as division, blanking a
  // following unguarded await. Now failed-closed on the `/` itself.
  'regex after return': `${G}async function f(t){ if(x) return /y/.test(z); const v=await api.q(); use(v); }`,
  'regex after paren )': `${G}async function f(t){ const ok = (list).filter(x=>/z/.test(x)); const v=await api.q(); use(v); }`,
  'division after paren )': `${G}async function f(t){ const n = obj.count() / 2; const v=await api.q(); use(v); }`,
  // Earlier variants, still rejected.
  'guard after the touch': `${G}async function f(t){ const v=await api.x(); if(superseded(t))return; data=v; }`,
  'vacuous literal token': `${G}async function f(){ const v=await guard(0, api.x()); data=v; }`,
  'helper indirection (unguarded await in a helper)': `${G}async function h(){ const v=await api.x(); data=v; }\nfunction f(){ h(); }`,
  'two async fns on one line': `${G}async function a(t){const v=await guard(t,api.x());ok(v)} async function b(){const w=await api.y();bad(w)}`,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const FILE = process.env.GV_FILE || path.join(ROOT, 'public', 'lib', 'git-view.js');
  let pass = 0, fail = 0;
  const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${obs ? `\n        ${obs}` : ''}`); ok ? pass++ : fail++; };

  const r = scan(fs.readFileSync(FILE, 'utf8'));
  console.log(`  scanned ${FILE}`);
  check('real file: guard helper found', r.guardFound);
  check('real file: enough async awaits seen (vacuity guard, >=18)', r.awaitCount >= 18, `awaitCount=${r.awaitCount}`);
  check('real file: ZERO structural violations', r.violations.length === 0,
    r.violations.length ? 'violations: ' + JSON.stringify(r.violations) : 'clean');

  console.log('\n  fooling-pattern fixtures (each MUST be rejected):');
  for (const [name, code] of Object.entries(FIXTURES)) {
    const v = scan(code).violations;
    check(`rejects: ${name}`, v.length >= 1, v.length ? `→ ${v.map(x => x.type).join(', ')}` : 'NOT REJECTED (scan fooled)');
  }
  // Sanity: a clean guarded snippet must PASS (no false positives).
  const good = `const guard=(t,p)=>p.then(v=>superseded(t)?N:v); async function f(t){ const v=await guard(t, api.x()); data=v; }`;
  check('accepts: a correctly guarded snippet (no false positive)', scan(good).violations.length === 0,
    JSON.stringify(scan(good).violations));

  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
