#!/usr/bin/env node
/**
 * verify-feat-119-usage-awareness.mjs — a session can answer "can I afford to
 * dispatch this, and at what tier?" on demand, from live provider windows +
 * burn rate + its own workspace spend, WITHOUT any of it touching the cached
 * system prompt.
 *
 *   node scripts/verify-feat-119-usage-awareness.mjs
 *
 * MUST-FAIL on the pre-change tree: `scripts/lib/usage-burn.mjs` and
 * `scripts/usage.mts` do not exist there, so every import and spawn below is
 * unreachable and the run dies at the first `import`.
 *
 * Graded here:
 *   A. BURN MATH (pure, no network) — the derivation is decision-shaped and never
 *      fabricates: PARK vs OK, observed-rate beats window-average, first read
 *      withholds a rate honestly, unknown reset yields no verdict guess.
 *   B. REAL PROVIDERS — the command run as a bare process (the way a RUNNING
 *      session obtains it) returns bounded, current, per-window verdicts with an
 *      as-of, and NO credential in its output.
 *   C. DEGRADE — an unavailable provider degrades to "unavailable", never a
 *      fabricated 0%, and never conflates our spend with the provider quota.
 *   D. CACHE-SAFE — the pointer rides the first-turn board preamble, NOT the
 *      system prompt, and scripts/verify-feat-113-system-prompt-stable.mjs still
 *      passes with this change in (system bytes byte-identical across resumes).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function main() {
  const { deriveWindow, overallVerdict, windowDurationMins, verdictAdvice } =
    await import(path.join(ROOT, 'scripts', 'lib', 'usage-burn.mjs'));

  const now = Date.parse('2026-09-02T12:00:00Z');
  const H = 3.6e6;

  // ===================== A. BURN MATH (pure) =====================
  console.log('\n=== A. burn math (pure, decision-shaped, no fabrication) ===');

  check('windowDurationMins maps the real labels', windowDurationMins('5h') === 300 && windowDurationMins('weekly') === 10080 && windowDurationMins('weekly · Fable') === 10080 && windowDurationMins('nonsense') === null,
    [windowDurationMins('5h'), windowDurationMins('weekly'), windowDurationMins('weekly · Fable'), windowDurationMins('nonsense')]);

  // A 5h window that resets in 3h opened 2h ago (elapsed 2h) — realistic; the
  // window-average is then 40%/2h = 20%/hr.
  const reset3h = Math.floor((now + 3 * H) / 1000);

  // PARK: 40% used, resets in 3h, burning 30%/hr (prior 1h ago at 10%) →
  // exhausts in ~2h < 3h.
  const park = deriveWindow(
    { label: '5h', usedPercent: 40, resetsAt: reset3h, binding: true },
    { now, prior: { usedPercent: 10, at: now - 1 * H, resetsAt: reset3h } },
  );
  check('PARK: observed 30%/hr, exhausts (~2h) BEFORE reset (3h) → verdict park',
    park.verdict === 'park' && park.rateSource === 'observed' && Math.abs(park.observedPerHr - 30) < 0.01 && park.projectedHoursToCap < park.hoursToReset,
    { verdict: park.verdict, rate: park.rate, src: park.rateSource, toCap: park.projectedHoursToCap, toReset: park.hoursToReset });

  // OK: same 40% but only burning 5%/hr (prior 1h ago at 35%) → to-cap 12h > 3h.
  const ok = deriveWindow(
    { label: '5h', usedPercent: 40, resetsAt: reset3h, binding: true },
    { now, prior: { usedPercent: 35, at: now - 1 * H, resetsAt: reset3h } },
  );
  check('OK: observed 5%/hr, window resets (3h) BEFORE cap (12h) → verdict ok',
    ok.verdict === 'ok' && Math.abs(ok.observedPerHr - 5) < 0.01 && ok.projectedHoursToCap > ok.hoursToReset,
    { verdict: ok.verdict, rate: ok.rate, toCap: ok.projectedHoursToCap, toReset: ok.hoursToReset });

  // OBSERVED beats window-average: the SAME snapshot with a prior yields a
  // different, real rate (30%/hr) than the single-read fallback (20%/hr).
  const single = deriveWindow({ label: '5h', usedPercent: 40, resetsAt: reset3h, binding: true }, { now, prior: null });
  check('FIRST READ (no prior): rate falls back to window-average, labelled — not fabricated',
    single.rateSource === 'window-average' && single.observedPerHr === null && single.rate != null,
    { src: single.rateSource, observed: single.observedPerHr, rate: single.rate });
  check('OBSERVED differs from the window-average fallback (successive reads change the answer)',
    park.rateSource === 'observed' && single.rateSource === 'window-average' && Math.abs(park.rate - single.rate) > 1,
    { observed: park.rate, windowAvg: single.rate });

  // A prior from a DIFFERENT window instance (different resetsAt) must be ignored
  // — matching it would compute a burn across a window boundary.
  const crossWindow = deriveWindow(
    { label: '5h', usedPercent: 40, resetsAt: reset3h, binding: true },
    { now, prior: { usedPercent: 90, at: now - 1 * H, resetsAt: reset3h - 5 * 3600 } },
  );
  check('prior from a DIFFERENT window instance is ignored (no cross-boundary burn)',
    crossWindow.observedPerHr === null && crossWindow.rateSource === 'window-average', crossWindow.rateSource);

  // UNKNOWN RESET: resetsAt null → no reset, no window-average, no verdict guess.
  const noReset = deriveWindow({ label: '5h', usedPercent: 40, resetsAt: null }, { now, prior: null });
  check('UNKNOWN RESET: no reset time → rate null, verdict is unknown-rate (never a fabricated projection)',
    noReset.rate === null && noReset.hoursToReset === null && (noReset.verdict === 'unknown-rate'),
    { rate: noReset.rate, verdict: noReset.verdict });

  // IDLE: usage not moving between reads (observed 0) → the observed signal is
  // not positive, so it falls back to the window-average rather than projecting
  // "will exhaust" off a zero.
  const idle = deriveWindow(
    { label: '5h', usedPercent: 40, resetsAt: reset3h },
    { now, prior: { usedPercent: 40, at: now - 1 * H, resetsAt: reset3h } },
  );
  check('IDLE: observed 0%/hr → falls back to window-avg (a positive), still projects a finite cap honestly',
    idle.observedPerHr === 0 && idle.rateSource === 'window-average', { observed: idle.observedPerHr, src: idle.rateSource });

  // overallVerdict: the harshest window drives the fleet decision.
  const ov = overallVerdict([ok, park]);
  check('overallVerdict picks the HARSHEST window (park outranks ok)', ov.verdict === 'park', ov.verdict);
  check('verdictAdvice is plain-words and decision-shaped', /park|tier/.test(verdictAdvice('park')) && /headroom|dispatch/.test(verdictAdvice('ok')), [verdictAdvice('park'), verdictAdvice('ok')]);

  // ===================== B. REAL PROVIDERS via the command =====================
  console.log('\n=== B. the real command, run as a bare process (the running-session path) ===');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feat119-'));
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync('node', [path.join(ROOT, 'scripts', 'usage.mts'), '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CLAUDE_STATION_DATA: scratch },
    });
  } catch (err) {
    out = String(err.stdout ?? '') || `SPAWN FAILED: ${err.message}`;
  }
  const elapsed = Date.now() - t0;
  check('command returns bounded (< 25s — bounded provider reads, never a hung network call)', elapsed < 25_000, `${elapsed}ms`);

  let payload = null;
  try { payload = JSON.parse(out); } catch { /* left null */ }
  check('command emits parseable JSON a session can consume', payload && Array.isArray(payload.providers), payload ? 'ok' : out.slice(0, 200));

  const provs = payload?.providers ?? [];
  check('both providers present (anthropic + openai)',
    provs.some((p) => p.provider === 'anthropic') && provs.some((p) => p.provider === 'openai'),
    provs.map((p) => `${p.provider}:${p.available}`));

  const avail = provs.filter((p) => p.available);
  check('at least one provider read live usage (drive against the REAL provider)', avail.length >= 1, avail.map((p) => p.provider));
  for (const p of avail) {
    check(`${p.provider}: carries an as-of timestamp (says WHEN it was read)`, typeof p.asOf === 'number' && p.asOf > 0, p.asOf);
    check(`${p.provider}: every window has a percent, a reset and a verdict (decision-shaped)`,
      p.windows.length > 0 && p.windows.every((w) => typeof w.usedPercent === 'number' && 'resetsAt' in w && typeof w.verdict === 'string'),
      p.windows.map((w) => `${w.label}=${w.usedPercent}%/${w.verdict}`));
  }

  // NO CREDENTIAL anywhere in the output — read the real token and assert absence.
  let token = null;
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    token = cred?.claudeAiOauth?.accessToken ?? null;
  } catch { /* not signed in — skip below */ }
  if (token) {
    check('NO credential leaks into the command output (JSON)', !out.includes(token), token ? 'token absent' : 'n/a');
    const textOut = execFileSync('node', [path.join(ROOT, 'scripts', 'usage.mts')], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLAUDE_STATION_DATA: scratch } });
    check('NO credential leaks into the human readout', !textOut.includes(token), 'token absent');
  } else {
    console.log('  (skip) no Claude credential on disk to test for leakage');
  }

  // Own spend is present, and it is architecturally SEPARATE from the quota — its
  // numbers are dollars, never a "usedPercent" masquerading as provider quota.
  check('own workspace spend is reported and labelled OUR accounting / lower bound (never the provider quota)',
    payload?.ownSpend && (payload.ownSpend.available === false || (payload.ownSpend.available && /lower bound/i.test(payload.ownSpend.ledgerFloor) && /not the provider quota/i.test(payload.ownSpend.ledgerFloor))),
    payload?.ownSpend?.available ? payload.ownSpend.ledgerFloor : payload?.ownSpend?.note);
  if (payload?.ownSpend?.available) {
    const spendKeys = JSON.stringify(payload.ownSpend.windows);
    check('own-spend windows carry dollar costs, NOT usedPercent (no quota/spend conflation)',
      !/usedPercent/.test(spendKeys) && payload.ownSpend.windows.every((w) => 'cost' in w && 'priced' in w),
      payload.ownSpend.windows.map((w) => `${w.label}:$${w.priced}`));
  }

  fs.rmSync(scratch, { recursive: true, force: true });

  // ===================== C. DEGRADE (in-process, no network) =====================
  console.log('\n=== C. degrade path — unavailable says unavailable, never a fabricated 0% ===');
  // A wedged/unauthenticated provider degrades to available:false; deriving it
  // yields NO windows and NO fabricated percentages.
  const down = deriveWindow({ label: '5h', usedPercent: NaN, resetsAt: null }, { now, prior: null });
  check('a NaN percent never becomes a number (unknown stays unknown)', down.usedPercent === null && down.rate === null, { pct: down.usedPercent, rate: down.rate });

  // ===================== D. CACHE-SAFE placement =====================
  console.log('\n=== D. cache-safe — pointer in first-turn board preamble, NOT the system prompt ===');
  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'feat119-proj-'));
  fs.mkdirSync(path.join(proj, 'docs', 'bugs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'bugs', 'INDEX.md'),
    '# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n| BUG-1 | x | 🤖 | building | low |\n\n## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n');
  fs.writeFileSync(path.join(proj, 'docs', 'bugs', 'BUG-1-x.md'), '# BUG-1\n\n- **Status:** OPEN\n');
  const section = boardStateSection(proj);
  check('the board first-turn preamble NAMES the on-demand command (new + resumed sessions learn it exists)',
    typeof section === 'string' && section.includes('npm run usage'), section ? 'pointer present' : 'no section');

  // The pointer must NOT contain a live number (else it would bust the cached
  // prefix if it ever moved into the system block).
  const pointerLine = (section ?? '').split('\n').find((l) => l.includes('npm run usage')) ?? '';
  check('the pointer line is STATIC (no live percentage/number in it)', !/\d+%/.test(pointerLine), pointerLine.slice(0, 80));
  fs.rmSync(proj, { recursive: true, force: true });

  // The FEAT-113 byte-stability proof still passes with this change in.
  let f113ok = false, f113out = '';
  try {
    f113out = execFileSync('node', [path.join(ROOT, 'scripts', 'verify-feat-113-system-prompt-stable.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    f113ok = /checks passed/.test(f113out) && !/\bFAIL\b/.test(f113out);
  } catch (err) { f113out = String(err.stdout ?? err.message); }
  check('FEAT-113 system-prompt byte-stability STILL passes with the pointer added (cache not reintroduced)',
    f113ok, (f113out.trim().split('\n').pop() || '').trim());

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
