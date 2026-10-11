#!/usr/bin/env node
// BUG-236 round 5 — NO SUPPRESSION + SINGLE-LINE WAIVERS.
//
//   node scripts/verify-bug-236-code-value-precision.mjs [--corpus-repo=<dir> ...] [--fuzz=<n>]
//
// Rounds 1–4 taught the matcher "this credential-shaped thing is really code" four ways and
// each was broken. Round 5 deletes all of it: detection is HEAD's (FEAT-130/156) plus purely
// ADDITIVE literal forms, and a false positive is resolved by a reviewed single-LINE waiver.
//
//   S  detection ⊇ HEAD — HEAD's module (read-only `git show HEAD:`) vs the working module over
//      (1) every input the FEAT-130 suite feeds the matcher (recorded through a loader hook),
//      (2) every line of every git-listed text file of orchard + any --corpus-repo, and
//      (3) a seeded grammar fuzz. Every HEAD hit {token, match} must also be a new hit, for
//      scanLine / scanSecrets / scanKeyShapes / scanBinary / scanIdentity / findLeaks.
//      MUST-FAIL: the same checker over a synthetic "code-file suppressor" reports violations.
//   A  every reconstructed round 1–4 independent-verify attack input: flagged, or (where HEAD
//      never flagged it either) reported as a pre-existing HEAD recall gap, asserted HEAD-equal.
//   W  waiver: exact line waived; any edit / next line / other path / path-spelling variant /
//      case variant NOT waived; PEM header and any line inside a private-key block never
//      waivable (incl. the round-3/4 PEM attacks); DRAFT-marked entries refused by structure; allowlist self-target
//      refused; seeded fuzz: waived ⇔ same normalised path AND same normalised line.
//   D/G  the real gate end to end (REPO mode) over scratch fixture dirs, with `git` replaced on
//      PATH by a read-only fake that serves `ls-files` / the index allowlist from the fixture
//      (git init is blocked in agent sessions); --draft-waivers output is refused until the
//      DRAFT marker is removed and a reason written, then passes; an edit after waiving fails again.
//
// SELF-IMMUNITY — this file is scanned by the gate. Every secret-shaped input is assembled
// at runtime from split parts, so no literal `key<sep>secret` appears in this source.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORCHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ORCHARD, 'scripts', 'leak-gate.mjs');
const LT = path.join(ORCHARD, 'scripts', 'lib', 'leak-tokens.mjs');
const cur = await import(pathToFileURL(LT).href);
const args = process.argv.slice(2);
const FUZZ_N = Number((args.find((a) => a.startsWith('--fuzz=')) ?? '--fuzz=60000').split('=')[1]);
const CORPUS_REPOS = [ORCHARD, ...args.filter((a) => a.startsWith('--corpus-repo=')).map((a) => path.resolve(a.split('=').slice(1).join('=')))];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug236-r5-'));

let pass = 0, fail = 0, skip = 0; const bad = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; bad.push(n); console.log('  FAIL  ' + n + (d ? ' :: ' + String(d).slice(0, 400) : '')); } };
const skipped = (n, why) => { skip++; console.log(`  SKIP  ${n} — ${why}`); };
const isCred = (m, h) => m.tokenKindOf(h.token) === 'credential';
const credHits = (m, line) => m.scanLine(line).filter((h) => isCred(m, h));

// ── split parts (self-immunity) ────────────────────────────────────────────────
const Q = '"', SQ = "'", BT = '`', DOL = '$';
const SEC = 'Ax9Kd' + '82bQm10ZzPpLw';
const SEC2 = 'Zq7Rt' + '4Yu1Io9Pa3Sd6Fg';
const PW = 'pass' + 'word', AK = 'api' + '_key', CS = 'client' + '_secret', TK = 'to' + 'ken', AT = 'auth' + '_token';
const AKIA = 'AKI' + 'AZ3QW7RTY2UI9OP4L';
const AKIA_DOC = 'AKI' + 'AIOSFODNN7EXAMPLE';
const GHP = 'gh' + 'p_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const PEM_B = '-----BEGIN ' + 'PRIVATE KEY-----', PEM_E = '-----END ' + 'PRIVATE KEY-----';
const RSA_B = '-----BEGIN ' + 'RSA PRIVATE KEY-----', RSA_E = '-----END ' + 'RSA PRIVATE KEY-----';
const ALLOW = '.leakgate' + '-allow';

// ═══ S — detection ⊇ HEAD ══════════════════════════════════════════════════════
console.log('\n[S] detection is a SUPERSET of HEAD');
let head = null;
try {
  const src = execFileSync('git', ['show', 'HEAD:scripts/lib/leak-tokens.mjs'], { cwd: ORCHARD, encoding: 'utf8', maxBuffer: 64 << 20 });
  const f = path.join(TMP, 'head-leak-tokens.mjs'); fs.writeFileSync(f, src);
  head = await import(pathToFileURL(f).href);
} catch (e) { skipped('S (HEAD module)', `cannot read HEAD:scripts/lib/leak-tokens.mjs (${e.message.split('\n')[0]})`); }

const key = (h) => `${h.token}\u0000${h.match}`;
/** Returns the inputs where some HEAD hit is missing from the candidate's hits. */
function supersetViolations(H, N, inputs) {
  const viol = [];
  const cmp = (label, x, a, b) => {
    const nb = new Set(b.map(key));
    const miss = a.filter((h) => !nb.has(key(h)));
    if (miss.length) viol.push({ fn: label, input: x, missing: miss.map((h) => h.token) });
  };
  for (const x of inputs) {
    cmp('scanLine', x, H.scanLine(x), N.scanLine(x));
    cmp('scanSecrets', x, H.scanSecrets(x), N.scanSecrets(x));
    cmp('scanKeyShapes', x, H.scanKeyShapes(x), N.scanKeyShapes(x));
    cmp('scanBinary', x, H.scanBinary(x), N.scanBinary(x));
    cmp('scanIdentity', x, H.scanIdentity(x, x), N.scanIdentity(x, x));
  }
  return viol;
}
const countHits = (M, inputs) => inputs.reduce((n, x) => n + M.scanLine(x).length, 0);

