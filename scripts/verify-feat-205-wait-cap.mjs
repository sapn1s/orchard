#!/usr/bin/env node
// FEAT-205 — every ACTIVE wait-idiom emitter caps a single foreground wait at 240 s.
//
// A dispatched lane's prompt cache lives 5 minutes; a blocking wait longer than
// ~240 s outlives the cache and re-writes the whole ~200k context (measured: 299
// re-writes, $375/30d). The fix shortened the foreground-wait idiom from
// `timeout 580 … / timeout 300 …` to `timeout 240 …` everywhere a live lane is
// instructed. This guard scans every ACTIVE emitter and fails if any of them
// instructs a wait longer than 240 s.
//
// Must-FAIL proof is anchored to a SYNTHESIZED pre-change snippet (below), never to
// HEAD or any moving revision, so it keeps reddening after the fix is committed.
//
// The frozen fixture scripts/fixtures/bug-239/round1/park-guard.ts is OLD code kept
// for a different must-FAIL (BUG-239) and is deliberately EXCLUDED.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const methodologyWA = path.join(os.homedir(), 'projects', 'methodology', 'WORKING_AGREEMENT.v4.md');

// Active instruction sources that a LIVE lane reads. The canonical WA is the
// source; the mirror is synced from it; park-guard is the server's SubagentStop
// refusal; worker.md is injected into every worker lane's prompt.
//
// worker.md lives UNDER `.claude/`, which `scripts/independent-verify.mjs` strips
// from every clean room UNCONDITIONALLY (AMBIENT_DIR_NAMES; it is an agent-CLI
// auto-discovery surface, never a declarable `--allow-input` — the harness dies
// if you try, independent-verify.mjs:1265). That strip is correct and must not be
// weakened. So the structural answer here is NOT to copy worker.md's wait rule to
// a non-stripped path (that would be a second home for one fact — ARCH-010 bans
// it) nor to force it into the room (impossible by design). It is to recognise the
// strip: wherever the `.claude/` root exists, worker.md MUST exist and be scanned;
// where the whole ambient root is gone (a clean room), its absence is EXPECTED and
// is reported as a skip, not a pass and not a crash. Non-vacuity does not depend on
// worker.md — Part A reddens against synthesized text regardless — so a clean-room
// run still proves the scanner works and the three non-ambient emitters are clean,
// and worker.md is verified on the real tree where this guard is the project gate.
const ACTIVE_EMITTERS = [
  { label: 'canonical WA (methodology)', file: methodologyWA },
  { label: 'mirror WA (docs/prompts)', file: path.join(repoRoot, 'docs/prompts/WORKING_AGREEMENT.v4.md') },
  { label: 'park-guard refusal text', file: path.join(repoRoot, 'src/server/park-guard.ts') },
  { label: 'worker agent standing rules', file: path.join(repoRoot, '.claude/agents/worker.md'),
    ambientRoot: path.join(repoRoot, '.claude') },
];

// Deliberately NOT scanned — frozen old code for the BUG-239 must-FAIL.
const EXCLUDED = path.join(repoRoot, 'scripts/fixtures/bug-239/round1/park-guard.ts');

const CAP_SECONDS = 240;

