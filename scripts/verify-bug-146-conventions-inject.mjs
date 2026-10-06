/**
 * BUG-146 — the injected local-conventions doc.
 *
 *   node scripts/verify-bug-146-conventions-inject.mjs
 *
 * Renders the injected `# Project Conventions (local)` section (the REAL
 * localConventionsSection() in src/server/templates.ts) for (1) THIS repo and
 * (2) a fresh, stub-onboarded temp repo, printing observed sizes and the start
 * and end of the injected region.
 *
 * Two defects (BUG-146):
 *   half 1 — the whole doc was hard-capped, silently, so ~79% never reached a
 *            session (including the BUG-148 git-identity and BUG-103 rg rules);
 *   half 2 — an unedited onboard scaffold injected ~244 tokens/turn to say
 *            nothing.
 *
 * MUST-FAIL is anchored to a SYNTHESIZED pre-fix function (`oldSection`, the
 * verbatim pre-change body) run against the REAL pre-change doc (git show
 * HEAD) — not to a moving baseline (docs/CONVENTIONS.md is being changed by
 * this very fix). The same assertion battery is run against both the old and
 * the new function: it must FAIL on old, PASS on new.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-data-'));
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0, skipped = 0;
const failed = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed !== undefined ? `\n        observed: ${observed}` : ''}`);
  if (ok) pass++; else { fail++; failed.push(name); }
}
function skip(name, reason) {
  console.log(`  SKIP  ${name}\n        reason: ${reason}`);
  skipped++;
}

const normLE = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

/* round-2 (pre-fix) over-cap truncation of a region body: NO line-ending
   normalise, boundary search only on '\n\n', else a hard mid-line slice. This is
   the exact algorithm this round replaces; used as the fixed must-FAIL baseline
   for the CRLF (finding 1) and no-blank-line (finding 3) edge cases. */
function preFixKept(regionBody, budget) {
  const body = regionBody.trim();
  if (budget <= 0) return '';
  const slice = body.slice(0, budget);
  const brk = slice.lastIndexOf('\n\n');
  return (brk > budget * 0.5 ? slice.slice(0, brk) : slice).trimEnd();
}

/* The kept BODY portion of a rendered section — everything before the loud
   TRUNCATED notice (and the `---` rule that precedes it). */
function keptPortion(section) {
  const i = section.indexOf('⚠ **TRUNCATED');
  const k = i >= 0 ? section.slice(0, i) : section;
  return k.replace(/\n+-{3,}\s*$/, '').trimEnd();
}

/* Does `kept` end on a COMPLETE line of the (LF-normalised) region body, i.e.
   not mid-word / mid-line? This is the property both edge fixes must satisfy. */
function endsOnLineBoundary(kept, regionBody) {
  const nb = normLE(regionBody).trim();
  const lastLine = normLE(kept).split('\n').pop();
  if (!lastLine) return true;
  return nb.includes(lastLine + '\n') || nb.endsWith(lastLine);
}

function writeMarkedDoc(dir, regionBody, relpath) {
  fs.mkdirSync(path.join(dir, path.dirname(relpath)), { recursive: true });
  const doc = `# Conv\n\n<!-- conventions-inject:start -->\n${regionBody}\n<!-- conventions-inject:end -->\n`;
  fs.writeFileSync(path.join(dir, relpath), doc);
}

/* ---- verbatim reproduction of the PRE-BUG-146 localConventionsSection body,
   as a fixed must-FAIL baseline (no stub detection, no markers, cap 6000). ---- */
function oldSection(raw, convRel) {
  const body = raw.trim();
  if (!body) return null;
  const maxChars = 6000;
  const header = [
    '# Project Conventions (local)', '',
    `_Auto-injected at launch from ${convRel} (read-only). Project-specific rules ` +
      'only — anything universal belongs in the shared Working Agreement instead (see WA §L / ' +
      '`scripts/check-scope.mjs`).', '',
  ].join('\n');
  const full = header + body;
  if (full.length <= maxChars) return full;
  const notice = (dropped) =>
    `\n\n---\n\n⚠ TRUNCATED — ${dropped} of ${body.length} characters of ${convRel} are NOT here. Read the file.`;
  let budget = maxChars - header.length - notice(body.length).length;
  const cut = (b) => {
    if (b <= 0) return '';
    const slice = body.slice(0, b);
    const brk = slice.lastIndexOf('\n\n');
    return (brk > b * 0.5 ? slice.slice(0, brk) : slice).trimEnd();
  };
  let kept = cut(budget);
  budget = maxChars - header.length - notice(body.length - kept.length).length;
  kept = cut(budget);
  return header + kept + notice(body.length - kept.length);
}