// (1) FEAT-130 recorded inputs — a loader hook swaps the module for a recorder that logs
// every argument passed to the matcher, then delegates to the real module.
function recordFeat130() {
  const rec = path.join(TMP, 'feat130-inputs.jsonl');
  const recorder = path.join(TMP, 'recorder.mjs');
  const hooks = path.join(TMP, 'hooks.mjs');
  const reg = path.join(TMP, 'register.mjs');
  const realUrl = pathToFileURL(LT).href;
  fs.writeFileSync(recorder, `import fs from 'node:fs';
import * as R from ${JSON.stringify(realUrl + '?real')};
export * from ${JSON.stringify(realUrl + '?real')};
const log = (fn, a) => { try { fs.appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ fn, a }) + '\\n'); } catch {} };
export const scanLine = (...a) => { log('scanLine', a); return R.scanLine(...a); };
export const scanSecrets = (...a) => { log('scanSecrets', a); return R.scanSecrets(...a); };
export const scanKeyShapes = (...a) => { log('scanKeyShapes', a); return R.scanKeyShapes(...a); };
export const scanBinary = (...a) => { log('scanBinary', a); return R.scanBinary(...a); };
export const scanIdentity = (...a) => { log('scanIdentity', a); return R.scanIdentity(...a); };
export const findLeaks = (...a) => { log('findLeaks', a); return R.findLeaks(...a); };
`);
  fs.writeFileSync(hooks, `export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (r.url === ${JSON.stringify(realUrl)} && !(ctx.parentURL ?? '').startsWith(${JSON.stringify(pathToFileURL(recorder).href)})) return { ...r, url: ${JSON.stringify(pathToFileURL(recorder).href)} };
  return r;
}
`);
  fs.writeFileSync(reg, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  spawnSync(process.execPath, ['--import', pathToFileURL(reg).href, path.join(ORCHARD, 'scripts', 'verify-feat-130-leak-detection.mjs')],
    { cwd: ORCHARD, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 300000 });
  const out = new Set();
  if (fs.existsSync(rec)) {
    for (const l of fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean)) {
      const { a } = JSON.parse(l);
      for (const v of a) if (typeof v === 'string') { out.add(v); for (const piece of v.split(/\r?\n|\0/)) out.add(piece); }
    }
  }
  return [...out];
}

// (2) every line of every git-listed text file of each corpus repo (read-only).
function repoLines(repo) {
  let files = [];
  try { files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean); }
  catch { return []; }
  const out = new Set();
  for (const rel of files) {
    const abs = path.join(repo, rel);
    let buf; try { if (!fs.lstatSync(abs).isFile()) continue; buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.length > 4 << 20 || buf.includes(0)) continue;
    for (const l of buf.toString('utf8').split('\n')) if (l.length <= 4000) out.add(l);
  }
  return [...out];
}

// (3) seeded grammar fuzz around every assignment / shape form.
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function fuzzLines(n, seed = 236) {
  const r = rng(seed); const pick = (a) => a[Math.floor(r() * a.length)];
  const rnd = (alpha, lo, hi) => { const L = lo + Math.floor(r() * (hi - lo + 1)); let s = ''; for (let i = 0; i < L; i++) s += alpha[Math.floor(r() * alpha.length)]; return s; };
  const lo = 'abcdefghijklmnopqrstuvwxyz', up = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', dg = '0123456789', pu = '._-/!@#$%^&*+=~,;:?()[]{}<>|\\';
  const highKeys = ['pass' + 'word', 'pass' + 'wd', 'sec' + 'ret', 'secret' + '_key', 'secret' + '-key', 'secret' + 'key', 'api' + '_key', 'api' + '-key', 'api' + 'key', 'api' + 'Key', 'access' + '_key', 'client' + '_secret', 'private' + '_key', 'auth' + '_token', 'access' + '_token', 'refresh' + '_token', 'bot' + '_token', 'slack' + '_token', 'github' + '_token', 'gh' + '_token', 'npm' + '_token', 'PASS' + 'WORD', 'DB_PASS' + 'WORD', 'API' + '_KEY', 'AWS_SECRET' + '_ACCESS_KEY', 'CLIENT' + '_SECRET'];
  const genKeys = ['to' + 'ken', 'au' + 'th', 'p' + 'wd', 'pass' + 'phrase', 'cred' + 'entials', 'cr' + 'ed', 'coo' + 'kie', 'sess' + 'ion', 'api' + '_secret', 'secret' + '_token', 'private' + '_token', 'session' + '_key', 'client' + '_key', 'access' + '_secret', 'TO' + 'KEN', 'oau' + 'th', 'auth' + 'or'];
  const seps = ['=', ': ', ' = ', ':', '": "', "': '", '" : ', '"=', ' := ', '=\t', ': >'];
  const val = () => {
    const k = Math.floor(r() * 22);
    switch (k) {
      case 0: return rnd(lo, 3, 30);
      case 1: return rnd(lo + up, 4, 30);
      case 2: return rnd(lo + up + dg, 4, 40);
      case 3: return rnd(lo + up + dg + pu, 4, 40);
      case 4: return Q + rnd(lo + up + dg + pu, 3, 30) + Q;
      case 5: return SQ + rnd(lo + up + dg, 3, 30) + SQ;
      case 6: return BT + rnd(lo + up + dg + '$\\{}', 3, 30) + BT;
      case 7: return Q + Q + Q + rnd(lo + up + dg, 3, 30) + Q + Q + Q;
      case 8: return pick(['process.env.', 'config.', 'os.environ', '$', '${', 'this.', 'opts.']) + rnd(up + '_', 3, 20) + pick(['', '}', ')']);
      case 9: return pick(['<your-key>', 'xxxx' + rnd(lo, 0, 6), 'example' + rnd(dg, 0, 4), 'changeme', '***', 'your-key-here', 'not-a-real-token']);
      case 10: return rnd(lo, 2, 10) + '(' + pick([Q, SQ, '']) + rnd(lo + up + dg + '!.,', 6, 24) + pick([Q, SQ, '']) + ')';
      case 11: return rnd(lo, 2, 8) + '.' + rnd(lo + up, 2, 12) + pick(['', '.' + rnd(lo, 2, 8), '()', '?.x']);
      case 12: return pick(['sk-' + 'ant-api03-', 'sk-', 'gh' + 'p_', 'gh' + 'o_', 'AKI' + 'A', 'AS' + 'IA', 'xox' + 'b-', 'AI' + 'za', 'sk' + '_live_', 'rk' + '_test_', 'github' + '_pat_', 'S' + 'G.', 'np' + 'm_', 'pypi' + '-AgE', 'ey' + 'J']) + rnd(lo + up + dg + '-_.', 6, 60);
      case 13: return pick(['postgres', 'redis', 'amqp', 'mongodb+srv', 'https']) + '://' + rnd(lo, 0, 6) + ':' + rnd(lo + up + dg + '!', 1, 20) + '@' + rnd(lo, 3, 10) + '.' + pick(['com', 'local', 'internal']) + '/db';
      case 14: return rnd(lo + dg + '._', 2, 12) + '@' + rnd(lo, 2, 10) + '.' + pick(['com', 'example.com', 'test', 'io', 'de', 'service', 'noreply.github.com']);
      case 15: return pick([PEM_B, RSA_B, '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', '-----BEGIN ' + 'PUBLIC KEY-----']);
      case 16: return 'Bea' + 'rer ' + rnd(lo + up + dg + '._-', 8, 50);
      case 17: return rnd(dg, 1, 12);
      case 18: return rnd(lo + up + dg, 8, 20) + pick(['#', ';', ' ', ',', '.']) + rnd(lo + up + dg, 4, 20);
      case 19: return '/' + rnd(lo + up + dg + '!', 6, 20) + '/.source';
      case 20: return 'String.raw' + BT + rnd(lo + up + dg + '!', 6, 20) + BT;
      default: return rnd(lo + up + dg + pu + ' ', 1, 60);
    }
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = [];
    const m = 1 + Math.floor(r() * 3);
    for (let j = 0; j < m; j++) {
      const kk = r() < 0.6 ? pick(highKeys) : pick(genKeys);
      const kq = pick(['', '', Q, SQ, 'obj.', 'const ', 'export ', '  ', '- ']);
      const close = kq === Q ? Q : kq === SQ ? SQ : '';
      parts.push(kq + kk + close + pick(seps) + val() + pick(['', '', ';', ',', ' # note', ' // c', ')', ' ' + rnd(lo, 2, 8)]));
    }
    out.push(r() < 0.1 ? val() + ' ' + val() : parts.join(pick(['; ', ', ', ' ', ' && '])));
  }
  return out;
}