// A shell wait command — `timeout …` or `sleep …` — preceded by a command
// boundary. We flag it when its DURATION operand exceeds the cap. The duration is
// not a bare integer: GNU timeout/sleep accept s/m/h/d suffixes, and `timeout`
// takes options (`-k`/`--kill-after`, `-s`/`--signal`, flags) before the duration.
// All of those must be parsed, or an over-cap wait written `timeout 300s` /
// `timeout 5m` / `timeout --signal=TERM 300` slips the guard (verify run
// 01a1f171 found exactly these four holes in the old bare-integer regex).
const CMD_RE = /(?:^|[\s;&|(`'"])(timeout|sleep)[ \t]+/g;
const SUFFIX_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
// `timeout` options that consume the NEXT token when given detached (not `=`-joined,
// not short-attached). Flags (`--foreground`, `--preserve-status`, `-v`) consume nothing.
const TIMEOUT_NEXT_ARG_OPTS = new Set(['-k', '--kill-after', '-s', '--signal']);

// Parse a lone operand token into seconds, or null if it is not a duration literal.
// Shell/markdown punctuation can hug the operand in prose examples (a backtick
// closing a code span, a `;` separator, a `)` ) without being part of it, so we
// strip a leading non-digit run and read the duration anchored at the start,
// tolerating trailing punctuation — a `timeout 300\`` at the end of a code span
// must still be read as 300 s, or an over-cap wait hides behind a backtick.
function parseDuration(tok) {
  const t = tok.replace(/^[^0-9]+/, '');
  const m = /^(\d+(?:\.\d+)?)([smhd])?(?![\w.])/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const suffix = m[2] ? m[2].toLowerCase() : undefined;
  return { secs: suffix ? n * SUFFIX_SECONDS[suffix] : n, hadSuffix: Boolean(suffix), raw: tok };
}

function scan(text) {
  const violations = [];
  for (const line of text.split('\n')) {
    CMD_RE.lastIndex = 0;
    let m;
    while ((m = CMD_RE.exec(line)) !== null) {
      const cmd = m[1];
      const tokens = line.slice(CMD_RE.lastIndex).split(/\s+/).filter(Boolean);
      let i = 0;
      if (cmd === 'timeout') {
        // Walk past options to the first operand (the DURATION).
        while (i < tokens.length && tokens[i].startsWith('-')) {
          const t = tokens[i];
          if (t.includes('=')) { i += 1; continue; }                 // --signal=TERM : self-contained
          if (/^-[a-zA-Z]./.test(t)) { i += 1; continue; }           // -sTERM / -k10 : value attached
          if (TIMEOUT_NEXT_ARG_OPTS.has(t)) { i += 2; continue; }    // --signal TERM / -k 10 : eats next
          i += 1;                                                    // bare flag (--foreground, -v)
        }
      }
      const d = tokens[i] ? parseDuration(tokens[i]) : null;
      if (!d) continue;
      // A BARE integer >= 10000 is the Bash tool's own `timeout 600000` ms ceiling
      // (prose, not a shell wait) and is not flagged. A SUFFIXED value always is a
      // real duration, so the exemption never applies to it.
      if (!d.hadSuffix && d.secs >= 10000) continue;
      if (d.secs > CAP_SECONDS) {
        violations.push({ cmd, secs: d.secs, raw: d.raw, line: line.trim().slice(0, 120) });
      }
    }
  }
  return violations;
}

let failed = 0;
const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { console.log(`  FAIL ${msg}`); failed++; };

console.log('FEAT-205 wait-cap guard\n');

// Part A — non-vacuity / must-FAIL proof against SYNTHESIZED pre-change text.
// These are the exact idioms the fix removed. If the scanner does not flag them,
// the guard is vacuous and would pass over a real regression.
const PRE_CHANGE = [
  '`timeout 580 tail --pid=<PID> -f /dev/null; true` when you know the pid, else repeated',
  '`timeout 300 tail -f /dev/null; true` until the child\'s completion notice arrives',
  'e.g. `timeout 560 sleep 999` or `timeout 590 tail`',
].join('\n');
const preViolations = scan(PRE_CHANGE);
if (preViolations.length >= 3 && preViolations.some((v) => v.secs === 580) && preViolations.some((v) => v.secs === 300)) {
  pass(`must-FAIL proof: scanner flags ${preViolations.length} pre-change waits (incl. 580, 300, 560, 590 s)`);
} else {
  fail(`must-FAIL proof is vacuous: scanner only flagged ${JSON.stringify(preViolations)}`);
}

// Control: 240 s and the Bash-tool 600000 ms ceiling must NOT be flagged.
const controlOk = scan('`timeout 240 tail -f /dev/null; true` / a Bash call with timeout 600000').length === 0;
controlOk ? pass('control: `timeout 240` and `timeout 600000` are not flagged')
          : fail('control: 240 s or the 600000 ms Bash ceiling was wrongly flagged');

// Part A2 — DURATION-FORM coverage (synthesized). Every over-cap wait form must be
// flagged — suffixes (s/m/h/d), `timeout` options before the duration, and the
// `tail --pid=<PID>` operand that belongs to tail, not timeout. Every at/under-cap
// form must NOT be flagged. These are the exact shapes the old bare-integer regex
// missed (verify run 01a1f171). Synthetic by necessity: no real emitter carries an
// over-cap wait anymore, so the forms are constructed, not drawn from the tree.
const OVER_CAP_FORMS = [
  'timeout 300s tail -f /dev/null; true',             // s-suffix -> 300 s
  'timeout 5m tail -f /dev/null; true',               // m-suffix -> 300 s
  'timeout 1h tail',                                  // h-suffix -> 3600 s
  'timeout --signal=TERM 300 tail --pid=<PID>',       // =-joined option, then duration
  'timeout --signal TERM 300 tail',                   // detached option (eats next token)
  'timeout -s TERM 300 tail',                          // short detached option
  'timeout -sTERM 300 tail',                           // short attached option
  'timeout -k 10 300 tail',                            // --kill-after detached
  'timeout --preserve-status --foreground 300 tail',  // bare flags, then duration
  'sleep 5m',                                          // sleep with suffix -> 300 s
];
const UNDER_CAP_FORMS = [
  'timeout 240 tail --pid=<PID> -f /dev/null; true',  // the canonical capped idiom
  'timeout 240s tail',                                // 240 s exactly
  'timeout 4m tail',                                  // 4 m == 240 s, not over
  'timeout --signal=TERM 240 tail',                   // option + at-cap duration
  'a Bash call with timeout 600000 that blocks',      // bare ms ceiling, prose
];
const overMissed = OVER_CAP_FORMS.filter((f) => scan(f).length === 0);
const underFlagged = UNDER_CAP_FORMS.filter((f) => scan(f).length > 0);
if (overMissed.length === 0 && underFlagged.length === 0) {
  pass(`duration forms: flags all ${OVER_CAP_FORMS.length} over-cap forms (s/m/h, --signal/-k, attached/detached opts), none of ${UNDER_CAP_FORMS.length} at/under-cap`);
} else {
  if (overMissed.length) fail(`duration forms: ${overMissed.length} over-cap form(s) NOT flagged -> ${JSON.stringify(overMissed)}`);
  if (underFlagged.length) fail(`duration forms: ${underFlagged.length} at/under-cap form(s) wrongly flagged -> ${JSON.stringify(underFlagged)}`);
}

// Part B — every ACTIVE emitter must exist and carry no over-cap wait.
if (ACTIVE_EMITTERS.length < 4) fail(`expected >=4 active emitters, have ${ACTIVE_EMITTERS.length}`);
let ambientSkipped = 0;
for (const { label, file, ambientRoot } of ACTIVE_EMITTERS) {
  if (!fs.existsSync(file)) {
    // An emitter under an ambient root (.claude) is stripped from an
    // independent-verify clean room. Absence is EXPECTED only when the WHOLE
    // ambient root is gone; if the root is present and just this file vanished,
    // that is a real deletion and must FAIL (never pass vacuously).
    if (ambientRoot && !fs.existsSync(ambientRoot)) {
      console.log(`  skip ${label}: absent here — ${path.relative(repoRoot, ambientRoot)}/ is ambient-stripped in clean rooms (independent-verify); verified on the real tree only`);
      ambientSkipped++;
      continue;
    }
    fail(`${label}: MISSING at ${file} (cannot pass vacuously)`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const v = scan(text);
  if (v.length === 0) pass(`${label}: no wait over ${CAP_SECONDS} s`);
  else fail(`${label}: ${v.length} wait(s) over ${CAP_SECONDS} s -> ${JSON.stringify(v.slice(0, 3))}`);
}

// The frozen fixture is excluded by design; assert it is not in the active set and
// that it still carries the OLD text (so we have not silently mutated it).
if (ACTIVE_EMITTERS.some((e) => path.resolve(e.file) === path.resolve(EXCLUDED))) {
  fail('frozen BUG-239 fixture is in the active emitter set — it must be excluded');
} else if (fs.existsSync(EXCLUDED) && /timeout 580|timeout 300/.test(fs.readFileSync(EXCLUDED, 'utf8'))) {
  pass('frozen BUG-239 fixture excluded and still carries its original old text');
} else {
  fail('frozen BUG-239 fixture missing or its old text was altered');
}

console.log('');
if (failed) { console.log(`FEAT-205 wait-cap guard: ${failed} FAILED`); process.exit(1); }
if (ambientSkipped) {
  console.log(`FEAT-205 wait-cap guard: all checks passed (${ambientSkipped} ambient-stripped emitter skipped — clean room; verify on the real tree for full coverage)`);
} else {
  console.log('FEAT-205 wait-cap guard: all checks passed (all emitters scanned)');
}