// The rules an agent must receive; all were past the pre-change cut.
const MUST_HAVE = [
  ['BUG-148 git-identity rule', 'never put an identity on a commit command line'],
  ['BUG-103 rg-not-grep rule', "never the Bash `grep` shim"],
  ['must-FAIL / moving-baseline rule', 'must not be anchored to a moving baseline'],
  ['separate-process verification rule', 'Separate process, not a subagent'],
];
// Framing/history that BELONGS in the file but NOT in the injected region.
const BACKGROUND_ONLY = [
  ['ARCH-010 "58 of 119" framing', '58 of 119'],
  ['worked-examples list', 'Worked examples on this board'],
];

function assertBattery(label, section, { expectNull = false } = {}) {
  console.log(`\n--- ${label} ---`);
  if (expectNull) {
    check(`${label}: injects NOTHING (null)`, section === null, JSON.stringify(section)?.slice(0, 60));
    return;
  }
  check(`${label}: section is non-null`, typeof section === 'string' && section.length > 0, typeof section);
  const s = section ?? '';
  console.log(`        size: ${s.length} chars`);
  console.log(`        START: ${JSON.stringify(s.slice(0, 140))}`);
  console.log(`        END:   ${JSON.stringify(s.slice(-140))}`);
  for (const [n, needle] of MUST_HAVE) {
    check(`${label}: contains ${n}`, s.includes(needle), s.includes(needle) ? 'present' : 'MISSING');
  }
}