if (head) {
  const t0 = Date.now();
  const feat130 = recordFeat130();
  // FEAT-130's matcher sections (A–D11) all run before its first scratch-repo step; the
  // later sections are commit-path enforcement, which needs a writable scratch repo.
  ok(`S0 FEAT-130 recorded corpus captured (${feat130.length} distinct inputs, its matcher sections A–D11)`, feat130.length >= 40);
  const fz = fuzzLines(FUZZ_N);
  const repoSets = CORPUS_REPOS.map((r) => [r, repoLines(r)]);
  for (const [name, inputs] of [['FEAT-130 corpus', feat130], [`fuzz (${FUZZ_N}, seed 236)`, fz], ...repoSets.map(([r, l]) => [`repo ${path.basename(r) === path.basename(ORCHARD) ? 'orchard' : 'corpus#' + CORPUS_REPOS.indexOf(r)} (${l.length} distinct lines)`, l])]) {
    const v = supersetViolations(head, cur, inputs);
    const hH = countHits(head, inputs), hN = countHits(cur, inputs);
    ok(`S1 new ⊇ HEAD over ${name}: HEAD ${hH} hits, new ${hN} (+${hN - hH}), violations ${v.length}`, v.length === 0 && hN >= hH, JSON.stringify(v.slice(0, 3)));
  }
  // findLeaks over multi-line blocks (the ticket-write guard path)
  const blocks = []; for (let i = 0; i + 5 <= fz.length && blocks.length < 2000; i += 5) blocks.push(fz.slice(i, i + 5).join('\n'));
  const fl = blocks.filter((b) => { const a = new Set(head.findLeaks(b).map((h) => `${h.lineNo}\0${h.token}`)); const nb = new Set(cur.findLeaks(b).map((h) => `${h.lineNo}\0${h.token}`)); return [...a].some((x) => !nb.has(x)); });
  ok(`S2 findLeaks ⊇ HEAD over ${blocks.length} multi-line blocks`, fl.length === 0, fl[0]);
  // MUST-FAIL: the checker catches a suppression (the round-2..4 shape: drop the unquoted
  // bare-assignment hits on a "code" line) — proves S1 is not vacuous.
  const suppressor = { ...cur,
    scanLine: (x) => /^\s*(const|let|var)\s/.test(x) ? cur.scanLine(x).filter((h) => h.token !== 'secret assignment') : cur.scanLine(x),
  };
  const sv = supersetViolations(head, suppressor, fz.map((l) => 'const ' + l));
  ok(`S3 MUST-FAIL: a synthetic code-line suppressor is caught by the same checker (${sv.length} violations)`, sv.length > 0);
  // The HEAD detection functions are byte-identical in the new module (only appended forms).
  const curSrc = fs.readFileSync(LT, 'utf8');
  const headSrc = execFileSync('git', ['show', 'HEAD:scripts/lib/leak-tokens.mjs'], { cwd: ORCHARD, encoding: 'utf8', maxBuffer: 64 << 20 });
  const detectRegion = (s) => s.slice(s.indexOf('const STRUCTURAL_PLACEHOLDER'), s.indexOf('export const ALLOWLIST_FILE'));
  const headLines = detectRegion(headSrc).split('\n');
  const curRegion = detectRegion(curSrc);
  const missingHeadLines = headLines.filter((l) => l.trim() && !curRegion.includes(l));
  ok(`S4 every line of HEAD's detection region (${headLines.length} lines) is present verbatim in the new module`, missingHeadLines.length === 0, missingHeadLines.slice(0, 5).join(' | '));
  console.log(`      (S took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ═══ A — every reconstructed round 1–4 attack input ═══════════════════════════
console.log('\n[A] round 1–4 independent-verify attack inputs');
const a1 = 'Ab1!' + 'Cd2!Ef3!Gh4!', a2 = '7Kx2.' + '9Qz4.3Mw8.5Rt1', a3 = 'Ab1,' + 'Cd2,Ef3,Gh4,Ij5', a4 = 'aB3!' + 'cD4!eF5!gH6!iJ7!kL8!';
const V3 = 'Vq7Nr' + '52dTm81YxKpLs';
const ATTACKS = [
  // round 1 (754de0b0 / 01a113c7 / 01a113ca) — P1
  ['R1', `${AK}: Ax9Kd82b.Qm10ZzPpLw`], ['R1', `${PW} = Tr0ub4dor.Xk9Lm2Qp`], ['R1', `${TK}: Ax9Kd82bQm10ZzPp.LwQr7Tv3Yu`],
  ['R1', `${PW}: xk3j9qpz7m2v8w4tq0r5`], ['R1', `${AK}: qwhzkpvmtnrxlbdjfsgc`], ['R1', `${CS}: X9K2M4P7Q1R8T3V6W5Z0`],
  ['R1', `${PW}: ${Q}hunterpassword${Q}`], ['R1', `${PW}: mznqvktprwslhfjdc`], ['R1', `${PW}: orchid7.Raven9`],
  ['R1', `${PW}: mnbvcxzlkjhgfdsapoiuytrewq`], ['R1', `${PW.toUpperCase()}=qwertyuiop`], ['R1', `${PW} = loadSecret(${Q}${SEC}${Q})`],
  // round 2 (01a1140c-95c9) — P1
  ['R2', `const ${PW} = ${BT}${SEC}\\${DOL}{suffix}${BT};`], ['R2', `const ${TK} = ${BT}${SEC}\\${DOL}{suffix}${BT};`],
  ['R2', `${PW} = ${Q}${Q}${Q}${SEC}${Q}${Q}${Q}`], ['R2', `${PW} = ${SQ}${SQ}${SQ}${SEC}${SQ}${SQ}${SQ}`],
  // round 3 (01a11576-69bc) — P1
  ['R3', `const ${PW} = /${V3}/.source;`], ['R3', `const ${PW} = String.raw${BT}${V3}${BT};`],
  // round 4 (b87a47bb) — P1, cases 1–11, then 14–19 (multi-line) and the survivors
  ['R4', `const ${PW} = decrypt(${Q}${a1}${Q});`], ['R4', `const ${PW} = decrypt(${Q}${a2}${Q});`], ['R4', `const ${PW} = decrypt(${Q}${a3}${Q});`],
  ['R4', `const ${PW} = /${a1}/.source;`], ['R4', `const ${PW} = String.raw${BT}${a1}${BT};`], ['R4', `const ${PW} = (${Q}${a1}${Q}) as string;`],
  ['R4', `const ${PW} = store[${Q}${a1}${Q}];`], ['R4', `const ${PW} = prefix + ${Q}${a1}${Q};`], ['R4', `${PW} = ${a1}`], ['R4', `${PW} = ${a2}`],
  ['R4', `const ${TK} = decode(${Q}${a4}${Q});`],
  ['R4', `const ${PW} = (\n  ${Q}${SEC}${Q}\n);`], ['R4', `const ${PW} =\n  ${Q}${SEC}${Q};`], ['R4', `${PW} = \\\n    ${Q}${SEC}${Q}`],
  ['R4', `${PW} = decrypt(\n    ${Q}${SEC}${Q}\n)`], ['R4', `const ${PW} = ${BT}\n${SEC}\n${BT};`], ['R4', `const ${PW} = isProd\n  ? ${Q}${SEC}${Q}\n  : devPw;`],
  ['R4', `const ${PW} = x + y // ${SEC}`], ['R4', `const ${PW} = cfg.pw /* ${SEC} */`], ['R4', `const ${PW} = f(Ax9Kd, 82bQm10ZzPpLw);`],
  ['R4', `const ${PW} = Ax9Kd82b.Qm10ZzPpLw;`], ['R4', `const ${PW} = X9K2M4P7Q1R8T3V6W5Z0;`], ['R4', `const ${PW} = ${SEC}!;`],
  ['R4', `const ${PW} = Ax9Kd82b Qm10ZzPpLw;`], ['R4', `const ${PW} = Ax9Kd82b​Qm10ZzPpLw;`],
];
const flaggedText = (m, text) => text.split('\n').some((l) => credHits(m, l).length > 0);
let aFlag = 0; const aGap = [];
for (const [rd, text] of ATTACKS) {
  const n = flaggedText(cur, text);
  if (n) { aFlag++; ok(`A ${rd} flagged: ${JSON.stringify(text).slice(0, 90)}`, true); continue; }
  const h = head ? flaggedText(head, text) : false;
  // Not flagged now: only acceptable as a PRE-EXISTING HEAD recall gap (HEAD never flagged
  // it either) — never as a suppression. Asserted, and listed separately in the summary.
  ok(`A ${rd} NOT flagged and HEAD did not flag it either (pre-existing recall gap, not a suppression): ${JSON.stringify(text).slice(0, 80)}`, !h);
  aGap.push(`${rd} ${JSON.stringify(text)}`);
}
console.log(`      A summary: ${aFlag}/${ATTACKS.length} attack inputs flagged; ${aGap.length} are HEAD recall gaps (HEAD never flagged them).`);

// ═══ W — single-line waiver ═══════════════════════════════════════════════════
console.log('\n[W] single-line credential waiver');
const parse = (t) => cur.parseAllowlist(t + '\n');
const refuses = (t) => parse(t).errors.length > 0;
const entriesOf = (t) => { const r = parse(t); if (r.errors.length) throw new Error(r.errors.join('; ')); return r.entries; };
const REASON = 'documented fixture value reviewed for this probe';
const ent = (rel, line, token = 'secret assignment', inPath = rel) => `token:${token} line:${cur.credentialFingerprint(rel, line)} in:${inPath} because: ${REASON}`;
/** Does `entriesText` waive every credential hit of `line` at `rel` (gate semantics)? */
const waivedAll = (entries, rel, lines, i) => {
  const pemSet = cur.privateKeyLines(lines);
  const hs = credHits(cur, lines[i]);
  return hs.length > 0 && hs.every((h) => cur.allowlistEntryFor(entries, rel, h, { line: lines[i], pem: pemSet.has(i) }));
};
const anyWaived = (entries, rel, lines, i) => {
  const pemSet = cur.privateKeyLines(lines);
  return credHits(cur, lines[i]).some((h) => cur.allowlistEntryFor(entries, rel, h, { line: lines[i], pem: pemSet.has(i) }));
};
{
  const L = `${PW}: ${SEC}`;
  const es = entriesOf(ent('cfg/f.yaml', L));
  ok('W1 the exact line in the exact path is waived', waivedAll(es, 'cfg/f.yaml', [L], 0));
  ok('W1b CRLF / trailing whitespace on the same line still waived (normalisation)', waivedAll(es, 'cfg/f.yaml', [L + '\r'], 0) && waivedAll(es, 'cfg/f.yaml', [L + '  \t'], 0));
  for (const [n, l2] of [['value changed by one char', `${PW}: ${SEC.slice(0, -1)}x`], ['appended second secret', `${L} ${SEC2}`], ['appended after #', `${L}#${SEC2}`],
    ['appended after ;', `${L};${SEC2}`], ['appended after ,', `${L},second`], ['leading indent added', `  ${L}`], ['key renamed', `${PW}2: ${SEC}`], ['trailing comment', `${L} # ok`]]) {
    ok(`W2 edited line NOT waived: ${n}`, !anyWaived(es, 'cfg/f.yaml', [l2], 0));
  }
  const two = [L, `${PW}: ${SEC2}`];
  ok('W3 the NEXT line (a different secret) is NOT waived', waivedAll(es, 'cfg/f.yaml', two, 0) && !anyWaived(es, 'cfg/f.yaml', two, 1));
  for (const p of ['cfg/F.yaml', 'CFG/f.yaml', 'f.yaml', 'x/cfg/f.yaml', 'cfg/f.yaml.bak', 'cfg/f.yml', 'cfg/f.yaml/']) {
    ok(`W4 same line under a different path NOT waived: ${p}`, !anyWaived(es, p, [L], 0));
  }
  ok('W4b `./cfg/f.yaml` and `cfg//f.yaml` in: normalise to the same exact path (waives)', waivedAll(entriesOf(ent('cfg/f.yaml', L, 'secret assignment', './cfg/f.yaml')), 'cfg/f.yaml', [L], 0)
    && waivedAll(entriesOf(ent('cfg/f.yaml', L, 'secret assignment', 'cfg//f.yaml')), 'cfg/f.yaml', [L], 0));
  ok('W4c fingerprint for one path under in: of another waives neither', !anyWaived(entriesOf(ent('cfg/f.yaml', L, 'secret assignment', 'cfg/g.yaml')), 'cfg/g.yaml', [L], 0)
    && !anyWaived(entriesOf(ent('cfg/f.yaml', L, 'secret assignment', 'cfg/g.yaml')), 'cfg/f.yaml', [L], 0));
  ok('W4d wrong token label does not waive', !anyWaived(entriesOf(ent('cfg/f.yaml', L, 'bearer token')), 'cfg/f.yaml', [L], 0));
  for (const [n, t] of [['glob in:', ent('cfg/f.yaml', L, 'secret assignment', 'cfg/*.yaml')], ['? glob in:', ent('cfg/f.yaml', L, 'secret assignment', 'cfg/f.yam?')],
    ['absolute in:', ent('cfg/f.yaml', L, 'secret assignment', '/cfg/f.yaml')], ['.. in:', ent('cfg/f.yaml', L, 'secret assignment', 'x/../cfg/f.yaml')],
    ['no in:', `token:secret assignment line:${cur.credentialFingerprint('cfg/f.yaml', L)} because: ${REASON}`],
    ['no line:', `token:secret assignment in:cfg/f.yaml because: ${REASON}`],
    ['short fingerprint', `token:secret assignment line:sha256:abc in:cfg/f.yaml because: ${REASON}`],
    ['uppercase fingerprint', `token:secret assignment line:${cur.credentialFingerprint('cfg/f.yaml', L).toUpperCase()} in:cfg/f.yaml because: ${REASON}`],
    ['match: on credential', `token:secret assignment match:${PW}=… in:cfg/f.yaml because: ${REASON}`],
    ['match: + line:', `${ent('cfg/f.yaml', L).replace(' in:', ` match:${PW}=… in:`)}`],
    ['retired value:', `token:secret assignment value:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because: ${REASON}`],
    ['line: without token', `line:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because: ${REASON}`],
    ['line: on a project token', `token:private project A (bot) line:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because: ${REASON}`],
    ['in: targets the allowlist', ent(ALLOW, L, 'secret assignment', ALLOW)], ['in: targets ./allowlist', ent(ALLOW, L, 'secret assignment', './' + ALLOW)],
    ['in: targets sub/allowlist', ent('sub/' + ALLOW, L, 'secret assignment', 'sub/' + ALLOW)],
    ['PEM label', `token:private key (PEM header) line:${cur.credentialFingerprint('k.pem', PEM_B)} in:k.pem because: ${REASON}`],
    ['empty reason', `token:secret assignment line:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because:`],
    ['whitespace reason', `token:secret assignment line:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because:      `],
    ['short reason', `token:secret assignment line:${cur.credentialFingerprint('cfg/f.yaml', L)} in:cfg/f.yaml because: ok`],
    ['identity label', `token:home path in:docs/x.md because: ${REASON}`]]) {
    ok(`W5 parse REFUSES: ${n}`, refuses(t));
  }
  // DRAFT entries are refused by STRUCTURE (round-5 IV 01a11662), whatever the reason says.
  const fpL = cur.credentialFingerprint('cfg/f.yaml', L);
  const real = `token:secret assignment line:${fpL} in:cfg/f.yaml because: ${REASON}`;
  for (const [n, t] of [['DRAFT + real reason', `${cur.DRAFT_MARKER} ${real}`], ['draft lowercase', `draft ${real}`], ['DRAFT: form', `DRAFT:${real}`],
    ['DRAFT + empty reason', `${cur.DRAFT_MARKER} token:secret assignment line:${fpL} in:cfg/f.yaml because:`],
    ['DRAFT + review_pending_TODO', `${cur.DRAFT_MARKER} token:secret assignment line:${fpL} in:cfg/f.yaml because: review_pending_TODO`],
    ['DRAFT alone', cur.DRAFT_MARKER]]) ok(`W5b DRAFT-marked entry REFUSED regardless of reason: ${n}`, refuses(t));
  // MUST-FAIL: the round-5 pre-fix reason regex accepted a placeholder spelled around it — the
  // exact IV input. Reconstructed verbatim (the pre-fix parser refused a reason iff it matched).
  const PRE_FIX_DRAFT_RE = /\btodo/i;
  ok('W5c MUST-FAIL: the pre-fix reason regex ACCEPTED `review_pending_TODO` (IV 01a11662 break)', !PRE_FIX_DRAFT_RE.test('review_pending_TODO'));
  ok('W5d post-fix: no reason-text rule — any human non-empty reason is accepted (incl. review_pending_TODO, TODOs)',
    !refuses(`token:secret assignment line:${fpL} in:cfg/f.yaml because: review_pending_TODO`) && !refuses(`token:secret assignment line:${fpL} in:cfg/f.yaml because: TODOs are done, fixture only`));
  // Reason must contain a Unicode letter or digit (IV 74fe2bdd: a NEL-only reason survived trim()).
  const blankReason = (r) => `token:secret assignment line:${fpL} in:cfg/f.yaml because: ${r}`;
  // NEL at both ends is outside JS trim(), so trim() strips nothing — every case below was
  // ACCEPTED by the pre-fix rule (trim + length ≥ 10), whichever characters fill the middle.
  const pad = (c) => '\u0085' + c.repeat(12) + '\u0085';
  for (const [n, r] of [['NEL U+0085', pad('\u0085')], ['NBSP U+00A0', pad(' ')], ['zero-width U+200B', pad('​')], ['ZWJ/ZWNJ', pad('‌‍')],
    ['ideographic space U+3000', pad('　')], ['word joiner U+2060', pad('⁠')], ['BOM U+FEFF', pad('﻿')], ['line/para sep U+2028/9', pad('  ')],
    ['punctuation only', '------------....'], ['symbols/emoji only', pad('★')], ['mixed invisibles', '\u0085 ​　⁠'.repeat(3)]]) {
    // MUST-FAIL: the pre-fix rule (trim + length >= 10) ACCEPTED it — so the new rule is what refuses.
    const t = r.trim();
    ok(`W5e reason of only ${n}: pre-fix length rule accepted (${t.length} chars) and post-fix REFUSES`, t.length >= 10 && refuses(blankReason(r)), JSON.stringify(parse(blankReason(r)).errors));
  }
  ok('W5f a non-Latin reason with letters is accepted (日本語の説明: テスト用の固定値)', !refuses(blankReason('日本語の説明: テスト用の固定値')));
  // A credential found INSIDE the allowlist file is never waived, even by a forged entry
  // object that bypassed the parser.
  const forged = [{ lineNo: 1, reason: REASON, token: 'aws access key id (AKIA/ASIA)', line: cur.credentialFingerprint(ALLOW, `x ${AKIA_DOC}`), in: ALLOW, inPath: ALLOW }];
  const h = credHits(cur, `x ${AKIA_DOC}`)[0];
  ok('W6 a credential inside the allowlist file is never waived (forged entry, plain and ./ path)', h && !cur.allowlistEntryFor(forged, ALLOW, h, { line: `x ${AKIA_DOC}`, pem: false })
    && !cur.allowlistEntryFor(forged, './' + ALLOW, h, { line: `x ${AKIA_DOC}`, pem: false }));
  ok('W6b no ctx (binary chunk / commit message) ⇒ credential never waivable', !cur.allowlistEntryFor(es, 'cfg/f.yaml', credHits(cur, L)[0]));
  ok('W6c a tokenless match:-only entry never waives a credential', !cur.allowlistEntryFor(entriesOf(`match:Zz${'Yy'}Xx in:cfg/f.yaml because: ${REASON}`), 'cfg/f.yaml', credHits(cur, L)[0], { line: L, pem: false }));
  // Non-credential FEAT-156 waivers are unchanged.
  const projLine = 'see ' + 'saa' + 'sis docs';
  const pe = entriesOf(`token:private project A (bot) in:docs/*.md because: ${REASON}`);
  const ph = cur.scanLine(projLine).find((x) => x.token === 'private project A (bot)');
  ok('W7 FEAT-156 project-token glob waiver unchanged', ph && cur.allowlistEntryFor(pe, 'docs/a.md', ph) && !cur.allowlistEntryFor(pe, 'src/a.md', ph));
}
{
  // PEM — never waivable: header, body lines, END line, unterminated, no cap, same-line tails.
  console.log('  -- private-key material');
  const body = (k) => 'MIIexample' + 'LINE' + String(k).padStart(4, '0');
  const big = [PEM_B, ...Array.from({ length: 260 }, (_, k) => body(k)), PEM_E, 'after'];
  const set = cur.privateKeyLines(big);
  ok('W8 a 262-line block: header, all 260 body lines and END are PEM material (no cap); the line after is not', set.has(0) && set.has(231) && set.has(260) && set.has(261) && !set.has(262));
  const tail = [`${PEM_B} QUJD ${PEM_E} ${PEM_B}`, 'MIIexampleBBBB', PEM_E, 'x'];
  const ts = cur.privateKeyLines(tail);
  ok('W9 round-4 dangling same-line BEGIN keeps the block open: lines 1–3 PEM material, line 4 not', ts.has(0) && ts.has(1) && ts.has(2) && !ts.has(3));
  const unterminated = ['x', RSA_B, 'MIIabc', `${AK}: ${SEC}`, 'y'];
  const us = cur.privateKeyLines(unterminated);
  ok('W10 an unterminated block runs to end of file', !us.has(0) && us.has(1) && us.has(4));
  ok('W11 the PEM header hit is never waived (even by a forged entry object)', !cur.allowlistEntryFor([{ lineNo: 1, reason: REASON, token: 'private key (PEM header)', line: cur.credentialFingerprint('k.pem', PEM_B), in: 'k.pem', inPath: 'k.pem' }],
    'k.pem', credHits(cur, PEM_B).find((x) => x.token === 'private key (PEM header)'), { line: PEM_B, pem: false }));
  const es = entriesOf(ent('k.txt', unterminated[3]));
  ok('W12 a valid line waiver for a credential line INSIDE a private-key block does not apply', !anyWaived(es, 'k.txt', unterminated, 3));
  ok('W12b …the same line outside any block IS waived (control)', waivedAll(es, 'k.txt', [unterminated[3]], 0));
  const pgp = ['-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----', `${AK}: ${SEC}`, '-----END ' + 'PGP PRIVATE KEY BLOCK-----'];
  ok('W13 PGP private key block lines are PEM material (looser marker than detection)', cur.privateKeyLines(pgp).has(1));
  const twoOnLine = `${PEM_B} QUJDREVGR0g= ${PEM_E} ${PEM_B} SUpLTE1OT1A= ${PEM_E}`;
  ok('W14 round-3 two-blocks-on-one-line: header hit not waivable', credHits(cur, twoOnLine).some((x) => x.token === 'private key (PEM header)') && cur.privateKeyLines([twoOnLine]).has(0));
}
{
  // Round 1–4 P2 attack replays under the single-line rule.
  console.log('  -- round 1–4 P2 attack replays');
  const r1 = [`${PW}: ${SEC}`, '// later', `${PW}: ${SEC2}`];
  ok('W15 R1-A one entry cannot cover two secrets on two lines', !anyWaived(entriesOf(ent('src/config.js', r1[0])), 'src/config.js', r1, 2));
  const r1c = [`a ${AKIA}`, 'b', `c ${AKIA}`];
  ok('W16 R1-C an AKIA waiver for line 1 does not cover line 3 (different line content)', waivedAll(entriesOf(ent('src/f.txt', r1c[0], 'aws access key id (AKIA/ASIA)')), 'src/f.txt', r1c, 0)
    && !anyWaived(entriesOf(ent('src/f.txt', r1c[0], 'aws access key id (AKIA/ASIA)')), 'src/f.txt', r1c, 2));
  const sk1 = 'sk-' + 'ant-api03-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv-FIRST';
  ok('W17 R2-A sk- prefix collision: waiver for -FIRST does not cover -SECOND', !anyWaived(entriesOf(ent('keys.txt', sk1, 'openai/anthropic api key (sk-)')), 'keys.txt', [sk1.replace('FIRST', 'SECOND')], 0));
  ok('W18 R2-B comma truncation: waiver for ,first does not cover ,second', !anyWaived(entriesOf(ent('config.yaml', `${PW}: ${SEC},first`)), 'config.yaml', [`${PW}: ${SEC},second`], 0));
  ok('W19 R2-C allowlist self-waive refused at parse', refuses(`token:aws access key id (AKIA/ASIA) line:${cur.credentialFingerprint(ALLOW, 'x')} in:${ALLOW} because: documented example ${AKIA_DOC}`));
  for (const sepc of ['#', ';', ' ']) ok(`W20 R3-A scalar truncation at ${JSON.stringify(sepc)}: base waiver does not cover the extended line`,
    !anyWaived(entriesOf(ent('fixture.yaml', `${PW}: ${SEC}`)), 'fixture.yaml', [`${PW}: ${SEC}${sepc}By8Le73cRn21YyOoKv`], 0));
}
{
  // Fuzz: waived ⇔ same normalised path and same normalised line.
  console.log('  -- waiver fuzz');
  // PEM lines are excluded here (never waivable — W8–W14 cover them).
  const r = rng(4236); const lines = fuzzLines(4000, 99).filter((l) => !l.includes('\n') && credHits(cur, l).length
    && !cur.privateKeyLines([l]).size && credHits(cur, l)[0].token !== cur.PEM_TOKEN);
  let checked = 0, wrong = 0, ex = '';
  const paths = ['a.yaml', 'b/c.ts', 'B/c.ts', 'b/c.ts.bak'];
  for (const l of lines) {
    const rel = paths[Math.floor(r() * 2)];
    const es = entriesOf(ent(rel, l, credHits(cur, l)[0].token));
    const k = Math.floor(r() * 5);
    let l2 = l, rel2 = rel;
    if (k === 0) { const p = Math.floor(r() * l.length); l2 = l.slice(0, p) + String.fromCharCode(33 + Math.floor(r() * 90)) + l.slice(p + 1); }
    else if (k === 1) l2 = l + ' ' + SEC2;
    else if (k === 2) rel2 = paths[Math.floor(r() * paths.length)];
    else if (k === 3) l2 = l + (r() < 0.5 ? '\r' : '   ');
    const lines2 = [l2];
    const hs = credHits(cur, l2).filter((h) => h.token === credHits(cur, l)[0].token);
    if (!hs.length) continue;
    const sameNorm = cur.normalizeWaiverPath(rel2) === cur.normalizeWaiverPath(rel) && l2.trimEnd() === l.trimEnd();
    const w = hs.some((h) => cur.allowlistEntryFor(es, rel2, h, { line: l2, pem: cur.privateKeyLines(lines2).has(0) }));
    const pemLine = cur.privateKeyLines(lines2).has(0);
    checked++;
    if (w !== (sameNorm && !pemLine)) { wrong++; ex = ex || JSON.stringify({ l, l2, rel, rel2 }); }
  }
  ok(`W21 fuzz: ${checked} (line, edit/path) pairs — waived iff same normalised path + line and not PEM material; mismatches ${wrong}`, checked > 1000 && wrong === 0, ex);
}

// ═══ D/G — the real gate end to end through a read-only fake `git` ════════════
console.log('\n[G] gate end to end (REPO mode, fake read-only git on PATH)');
const SHIM_DIR = path.join(TMP, 'bin');
fs.mkdirSync(SHIM_DIR);
// Only the read-only calls the gate makes in default REPO mode are served; anything else is
// refused, so the fake can never be mistaken for a real repo.
fs.writeFileSync(path.join(SHIM_DIR, 'git'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const a = process.argv.slice(2); const root = process.cwd();
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(path.relative(root, p).split(path.sep).join('/')); } return out; };
const j = a.join(' ');
if (j === 'rev-parse --show-toplevel') { process.stdout.write(root + '\\n'); process.exit(0); }
if (j === 'ls-files -z -co --exclude-standard') { process.stdout.write(walk(root).map((f) => f + '\\0').join('')); process.exit(0); }
if (j === 'ls-files -s -z -- ${ALLOW}') { const f = path.join(root, '${ALLOW}'); if (fs.existsSync(f)) { const b = fs.readFileSync(f); process.stdout.write('100644 ' + crypto.createHash('sha1').update('blob ' + b.length + '\\0').update(b).digest('hex') + ' 0\\t${ALLOW}\\0'); } process.exit(0); }
if (j === 'show :${ALLOW}') { process.stdout.write(fs.readFileSync(path.join(root, '${ALLOW}'))); process.exit(0); }
process.stderr.write('fake-git: refused ' + j + '\\n'); process.exit(128);
`, { mode: 0o755 });
const gateRun = (dir, extra = []) => spawnSync(process.execPath, [GATE, ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}` } });
{
  const D = path.join(TMP, 'repo1'); fs.mkdirSync(path.join(D, 'src'), { recursive: true });
  const codeLine = `const ${PW} = data.${PW}Field;`;           // the BUG-236 false-positive shape
  const fixLine = `${AK}: ${Q}${SEC}${Q}`;
  fs.writeFileSync(path.join(D, 'src', 'login.ts'), `import x from 'y';\n${codeLine}\n`);
  fs.writeFileSync(path.join(D, 'fixtures.yaml'), `${fixLine}\nother: 1\n`);
  fs.writeFileSync(path.join(D, 'k.pem'), `${PEM_B}\nMIIexampleAAAA\n${PEM_E}\n`);
  let r = gateRun(D);
  ok('G1 the BUG-236 code shape IS flagged (no suppression) and the gate fails', r.status === 1 && /login\.ts:2: \[secret assignment\]/.test(r.stderr), r.stderr.slice(0, 300));
  ok('G1b the PEM hit prints NOT waivable, the others print a line: hint', /k\.pem:1: \[private key \(PEM header\)\].*NOT waivable/.test(r.stderr) && /line:sha256:[0-9a-f]{64} in:fixtures\.yaml/.test(r.stderr));
  const dr = gateRun(D, ['--draft-waivers', D]);
  ok('D1 --draft-waivers exits 1 (not a pass) and prints a DRAFT-marked, empty-reason entry per waivable credential hit', dr.status === 1 && (dr.stdout.match(/^DRAFT token:[^\n]*because:$/mg) ?? []).length === 2 && !/^token:/m.test(dr.stdout) && /NOT waivable/.test(dr.stdout), dr.stdout.slice(0, 500));
  fs.writeFileSync(path.join(D, ALLOW), dr.stdout);
  r = gateRun(D);
  ok('D2 the drafted allowlist as-is is REFUSED (DRAFT marker) — exit 2, nothing waived', r.status === 2 && /DRAFT entry/.test(r.stderr), r.stderr.slice(0, 300));
  fs.writeFileSync(path.join(D, ALLOW), dr.stdout.split('\n').map((l) => l.replace(/^DRAFT /, '').replace(/because:$/, 'because: reviewed: code reference / documented fixture, not a live secret')).join('\n'));
  r = gateRun(D);
  ok('D3 with real reasons the two code/fixture lines are waived; the PEM still fails the gate', r.status === 1 && /waived src\/login\.ts:2/.test(r.stdout) && /waived fixtures\.yaml:1/.test(r.stdout) && /k\.pem:1/.test(r.stderr) && !/login\.ts:2: \[/.test(r.stderr), r.stdout.slice(0, 400) + r.stderr.slice(0, 400));
  fs.rmSync(path.join(D, 'k.pem'));
  r = gateRun(D);
  ok('G2 without the PEM the gate PASSES on the reviewed line waivers', r.status === 0, r.stdout.slice(-300) + r.stderr.slice(0, 300));
  fs.writeFileSync(path.join(D, 'fixtures.yaml'), `${fixLine}\nother: 1\n${fixLine.replace(SEC, SEC2)}\n`);
  r = gateRun(D);
  ok('G3 a NEW line with a different secret below the waived one fails', r.status === 1 && /fixtures\.yaml:3:/.test(r.stderr) && !/fixtures\.yaml:1:/.test(r.stderr));
  fs.writeFileSync(path.join(D, 'fixtures.yaml'), `${fixLine} ${SEC2}\nother: 1\n`);
  r = gateRun(D);
  ok('G4 appending to the waived line voids the waiver', r.status === 1 && /fixtures\.yaml:1:/.test(r.stderr));
  fs.writeFileSync(path.join(D, 'fixtures.yaml'), `${fixLine}\nother: 1\n`);
  fs.mkdirSync(path.join(D, 'copy')); fs.writeFileSync(path.join(D, 'copy', 'fixtures.yaml'), `${fixLine}\n`);
  r = gateRun(D);
  ok('G5 the same line in another path is not waived', r.status === 1 && /copy\/fixtures\.yaml:1:/.test(r.stderr) && !/^fixtures\.yaml:1:/m.test(r.stderr));
  fs.rmSync(path.join(D, 'copy'), { recursive: true });
  fs.appendFileSync(path.join(D, ALLOW), `# example: ${AKIA_DOC}\n`);
  r = gateRun(D);
  fs.writeFileSync(path.join(D, 'long.js'), `${PW} = ${Q}fixture-example-value${Q}${' '.repeat(170)}; ${AK} = ${Q}${SEC2}${Q}\n`);
  r = gateRun(D);
  ok('G7 a credential line longer than the printed excerpt carries a REVIEW THE FULL LINE note (review 6a1f32d0)', r.status === 1 && /long\.js:1: .*REVIEW THE FULL LINE/.test(r.stderr));
  fs.rmSync(path.join(D, 'long.js'));
  ok('G6 a credential written inside the allowlist file fails and prints NOT waivable', r.status === 1 && new RegExp(ALLOW.replace('.', '\\.') + ':\\d+: \\[aws').test(r.stderr) && /NOT waivable/.test(r.stderr));
}

// ═══ summary ═════════════════════════════════════════════════════════════════
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nBUG-236 round 5: ${pass} pass, ${fail} fail, ${skip} skip`);
if (aGap.length) { console.log(`HEAD recall gaps among the attack inputs (never flagged by HEAD; NOT a suppression) — ${aGap.length}:`); for (const g of aGap) console.log('  - ' + g); }
if (fail) { console.log('FAILED:'); for (const b of bad) console.log('  - ' + b); process.exit(1); }