async function main() {
  const { localConventionsSection, LOCAL_CONVENTIONS_RELPATH } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  const convRel = 'docs/CONVENTIONS.md';

  // === MUST-FAIL: synthesized pre-fix function on the REAL pre-change doc ===
  // Strip-survivable (BUG-146 round 3): a clean-room export has no `.git`, so the
  // `git show HEAD:` baseline is unavailable there. Skip with a reason rather
  // than FATAL — the edge-case must-FAILs below synthesize their own fixed
  // baselines and do not need git.
  console.log('=== MUST-FAIL leg: pre-change function (oldSection) on the pre-change doc (git HEAD) ===');
  let preRaw = null;
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    try {
      preRaw = execFileSync('git', ['show', 'HEAD:docs/CONVENTIONS.md'], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      skip('MUST-FAIL (pre-change HEAD leg)', `git show failed: ${String(e.message).split('\n')[0]}`);
    }
  } else {
    skip('MUST-FAIL (pre-change HEAD leg)', 'no .git here (clean-room export) — pre-change baseline unavailable');
  }
  if (preRaw != null) {
    const oldOut = oldSection(preRaw, convRel);
    const oldMissing = MUST_HAVE.filter(([, needle]) => !oldOut.includes(needle)).map(([n]) => n);
    console.log(`  pre-change injected size: ${oldOut.length} chars; ends: ${JSON.stringify(oldOut.slice(-80))}`);
    check('MUST-FAIL reproduced: pre-change code DROPS agent-facing rules',
      oldMissing.length > 0, `dropped: ${oldMissing.join(' | ') || 'none — defect NOT reproduced!'}`);
    // Old code on the stub injects it (half 2 defect).
    const { CONVENTIONS_STUB } = await import(path.join(ROOT, 'scripts', 'lib', 'conventions-stub.mjs'));
    const oldStub = oldSection(CONVENTIONS_STUB, convRel);
    check('MUST-FAIL reproduced: pre-change code injects the unedited stub (non-null)',
      oldStub !== null && oldStub.includes('Add this project'), oldStub === null ? 'null' : `${oldStub.length} chars`);
  }

  // === THE FIX: real localConventionsSection on THIS repo ===
  const repoSection = localConventionsSection(ROOT);
  assertBattery('THIS repo (post-fix)', repoSection);
  const rs = repoSection ?? '';
  check('THIS repo: marked-region delimiters are STRIPPED (region extracted, not raw doc)',
    !rs.includes('conventions-inject'), rs.includes('conventions-inject') ? 'markers leaked' : 'stripped');
  for (const [n, needle] of BACKGROUND_ONLY) {
    check(`THIS repo: background-only text NOT in region — ${n}`, !rs.includes(needle),
      rs.includes(needle) ? 'leaked into region' : 'correctly excluded');
    // ...but it IS still in the file:
    const fileText = fs.readFileSync(path.join(ROOT, convRel), 'utf8');
    check(`THIS repo: ${n} still EXISTS in the file (moved, not deleted)`, fileText.includes(needle),
      fileText.includes(needle) ? 'present in file' : 'LOST FROM FILE');
  }
  check('THIS repo: region delivered WHOLE — no TRUNCATED notice fired', !rs.includes('TRUNCATED'),
    rs.includes('TRUNCATED') ? 'truncated' : 'whole');
  check('THIS repo: does not end mid-word (ends on a rule/paren boundary)',
    /[.)\]`_]\s*$/.test(rs.trimEnd()), JSON.stringify(rs.slice(-24)));

  // === MUST-FAIL (region cap): the OLD 26000 region cap truncated the REAL
  // doc's region and dropped its trailing rule. Anchored to the fixed value
  // 26000 (the pre-fix region default) run against the REAL current doc — not a
  // moving baseline. This is the defect this round fixes: the decision says the
  // marked region is delivered WHOLE, and 26000 silently cut it. ===
  console.log('\n--- MUST-FAIL leg: the pre-fix region cap (26000) on the REAL current doc ---');
  const underOldCap = localConventionsSection(ROOT, { maxChars: 26000 }) ?? '';
  console.log(`        size under 26000 cap: ${underOldCap.length} chars`);
  check('MUST-FAIL reproduced: pre-fix 26000 cap TRUNCATES the real region (notice fires)',
    underOldCap.includes('TRUNCATED'), underOldCap.includes('TRUNCATED') ? 'truncated (as before the fix)' : 'not truncated');
  check('MUST-FAIL reproduced: pre-fix 26000 cap DROPS the separate-process rule',
    !underOldCap.includes('Separate process, not a subagent'),
    underOldCap.includes('Separate process, not a subagent') ? 'rule still present' : 'rule dropped (as before the fix)');

  // === The loud-truncation SAFETY path still works: a runaway region over the
  // generous bound truncates LOUDLY (visible notice, markdown boundary), never
  // silently. Anchored to a fixed tiny cap, not a moving baseline. ===
  console.log('\n--- SAFETY leg: a region over its cap truncates LOUD, not silent ---');
  const tiny = localConventionsSection(ROOT, { maxChars: 2000 }) ?? '';
  check('SAFETY: over-cap region fires the LOUD TRUNCATED notice', tiny.includes('TRUNCATED'),
    tiny.includes('TRUNCATED') ? 'loud notice present' : 'SILENT CUT — bug');
  check('SAFETY: truncated output does not end mid-word', /[.)\]`_]\s*$/.test(tiny.trimEnd()),
    JSON.stringify(tiny.slice(-24)));

  // === ROUND-3 edge defects of the LOUD-STOP path (independent-verify run
  //     b9874b48 — 3 VALID BROKEN findings). Each: must-FAIL on the pre-fix
  //     algorithm, PASS on the real (fixed) function. Fixed, synthetic
  //     baselines — no moving reference, no .git needed. ===

  // --- Finding 1: CRLF over-cap region cut mid-rule (templates.ts cut()) ---
  console.log('\n--- Finding 1 (CRLF boundary): pre-fix cuts mid-line, fix ends on a boundary ---');
  const crlfBody = Array.from({ length: 40 }, (_, i) =>
    `- crlf rule ${i} with enough words on the line to matter here`).join('\r\n\r\n');
  const preCrlf = preFixKept(crlfBody, 500);
  check('MUST-FAIL reproduced: pre-fix CRLF cut lands mid-line (no \\n\\n found)',
    !endsOnLineBoundary(preCrlf, crlfBody), JSON.stringify(normLE(preCrlf).slice(-40)));
  const crlfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-crlf-'));
  writeMarkedDoc(crlfDir, crlfBody, LOCAL_CONVENTIONS_RELPATH);
  const crlfSec = localConventionsSection(crlfDir, { maxChars: 900 }) ?? '';
  check('FIX: CRLF over-cap region truncates LOUDLY', crlfSec.includes('TRUNCATED'),
    crlfSec.includes('TRUNCATED') ? 'loud' : 'silent');
  check('FIX: CRLF kept text ends on a line boundary (not mid-rule)',
    endsOnLineBoundary(keptPortion(crlfSec), crlfBody),
    JSON.stringify(keptPortion(crlfSec).slice(-40)));

  // --- Finding 3: a doc with NO blank line hard-slices mid-word ---
  console.log('\n--- Finding 3 (no blank line): pre-fix hard-slices mid-word, fix falls to a line break ---');
  const denseBody = Array.from({ length: 60 }, (_, i) =>
    `- dense rule ${i} packed with several words words words on one line`).join('\n');
  const preDense = preFixKept(denseBody, 500);
  check('MUST-FAIL reproduced: pre-fix no-blank-line cut lands mid-word',
    !endsOnLineBoundary(preDense, denseBody), JSON.stringify(preDense.slice(-40)));
  const denseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-dense-'));
  writeMarkedDoc(denseDir, denseBody, LOCAL_CONVENTIONS_RELPATH);
  const denseSec = localConventionsSection(denseDir, { maxChars: 900 }) ?? '';
  check('FIX: no-blank-line region truncates LOUDLY', denseSec.includes('TRUNCATED'),
    denseSec.includes('TRUNCATED') ? 'loud' : 'silent');
  check('FIX: no-blank-line kept text ends on a line boundary (not mid-word)',
    endsOnLineBoundary(keptPortion(denseSec), denseBody),
    JSON.stringify(keptPortion(denseSec).slice(-40)));

  // --- Finding 2: the cap is measured in CHARACTERS, consistently ---
  console.log('\n--- Finding 2 (consistent unit = chars): bytes>cap but chars<cap → whole; chars>cap → truncates ---');
  // ~30k multibyte chars = ~90k BYTES (>65536) but 30k CHARS (<65536).
  const mbLines = Array.from({ length: 300 }, () => '✦'.repeat(99)).join('\n'); // 300*100-1 ≈ 29999 chars, ~3 B/char
  const mbBytes = Buffer.byteLength(mbLines, 'utf8');
  const mbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-mb-'));
  writeMarkedDoc(mbDir, mbLines, LOCAL_CONVENTIONS_RELPATH);
  const mbSec = localConventionsSection(mbDir) ?? ''; // DEFAULT 65536-char cap
  check(`FIX: region of ${mbLines.length} chars / ${mbBytes} bytes delivered WHOLE under the char cap`,
    !mbSec.includes('TRUNCATED') && mbSec.includes('✦'),
    `${mbBytes} bytes > 65536; ${mbLines.length} chars < 65536; truncated=${mbSec.includes('TRUNCATED')}`);
  // >65536 CHARS → the char cap bites (proves the unit is chars, not bytes).
  const bigChars = Array.from({ length: 1400 }, (_, i) => `- ascii rule ${i} with a good many words on this line here`).join('\n\n');
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-big-'));
  writeMarkedDoc(bigDir, bigChars, LOCAL_CONVENTIONS_RELPATH);
  const bigSec = localConventionsSection(bigDir) ?? '';
  check(`FIX: region of ${bigChars.length} chars (>65536) truncates on the char cap`,
    bigChars.length > 65536 && bigSec.includes('TRUNCATED'),
    `chars=${bigChars.length}; truncated=${bigSec.includes('TRUNCATED')}`);

  for (const d of [crlfDir, denseDir, mbDir, bigDir]) fs.rmSync(d, { recursive: true, force: true });

  // === THE FIX: fresh stub-onboarded temp repo injects nothing ===
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-onboard-'));
  execFileSync('node', [path.join(ROOT, 'scripts', 'onboard.mjs'), tmp, '--no-board'],
    { cwd: ROOT, stdio: 'ignore' });
  // FEAT-106: onboard now writes the local-conventions stub under `.orchard/`.
  // localConventionsSection() resolves it there via the board-path resolver.
  const stubFile = path.join(tmp, '.orchard', 'CONVENTIONS.md');
  check('onboard wrote a .orchard/CONVENTIONS.md stub', fs.existsSync(stubFile), fs.existsSync(stubFile) ? 'yes' : 'no');
  console.log(`        stub size on disk: ${fs.statSync(stubFile).size} bytes`);
  assertBattery('fresh onboarded repo', localConventionsSection(tmp), { expectNull: true });

  // === Back-compat: an EDITED stub (real rule added, no markers) injects it ===
  fs.appendFileSync(stubFile, '\n## Local rule\n\n- Never touch port 9999 on this box.\n');
  const edited = localConventionsSection(tmp);
  check('edited stub (real rule added) is NO LONGER treated as a stub — injects',
    typeof edited === 'string' && edited.includes('port 9999'), edited === null ? 'null' : 'injects the rule');

  // === Back-compat: a small UNMARKED doc still injects its full body ===
  const small = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug146-small-'));
  fs.mkdirSync(path.join(small, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(small, LOCAL_CONVENTIONS_RELPATH),
    '# Local rules\n\n- Deploy via `deploy.sh`, never manually.\n');
  const smallSection = localConventionsSection(small);
  check('unmarked small doc still injects full body (fallback unchanged)',
    (smallSection ?? '').includes('deploy.sh'), (smallSection ?? '').includes('deploy.sh') ? 'present' : 'MISSING');

  for (const d of [tmp, small]) fs.rmSync(d, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (fail) console.log(`FAILED: ${failed.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(`\nFATAL: ${e.stack ?? e.message}`); process.exitCode = 1; })
  .finally(() => fs.rmSync(DATA, { recursive: true, force: true }));
