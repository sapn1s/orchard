/**
 * verify-feat-152-orch-bypass.mts — FEAT-152.
 *
 * Grades the audited inline escape hatch END TO END through the REAL enforcement
 * code, never a private copy of the regex:
 *   • `detectOrchBypass()` / `decide()` / `decideBashCommand()` from
 *     orchestrator-profile.mjs — the SINGLE source the PreToolUse hook calls;
 *   • `makeOrchBypassRecorder()` from claude-runtime.ts — the exact stateful
 *     glue the hook wires, driven here against a scratch data dir so the REAL
 *     ledger writer and the REAL running counter run without launching a model.
 *
 * NON-VACUITY / MUST-FAIL: for every command the hatch admits, the pre-fix
 * classifier `decideBashCommand()` still returns DENY (it strips the `#` comment
 * and sees the real head). So the pair "classifier says deny, decide() says
 * allow-with-bypass" proves the hatch — and only the hatch — flips the outcome.
 * `decideBashCommand` is the fixed pre-fix baseline; it does not move.
 *
 * Run: npm run verify:feat-152
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Isolate the data dir BEFORE the recorder ever resolves dataDir(). This is the
// BUG-117 isolation knob; the ledger lands here, never in the real data dir.
const scratchData = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-152-'));
process.env.CLAUDE_STATION_DATA = scratchData;

const { decide, detectOrchBypass, decideBashCommand } =
  await import('./lib/orchestrator-profile.mjs');
const { makeOrchBypassRecorder, evaluateOrchestratorProfileHook } =
  await import('../src/server/runtime/claude-runtime.ts');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const GOOD = 'need the live gate exit status to decide whether to commit now';
// Round 4: one file per record under dataDir()/orch-bypass-audit/. `rowsIn`
// parses every PUBLISHED record there (dot-prefixed temps skipped) and orders
// them by time then count; a record that does not parse throws, failing the case.
const RECORD_DIR = (d: string) => path.join(d, 'orch-bypass-audit');
function rowsIn(d: string): any[] {
  const rd = RECORD_DIR(d);
  if (!fs.existsSync(rd)) return [];
  return fs.readdirSync(rd).filter((n) => !n.startsWith('.'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(rd, n), 'utf8')))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.count - b.count));
}
const tempsIn = (d: string) => (fs.existsSync(RECORD_DIR(d)) ? fs.readdirSync(RECORD_DIR(d)).filter((n) => n.startsWith('.')).length : 0);

try {
  /* ═══ 1. detectOrchBypass — pure, first-line-only, real reason floor ══════ */
  ok('1a no marker → not present', detectOrchBypass('cat foo').present === false);
  {
    const d = detectOrchBypass(`# ORCH-BYPASS: ${GOOD}\ncat foo`);
    ok('1b valid marker on line 1 → present & valid', d.present === true && d.valid === true);
    ok('1b captured reason is trimmed and complete', d.reason === GOOD);
  }
  {
    const d = detectOrchBypass('# ORCH-BYPASS: too short\ncat foo'); // 9 chars
    ok('1c short reason → present, invalid', d.present === true && d.valid === false);
    ok('1c problem names the short-reason floor', /short|missing/.test(d.problem ?? ''));
  }
  {
    const d = detectOrchBypass('# ORCH-BYPASS:   \ncat foo');
    ok('1d empty reason → invalid, problem says missing', d.present === true && d.valid === false && /missing/.test(d.problem ?? ''));
  }
  ok('1e marker NOT on line 1 → not present',
    detectOrchBypass(`echo hi # ORCH-BYPASS: ${GOOD}`).present === false);
  ok('1e blocked command with a TRAILING marker → not present',
    detectOrchBypass(`grep -rn x /src # ORCH-BYPASS: ${GOOD}`).present === false);
  ok('1f leading whitespace before the comment is still the marker',
    detectOrchBypass(`   # ORCH-BYPASS: ${GOOD}\ncat foo`).valid === true);
  // Boundary: exactly the floor length passes, one under fails.
  ok('1g reason of exactly 15 chars is accepted',
    detectOrchBypass('# ORCH-BYPASS: abcde fghij klm\ncat x').valid === true); // 15 chars
  ok('1g reason of 14 chars is rejected',
    detectOrchBypass('# ORCH-BYPASS: abcde fghij kl\ncat x').valid === false); // 14 chars

  /* ═══ 2. decide() — the real path the hook calls ═════════════════════════ */
  // (a) plain blocked command: denied, criteria now present in the text.
  {
    const d = decide({ toolName: 'Bash', toolInput: { command: 'grep -rn foo /src' } });
    ok('2a plain blocked command is denied', d.allow === false);
    ok('2a denial still names the offender and the Agent-tool remedy',
      /`grep`/.test(d.reason ?? '') && /Agent tool/.test(d.reason ?? ''));
    ok('2a denial now ends with the ORCH-BYPASS criteria',
      /ORCH-BYPASS/.test(d.reason ?? '') && /very NEXT decision/.test(d.reason ?? ''));
    ok('2a criteria list the NOT-for cases', /searching or exploring/.test(d.reason ?? ''));
  }
  // (b) valid marker on an otherwise-blocked command → allowed, bypass emitted.
  {
    const cmd = `# ORCH-BYPASS: ${GOOD}\ncat ./package.json`;
    const d = decide({ toolName: 'Bash', toolInput: { command: cmd } });
    ok('2b valid marker → allowed', d.allow === true && d.scope === 'orchestrator');
    ok('2b decide() emits the bypass event with reason + command',
      !!d.bypass && d.bypass.reason === GOOD && d.bypass.command === cmd);
    // NON-VACUITY: the classifier still denies the underlying command.
    ok('2b MUST-FAIL: the classifier alone still DENIES this command (the hatch is what flips it)',
      decideBashCommand(cmd).allow === false);
  }
  // (c) invalid (short) marker → denied with an explanation.
  {
    const d = decide({ toolName: 'Bash', toolInput: { command: '# ORCH-BYPASS: nope\ncat foo' } });
    ok('2c short-reason marker is denied', d.allow === false && !d.bypass);
    ok('2c denial explains the marker is not usable + shows the floor',
      /not usable/.test(d.reason ?? '') && /ORCH-BYPASS:/.test(d.reason ?? ''));
  }
  // (d) marker on an ALREADY-ALLOWED command → runs as a comment, NOT a bypass.
  {
    const d = decide({ toolName: 'Bash', toolInput: { command: `# ORCH-BYPASS: ${GOOD}\nnpm run gate` } });
    ok('2d marker on an allowed command → allowed with NO bypass event (comment no-op)',
      d.allow === true && !d.bypass);
  }
  // (e) marker NOT on the first line of a blocked command → still denied.
  {
    const d = decide({ toolName: 'Bash', toolInput: { command: `grep -rn x /src # ORCH-BYPASS: ${GOOD}` } });
    ok('2e trailing marker does not open the hatch', d.allow === false && !d.bypass);
  }
  // (f) a dispatched LANE is unaffected — keeps everything, no marker needed.
  {
    const d = decide({ toolName: 'Bash', toolInput: { command: 'grep -rn x /' }, agentId: 'agent-xyz' });
    ok('2f a lane (agent_id present) keeps Bash unrestricted, no bypass involved',
      d.allow === true && d.scope === 'subagent' && !d.bypass);
  }
  // decide() stays PURE: a bypass verdict writes nothing on its own.
  ok('2g decide() alone wrote NO ledger (side effects belong to the hook)',
    !fs.existsSync(RECORD_DIR(scratchData)));

  /* ═══ 3. makeOrchBypassRecorder — the real ledger + running count ═════════ */
  {
    const rec = makeOrchBypassRecorder({ sessionId: 'sess-A', sessionLabel: 'lane-1' });
    // Drive the two proof-bar calls exactly as the hook does: decide() → recorder.
    const c1 = `# ORCH-BYPASS: ${GOOD}\ncat a.txt`;
    const c2 = `# ORCH-BYPASS: ${GOOD} (second)\ncat b.txt`;
    const d1 = decide({ toolName: 'Bash', toolInput: { command: c1 } });
    const d2 = decide({ toolName: 'Bash', toolInput: { command: c2 } });
    const o1 = rec(d1.bypass);
    const o2 = rec(d2.bypass);
    ok('3a first allow reports "#1 this session"', /ORCH-BYPASS #1 this session/.test(o1.hookSpecificOutput.permissionDecisionReason));
    ok('3a second allow reports "#2 this session" (count increments)', /ORCH-BYPASS #2 this session/.test(o2.hookSpecificOutput.permissionDecisionReason));
    ok('3a both are PreToolUse allow decisions', o1.hookSpecificOutput.permissionDecision === 'allow' && o2.hookSpecificOutput.permissionDecision === 'allow');

    const rows = rowsIn(scratchData);
    ok('3b two rows appended to the real ledger', rows.length === 2, `${rows.length} rows`);
    ok('3b counts are 1 then 2', rows[0].count === 1 && rows[1].count === 2);
    ok('3b rows carry the session id', rows.every((r) => r.sessionId === 'sess-A'));
    ok('3b rows carry the session label', rows.every((r) => r.sessionLabel === 'lane-1'));
    ok('3b rows carry the reason', rows[0].reason === GOOD);
    ok('3b rows are timestamped (ISO)', rows.every((r) => !Number.isNaN(Date.parse(r.at))));
    ok('3b rows carry the (marker-first) command', /^# ORCH-BYPASS:/.test(rows[0].command));
    ok('3b event tag is orch-bypass', rows.every((r) => r.event === 'orch-bypass'));
  }
  // A fresh session recorder starts its own count at 1 (per-session, not global).
  {
    const rec2 = makeOrchBypassRecorder({ sessionId: 'sess-B' });
    const o = rec2({ reason: GOOD, command: 'cat x' });
    ok('3c a NEW session recorder starts again at #1', /ORCH-BYPASS #1 this session/.test(o.hookSpecificOutput.permissionDecisionReason));
  }
  // Command truncation: a long payload is capped in the audit.
  {
    const rec3 = makeOrchBypassRecorder({ sessionId: 'sess-C' });
    rec3({ reason: GOOD, command: '# ORCH-BYPASS: x\ncat ' + 'y'.repeat(2000) });
    const last = rowsIn(scratchData).find((r) => r.sessionId === 'sess-C');
    ok('3d the stored command is truncated to <= 500 chars', last.command.length <= 500, `${last.command.length}`);
  }

  const withDataEnv = <T,>(dir: string, fn: () => T): T => {
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
    }
  };
  const drive4 = (rec: ReturnType<typeof makeOrchBypassRecorder>): any =>
    rec(decide({ toolName: 'Bash', toolInput: { command: `# ORCH-BYPASS: ${GOOD}\ncat foo` } }).bypass);

  /* ═══ 4. round 2 — FAIL CLOSED when the bypass cannot be durably audited ════
   * Requirement #2 / "no bypass is silent": if the ledger append fails, the
   * bypass must be DENIED, never allowed with a false "LOGGED" claim. The
   * clean-room verifier (Activity round 1) refuted round 1 here: an unwritable
   * ledger (EISDIR / ENOSPC / EACCES) was swallowed and the recorder STILL
   * returned `allow`, so a bypass RAN UNAUDITED. These cases drive the REAL
   * recorder against a genuinely unwritable ledger path. */
  {
    // Round 5 layout: the record is PUBLISHED no-clobber by link(2) (F1). A
    // genuine kernel EEXIST is produced by redirecting the link target onto an
    // existing DIRECTORY (the link call is redirected onto a real directory —
    // the errno is the kernel's, not a fabricated one). Same class as the
    // round-1 verifier's "directory where the ledger must go": the publish
    // cannot happen, so the bypass must fail closed.
    const badData = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-152-bad-'));
    const blocker = path.join(badData, 'a-directory');
    fs.mkdirSync(path.join(blocker, 'occupied'), { recursive: true });
    const prevData = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = badData;
    const realLink = fs.linkSync;
    let eexistSeen = '';
    try {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-EISDIR' });
      const d = decide({ toolName: 'Bash', toolInput: { command: `# ORCH-BYPASS: ${GOOD}\ncat foo` } });
      (fs as any).linkSync = (from: string) => {
        try { return realLink(from, blocker); } catch (e) { eexistSeen = (e as any).code; throw e; }
      };
      let out: any;
      try { out = rec(d.bypass); } finally { (fs as any).linkSync = realLink; }
      ok('4a the publish really failed with the kernel\'s EEXIST', eexistSeen === 'EEXIST', eexistSeen);
      const reason = out.hookSpecificOutput.permissionDecisionReason ?? '';
      ok('4a unwritable ledger → bypass DENIED (fail CLOSED, not allowed)',
        out.hookSpecificOutput.permissionDecision === 'deny');
      ok('4a denial reason says the bypass could not be durably audited/logged',
        /audit|logged|record/i.test(reason));
      ok('4a denial does NOT falsely claim the bypass was LOGGED',
        !/allowed and LOGGED/.test(reason));
      // BUG-226 round 3 — this ledger-not-written refusal path carried NO "Still
      // available here" list (plan-review finding A, round-2 break (a) repeating).
      ok('4a denial now carries the "Still available here" help (BUG-226 r3)',
        /Still available here/.test(reason));
      ok('4a nothing was published and no temp was left (record dir empty)',
        rowsIn(badData).length === 0 && tempsIn(badData) === 0 && fs.readdirSync(blocker).join() === 'occupied');
      // Count must NOT advance for a denied (unlogged) bypass: repoint to a
      // WRITABLE dir and re-drive the SAME recorder — the first SUCCESSFUL
      // bypass must be #1, proving the failed one did not consume a number.
      const okData = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-152-ok-'));
      process.env.CLAUDE_STATION_DATA = okData;
      try {
        const d2 = decide({ toolName: 'Bash', toolInput: { command: `# ORCH-BYPASS: ${GOOD}\ncat foo` } });
        const out2 = rec(d2.bypass);
        const reason2 = out2.hookSpecificOutput.permissionDecisionReason ?? '';
        ok('4b after a denied (unlogged) bypass the count did NOT advance — next good one is #1',
          out2.hookSpecificOutput.permissionDecision === 'allow' && /ORCH-BYPASS #1 this session/.test(reason2));
        const rows = rowsIn(okData);
        ok('4b the durable ledger got exactly ONE row, count 1 (the denied one wrote nothing)',
          rows.length === 1 && rows[0].count === 1);
      } finally {
        fs.rmSync(okData, { recursive: true, force: true });
      }
    } finally {
      (fs as any).linkSync = realLink;
      if (prevData === undefined) delete process.env.CLAUDE_STATION_DATA;
      else process.env.CLAUDE_STATION_DATA = prevData;
      fs.rmSync(badData, { recursive: true, force: true });
    }
    // EACCES — a record directory the process cannot write into.
    const roData = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-152-ro-'));
    fs.mkdirSync(RECORD_DIR(roData), { mode: 0o500 });
    fs.chmodSync(RECORD_DIR(roData), 0o500);
    try {
      const out = withDataEnv(roData, () => drive4(makeOrchBypassRecorder({ sessionId: 'sess-EACCES' })));
      ok('4c read-only record dir (EACCES) → bypass DENIED', out.hookSpecificOutput.permissionDecision === 'deny');
      ok('4c nothing written into the read-only dir', fs.readdirSync(RECORD_DIR(roData)).length === 0);
    } finally {
      fs.chmodSync(RECORD_DIR(roData), 0o700);
      fs.rmSync(roData, { recursive: true, force: true });
    }
  }

  /* ═══ 5. round 3 — fix the CLASS, not one failure mode at a time ═══════════
   * Two clean-room refutations in a row found the SAME shape: a bypass ALLOWED
   * while the ledger write was not actually durable — first a swallowed append
   * error (round 1), then a short `writeSync` whose byte count went unchecked
   * (round 2). The invariant now: the bypass is ALLOWED only when a COMPLETE,
   * PARSEABLE row is durably written to a REGULAR FILE; every other outcome is
   * DENY and the count does not advance. Each case is driven through the REAL
   * hook path — `evaluateOrchestratorProfileHook(input, recorder)`, the exact
   * function the PreToolUse callback calls — so the outer-catch fail-open and
   * the recorder are both exercised for real. */
  const MARKER = `# ORCH-BYPASS: ${GOOD}\ncat foo`;
  const drive = (rec: ReturnType<typeof makeOrchBypassRecorder>) =>
    evaluateOrchestratorProfileHook({ tool_name: 'Bash', tool_input: { command: MARKER } }, rec);
  const decision = (o: any) => o?.hookSpecificOutput?.permissionDecision;
  const reasonOf = (o: any) => o?.hookSpecificOutput?.permissionDecisionReason ?? '';
  // A fresh writable data dir the recorder can recover into.
  const freshDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feat-152-r3-'));
  // Point the recorder's ledger at a fresh dir, run a GOOD bypass on the SAME
  // recorder, and assert it lands as #1 — proving the failed attempt consumed
  // no number and left no valid row.
  function assertCountNotAdvanced(name: string, rec: ReturnType<typeof makeOrchBypassRecorder>) {
    const okData = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = okData;
    try {
      const out = drive(rec);
      ok(`${name} — recovery: next good bypass is allowed as #1 (count did not advance)`,
        decision(out) === 'allow' && /ORCH-BYPASS #1 this session/.test(reasonOf(out)));
      const rows = rowsIn(okData);
      ok(`${name} — recovery: durable ledger has exactly one parseable row, count 1`,
        rows.length === 1 && rows[0].count === 1);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(okData, { recursive: true, force: true });
    }
  }

  /* ── 5a. SHORT WRITE — writeSync persists fewer bytes than requested ────────
   * MUST-FAIL (synthesized pre-fix): a single unchecked `writeSync` (round 2's
   * shape) persists a truncated, UNPARSEABLE row while the caller claims LOGGED.
   * PASS: the real recorder loops to completion and treats a stalled write as
   * failure → DENY, no "LOGGED" claim, count not advanced. */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    const realWrite = fs.writeSync;
    try {
      // Non-vacuity: prove a truncated write yields an invalid JSONL row, so the
      // round-2 "write once, ignore the return, claim LOGGED" path was unsound.
      const probe = path.join(dir, 'probe');
      const pfd = fs.openSync(probe, 'a');
      realWrite(pfd, '{"count":1,"eve'); // 15 of ~120 bytes — a truncated row
      fs.closeSync(pfd);
      let threw = false;
      try { JSON.parse(fs.readFileSync(probe, 'utf8')); } catch { threw = true; }
      ok('5a MUST-FAIL: a single unchecked short write leaves an UNPARSEABLE row (pre-fix defect)', threw);

      // Inject a short write into the REAL recorder: first call writes 12 real
      // bytes and returns 12; every later call makes no progress (returns 0).
      let calls = 0;
      (fs as any).writeSync = (fd: number, buf: any, off?: number, len?: number, pos?: any) => {
        calls++;
        if (calls === 1) return realWrite(fd, buf, off ?? 0, Math.min(12, len ?? buf.length), pos ?? null);
        return 0; // stalled — no progress
      };
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-SHORT' });
      const out = drive(rec);
      (fs as any).writeSync = realWrite;
      ok('5a PASS: short write → bypass DENIED (fail closed)', decision(out) === 'deny');
      ok('5a PASS: denial does not falsely claim the bypass was LOGGED', !/allowed and LOGGED/.test(reasonOf(out)));
      assertCountNotAdvanced('5a', rec);
    } finally {
      (fs as any).writeSync = realWrite;
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ── 5b. ENOSPC — disk exhaustion, injected mid-write ───────────────────────
   * A real ENOSPC can surface as a short write followed by a throwing write.
   * The recorder must loop past the short write, hit the ENOSPC throw, and DENY. */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    const realWrite = fs.writeSync;
    try {
      let calls = 0;
      (fs as any).writeSync = (fd: number, buf: any, off?: number, len?: number, pos?: any) => {
        calls++;
        if (calls === 1) return realWrite(fd, buf, off ?? 0, Math.min(12, len ?? buf.length), pos ?? null);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      };
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-ENOSPC' });
      const out = drive(rec);
      (fs as any).writeSync = realWrite;
      ok('5b PASS: injected ENOSPC → bypass DENIED (fail closed)', decision(out) === 'deny');
      ok('5b PASS: no false LOGGED claim on ENOSPC', !/allowed and LOGGED/.test(reasonOf(out)));
      assertCountNotAdvanced('5b', rec);
    } finally {
      (fs as any).writeSync = realWrite;
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ── 5c. FIFO ledger — a named pipe where the regular file must be ──────────
   * MUST-FAIL (real pre-fix behaviour): a plain `openSync(fifo, 'a')` with no
   * reader BLOCKS FOREVER — proven by a child process that has to be killed on
   * timeout. PASS: the real recorder opens O_NONBLOCK and returns PROMPTLY with
   * a DENY (ENXIO with no reader, else the fstat rejects the non-regular file). */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    const fifo = RECORD_DIR(dir); // round 4: a FIFO where the record DIRECTORY must be
    try {
      execFileSync('mkfifo', [fifo]);
      // MUST-FAIL: the pre-fix blocking open, in a child killed after 1.2s.
      const child = spawnSync(process.execPath,
        ['-e', 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"a");fs.writeSync(fd,"x");', fifo],
        { timeout: 1200 });
      ok('5c MUST-FAIL: a plain blocking open of a reader-less FIFO hangs (pre-fix defect)',
        child.error != null && (child.error as any).code === 'ETIMEDOUT');
      // PASS: the real recorder denies PROMPTLY.
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-FIFO' });
      const t0 = Date.now();
      const out = drive(rec);
      const elapsed = Date.now() - t0;
      ok('5c PASS: FIFO ledger → bypass DENIED', decision(out) === 'deny');
      ok('5c PASS: the decision returned promptly (< 1000ms, did not block)', elapsed < 1000, `${elapsed}ms`);
      ok('5c PASS: no false LOGGED claim on a FIFO ledger', !/allowed and LOGGED/.test(reasonOf(out)));
      assertCountNotAdvanced('5c', rec);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ── 5d. SYMLINK ledger — the ledger path is a symlink to another file ──────
   * MUST-FAIL (real pre-fix behaviour): a plain `openSync(symlink, 'a')` FOLLOWS
   * the link and writes to the decoy — a bypass silently redirected while it
   * claims to be logged at the canonical path. PASS: O_NOFOLLOW makes the real
   * recorder refuse (ELOOP) and the decoy is never touched. */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    // Round 4: the record DIRECTORY is a symlink to a decoy directory.
    const link = RECORD_DIR(dir);
    const decoy = path.join(dir, 'decoy-dir');
    try {
      fs.mkdirSync(decoy);
      fs.symlinkSync(decoy, link);
      // MUST-FAIL: prove a followed symlink lets a write reach the decoy.
      fs.writeFileSync(path.join(link, 'PREFIX_WOULD_WRITE_HERE'), 'x');
      ok('5d MUST-FAIL: a followed symlinked dir lets a write land in the DECOY (pre-fix defect)',
        fs.existsSync(path.join(decoy, 'PREFIX_WOULD_WRITE_HERE')));
      fs.rmSync(path.join(decoy, 'PREFIX_WOULD_WRITE_HERE')); // reset the decoy before the real path runs
      // PASS: the real recorder refuses to follow the symlink.
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-SYMLINK' });
      const out = drive(rec);
      ok('5d PASS: symlinked record dir → bypass DENIED (O_NOFOLLOW)', decision(out) === 'deny');
      ok('5d PASS: the decoy target was NOT written by the recorder', fs.readdirSync(decoy).length === 0);
      ok('5d PASS: no false LOGGED claim on a symlink ledger', !/allowed and LOGGED/.test(reasonOf(out)));
      assertCountNotAdvanced('5d', rec);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ── 5e. THROW injected in the recorder (e.g. fsync EIO) ─────────────────────
   * A durability primitive throwing must DENY, never allow (round 1 swallowed
   * this into an allow). */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    const realFsync = fs.fsyncSync;
    try {
      (fs as any).fsyncSync = () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-THROW' });
      const out = drive(rec);
      (fs as any).fsyncSync = realFsync;
      ok('5e PASS: a throw in the recorder (fsync EIO) → bypass DENIED', decision(out) === 'deny');
      ok('5e PASS: no false LOGGED claim when the recorder throws', !/allowed and LOGGED/.test(reasonOf(out)));
      assertCountNotAdvanced('5e', rec);
    } finally {
      (fs as any).fsyncSync = realFsync;
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ── 5f. THROW injected in decide() — the outer fail-open must NOT be reached ─
   * MUST-FAIL: `decide()` given a throwing `command` getter really throws, so
   * without the hook's own try/catch the outer `catch { return {} }` (allow /
   * no-decision) would run. PASS: `evaluateOrchestratorProfileHook` catches it
   * and DENIES. */
  {
    const throwingInput = { tool_name: 'Bash', tool_input: { get command() { throw new Error('injected decide throw'); } } };
    let decideThrew = false;
    try { decide({ toolName: 'Bash', toolInput: throwingInput.tool_input }); } catch { decideThrew = true; }
    ok('5f MUST-FAIL: decide() with a throwing command getter really throws (would hit the outer fail-open)', decideThrew);
    const rec = makeOrchBypassRecorder({ sessionId: 'sess-DECIDE' });
    const out = evaluateOrchestratorProfileHook(throwingInput as any, rec);
    ok('5f PASS: a throw in decide() → DENY (fail closed, outer catch never reached)', decision(out) === 'deny');
    ok('5f PASS: the deny reason names it could not be evaluated', /could not be evaluated/.test(reasonOf(out)));
    // BUG-226 round 3 — the fail-closed message now also tells the session what IS
    // available (guarded append, so a throw from the help helper degrades to the
    // bare message rather than taking the session down).
    ok('5f PASS: the fail-closed reason carries the "Still available here" help (BUG-226 r3)',
      /Still available here/.test(reasonOf(out)));
  }

  /* ── 5g. Happy path still works through the extracted hook function ─────────
   * A regular writable ledger through the REAL hook path allows and logs a
   * complete, parseable row. Guards against the fix over-denying. */
  {
    const dir = freshDataDir();
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    try {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-OK' });
      const out = drive(rec);
      ok('5g PASS: a normal writable ledger → ALLOW #1 with LOGGED claim', decision(out) === 'allow' && /allowed and LOGGED/.test(reasonOf(out)));
      const files = fs.readdirSync(RECORD_DIR(dir));
      const raw = files.length === 1 ? fs.readFileSync(path.join(RECORD_DIR(dir), files[0]), 'utf8') : '';
      const rows = rowsIn(dir);
      ok('5g PASS: exactly one complete, parseable row landed', rows.length === 1 && rows[0].event === 'orch-bypass' && rows[0].count === 1);
      ok('5g PASS: the row ends with a newline (complete)', raw.endsWith('\n'));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ═══ 6. round 4 — one FILE per record, published by atomic rename ══════════
   * Three clean-room refutations in a row broke the append-to-one-JSONL ledger
   * in a new way each time; round 3's were (1) orphaned partial bytes fused
   * with the next row, (2) concurrent sessions interleaving inside one row, and
   * (3) the REGISTERED callback failing open on a throw in the shared
   * pre-profile code. Round 4 changes the design (WA §N), not the patch: each
   * record is written to a temp file, fsync'd, renamed into
   * `orch-bypass-audit/`, and the directory fsync'd — a reader sees a record
   * complete or not at all. Must-FAIL for (1)/(2) runs the SAME attack against
   * the PINNED round-3 writer (scripts/fixtures/feat-152/round3-recorder.mts —
   * a fixed baseline, never edited); for (3) the non-profile session is the
   * fixed contrast (the throw genuinely reaches the outer catch there). */
  const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'feat-152');
  const { round3Record } = await import('./fixtures/feat-152/round3-recorder.mts');
  // Layout-agnostic collector (test-side): every record either layout could
  // hold — JSONL lines AND per-record files — so a corrupt record in EITHER is
  // counted. The product reader is checked against it separately.
  function collectAudit(dataDir: string) {
    const records: any[] = [];
    let unparseable = 0;
    let tempLeft = 0;
    const jsonl = path.join(dataDir, 'orch-bypass-audit.jsonl');
    if (fs.existsSync(jsonl)) {
      for (const l of fs.readFileSync(jsonl, 'utf8').split('\n')) {
        if (!l) continue;
        try { records.push(JSON.parse(l)); } catch { unparseable++; }
      }
    }
    const d = path.join(dataDir, 'orch-bypass-audit');
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      for (const name of fs.readdirSync(d)) {
        if (name.startsWith('.')) { tempLeft++; continue; }
        try { records.push(JSON.parse(fs.readFileSync(path.join(d, name), 'utf8'))); } catch { unparseable++; }
      }
    }
    return { records, unparseable, tempLeft, jsonlExists: fs.existsSync(jsonl) };
  }
  const rt = await import('../src/server/runtime/claude-runtime.ts') as any;
  const withData = <T,>(dir: string, fn: () => T): T => {
    const prev = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = dir;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
    }
  };
  const stallAfter12 = () => {
    const realWrite = fs.writeSync;
    let calls = 0;
    (fs as any).writeSync = (fd: number, buf: any, off?: number, len?: number, pos?: any) =>
      (++calls === 1 ? realWrite(fd, buf, off ?? 0, Math.min(12, len ?? buf.length), pos ?? null) : 0);
    return () => { (fs as any).writeSync = realWrite; };
  };
  const row = (count: number) => ({ at: new Date().toISOString(), event: 'orch-bypass', count, sessionId: 'S', reason: GOOD, command: MARKER });

  /* ── 6a. FINDING 1 — orphaned partial bytes must not corrupt the next record ─ */
  {
    // MUST-FAIL on the pinned round-3 writer: stall → deny, then a good write
    // fuses onto the 12 orphaned bytes → an unparseable line while it "LOGGED".
    const r3 = freshDataDir();
    const restore = stallAfter12();
    const firstR3 = round3Record(r3, row(1));
    restore();
    const secondR3 = round3Record(r3, row(1));
    const c3 = collectAudit(r3);
    ok('6a MUST-FAIL: round-3 writer — stalled write denied, next write ALLOWED onto a corrupt ledger',
      firstR3 === false && secondR3 === true && c3.unparseable > 0, JSON.stringify(c3));
    fs.rmSync(r3, { recursive: true, force: true });

    // PASS on the real hook path.
    const dir = freshDataDir();
    withData(dir, () => {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-ORPHAN' });
      const undo = stallAfter12();
      let first: any;
      try { first = drive(rec); } finally { undo(); }
      const second = drive(rec);
      const c = collectAudit(dir);
      ok('6a PASS: the stalled write is DENIED', decision(first) === 'deny');
      ok('6a PASS: the next bypass is ALLOWED as #1', decision(second) === 'allow' && /ORCH-BYPASS #1 this session/.test(reasonOf(second)));
      ok('6a PASS: every stored record parses (no orphan fused into it)', c.unparseable === 0, JSON.stringify(c));
      ok('6a PASS: exactly one record, count 1', c.records.length === 1 && c.records[0].count === 1, `${c.records.length}`);
      ok('6a PASS: the failed attempt left no temp file behind', c.tempLeft === 0, `${c.tempLeft}`);
      ok('6a PASS: no JSONL ledger is written any more', !c.jsonlExists);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ── 6b. FINDING 2 — N concurrent sessions, separate PROCESSES ─────────────
   * Each writer forces every write short (16 bytes + 1 ms pause), so rows are
   * multi-syscall exactly as the refutation exploited. While they race, the
   * parent keeps READING the ledger — a reader must never see a partial record
   * (the "partial and truncated reads" rule). */
  async function race(mode: 'real' | 'round3', N: number, K: number) {
    const dir = freshDataDir();
    const go = path.join(dir, 'GO');
    const kids = Array.from({ length: N }, (_, i) => {
      const child = spawn(process.execPath, ['--no-warnings', path.join(FIX, 'concurrent-writer.mts'), mode, `sess-${i}`, String(K), go],
        { env: { ...process.env, CLAUDE_STATION_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      return new Promise<{ code: number | null; out: string; err: string }>((res) => child.on('close', (code) => res({ code, out, err })));
    });
    await new Promise((r) => setTimeout(r, 1500)); // let every writer load and park on GO
    fs.writeFileSync(go, '');
    let done = false;
    const all = Promise.all(kids).then((v) => { done = true; return v; });
    let midReads = 0;
    let midUnparseable = 0;
    while (!done) {
      const c = collectAudit(dir);
      midReads++;
      midUnparseable += c.unparseable;
      await new Promise((r) => setTimeout(r, 3));
    }
    const results = await all;
    const final = collectAudit(dir);
    return { dir, results, final, midReads, midUnparseable };
  }
  {
    const N = 6;
    const K = 5;
    const r3 = await race('round3', N, K);
    ok('6b MUST-FAIL: round-3 writer — concurrent writers leave UNPARSEABLE rows while every call "LOGGED"',
      r3.final.unparseable > 0 && r3.results.every((r) => r.code === 0 && JSON.parse(r.out).decisions.every((x: string) => x === 'allow')),
      `unparseable=${r3.final.unparseable} midUnparseable=${r3.midUnparseable}`);
    fs.rmSync(r3.dir, { recursive: true, force: true });

    const real = await race('real', N, K);
    ok('6b PASS: all N writer processes exited 0', real.results.every((r) => r.code === 0), real.results.map((r) => r.err).join(' | ').slice(0, 400));
    const decisions = real.results.flatMap((r) => { try { return JSON.parse(r.out).decisions; } catch { return ['unparsed']; } });
    ok(`6b PASS: all ${N * K} concurrent bypasses were ALLOWED`, decisions.length === N * K && decisions.every((x: string) => x === 'allow'), JSON.stringify(decisions));
    ok('6b PASS: every stored record parses', real.final.unparseable === 0, `${real.final.unparseable}`);
    ok(`6b PASS: exactly ${N * K} records`, real.final.records.length === N * K, `${real.final.records.length}`);
    let perSessionOk = true;
    for (let i = 0; i < N; i++) {
      const counts = real.final.records.filter((r) => r.sessionId === `sess-${i}`).map((r) => r.count).sort((a, b) => a - b);
      if (JSON.stringify(counts) !== JSON.stringify(Array.from({ length: K }, (_, j) => j + 1))) perSessionOk = false;
    }
    ok('6b PASS: each session holds exactly counts 1..K', perSessionOk);
    ok('6b PASS: no temp files left, no JSONL written', real.final.tempLeft === 0 && !real.final.jsonlExists);
    ok(`6b PASS: ${real.midReads} reads DURING the race never saw a partial record`,
      real.midReads > 0 && real.midUnparseable === 0, `midUnparseable=${real.midUnparseable}`);
    if (typeof rt.readOrchBypassAudit === 'function') {
      const pr = withData(real.dir, () => rt.readOrchBypassAudit());
      ok('6b PASS: the product reader agrees (N*K records, none unparseable)',
        pr.records.length === N * K && pr.unparseable.length === 0, `${pr.records.length}/${pr.unparseable.length}`);
    } else {
      ok('6b PASS: the product exports readOrchBypassAudit()', false, 'missing');
    }
    fs.rmSync(real.dir, { recursive: true, force: true });
  }

  /* ── 6c. FINDING 3 — the REGISTERED callback fails CLOSED in profile sessions ─
   * Driven through the actual callback `ClaudeRuntime.start()` registers
   * (captured at the SDK boundary in a child with module mocks). A throwing
   * getter on `tool_input` makes the git block / Fable gate / file lock throw
   * BEFORE the profile guard, inside the callback's outer try. */
  {
    const probe = (mode: 'orch' | 'plain') => {
      const dir = freshDataDir();
      const r = spawnSync(process.execPath,
        ['--experimental-test-module-mocks', '--no-warnings', path.join(FIX, 'wired-hook-probe.mts'), mode],
        { env: { ...process.env, CLAUDE_STATION_DATA: dir }, encoding: 'utf8', timeout: 30_000 });
      const c = collectAudit(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      let res: any = null;
      try { res = JSON.parse(r.stdout.trim().split('\n').pop() ?? ''); } catch { /* reported below */ }
      return { res, status: r.status, stderr: r.stderr, audit: c };
    };
    const plain = probe('plain');
    ok('6c probe (non-profile session) ran', plain.res != null, plain.stderr.slice(0, 300));
    // Fixed contrast / non-vacuity: in a NON-profile session the same throwing
    // input returns `{}` — the throw really reaches the outer catch, and
    // non-profile behaviour is unchanged by round 4.
    const empty = (o: any) => o && typeof o === 'object' && Object.keys(o).length === 0;
    ok('6c MUST-FAIL contrast: non-profile session — a throw in pre-profile code still returns {} (unchanged)',
      !!plain.res && empty(plain.res.bashThrow) && empty(plain.res.agentThrow) && empty(plain.res.writeOwnerThrow));
    ok('6c non-profile session: no profile decisions at all (unchanged)',
      !!plain.res && Object.values(plain.res).every(empty));

    const orch = probe('orch');
    ok('6c probe (orchestrator-profile session) ran', orch.res != null, orch.stderr.slice(0, 300));
    const dec = (k: string) => orch.res?.[k]?.hookSpecificOutput?.permissionDecision;
    ok('6c PASS: Bash with a throwing command getter → DENY via the registered callback', dec('bashThrow') === 'deny');
    ok('6c PASS: Bash with a throwing Proxy tool_input → DENY', dec('bashProxyThrow') === 'deny');
    ok('6c PASS: a lane Bash call that throws in shared code → DENY (profile session fails closed)', dec('laneBashThrow') === 'deny');
    ok('6c PASS: Agent with a throw in the Fable gate → DENY', dec('agentThrow') === 'deny');
    ok('6c PASS: Write with a throw in the callback\'s file-lock owner step → DENY', dec('writeOwnerThrow') === 'deny');
    // Recorded, unchanged: a throw inside the file lock's OWN classifier is
    // swallowed there (FEAT-129's degrade-to-allow) and the profile allows
    // Write, so no throw reaches the callback — not a profile hole, not changed.
    ok('6c unchanged: a throw inside evaluateFileLock\'s own classifier stays FEAT-129\'s allow ({})', empty(orch.res?.writeThrow));
    ok('6c PASS: the fail-closed reason says the decision could not be evaluated',
      /could not be evaluated/.test(orch.res?.bashThrow?.hookSpecificOutput?.permissionDecisionReason ?? ''));
    // BUG-226 round 3 — the registered callback's OUTER catch (plan-review finding
    // B) is a char-for-char duplicate of the inner fail-closed string; both now
    // share ONE builder and carry the help.
    ok('6c PASS: the outer-catch fail-closed reason also carries the "Still available here" help (BUG-226 r3)',
      /Still available here/.test(orch.res?.bashThrow?.hookSpecificOutput?.permissionDecisionReason ?? ''));
    ok('6c anti-regression: a valid bypass is still ALLOWED through the registered callback', dec('bypass') === 'allow');
    ok('6c anti-regression: a plain blocked command is still DENIED', dec('deniedPlain') === 'deny');
    ok('6c anti-regression: a lane keeps Bash (no decision)', empty(orch.res?.laneBash));
    ok('6c anti-regression: the registered bypass wrote exactly one parseable record',
      orch.audit.records.length === 1 && orch.audit.unparseable === 0, JSON.stringify(orch.audit).slice(0, 200));
  }

  /* ── 6d. size caps on reason and command ─────────────────────────────────── */
  {
    const dir = freshDataDir();
    withData(dir, () => {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-CAP' });
      const bigReason = 'need the output for my next decision ' + 'z'.repeat(50_000);
      const out = rec({ reason: bigReason, command: `# ORCH-BYPASS: ${bigReason}\ncat x` });
      const c = collectAudit(dir);
      const r = c.records[0] ?? {};
      ok('6d PASS: an oversized reason is still allowed (and logged)', decision(out) === 'allow' && c.records.length === 1);
      ok('6d PASS: the stored reason is capped (<= 2000 chars) and flagged truncated',
        typeof r.reason === 'string' && r.reason.length <= 2000 && r.reasonTruncated === true, `${r.reason?.length}`);
      ok('6d PASS: the stored command is capped (<= 500 chars) and flagged truncated',
        typeof r.command === 'string' && r.command.length <= 500 && r.commandTruncated === true, `${r.command?.length}`);
      const rdir = path.join(dir, 'orch-bypass-audit');
      const files = fs.existsSync(rdir) ? fs.readdirSync(rdir) : [];
      ok('6d PASS: the record file stays small (< 4 KiB)', files.length === 1 && fs.statSync(path.join(rdir, files[0])).size < 4096);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ── 6e. a pre-existing JSONL ledger is left alone (no migration) ─────────── */
  {
    const dir = freshDataDir();
    const legacy = path.join(dir, 'orch-bypass-audit.jsonl');
    const legacyBytes = '{"legacy":true}\n{"at":"2026-{"at":"broken\n';
    fs.writeFileSync(legacy, legacyBytes);
    withData(dir, () => {
      const out = drive(makeOrchBypassRecorder({ sessionId: 'sess-LEGACY' }));
      ok('6e PASS: a bypass beside a legacy (even corrupt) JSONL is allowed', decision(out) === 'allow');
    });
    ok('6e PASS: the legacy JSONL is byte-for-byte untouched', fs.readFileSync(legacy, 'utf8') === legacyBytes);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ── 6f. failure AFTER the rename (directory fsync) → DENY, record withdrawn ─ */
  {
    const dir = freshDataDir();
    withData(dir, () => {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-DIRSYNC' });
      const realFsync = fs.fsyncSync;
      let n = 0;
      (fs as any).fsyncSync = (fd: number) => {
        if (++n === 2) throw Object.assign(new Error('EIO: i/o error, fsync (dir)'), { code: 'EIO' });
        return realFsync(fd);
      };
      let out: any;
      try { out = drive(rec); } finally { (fs as any).fsyncSync = realFsync; }
      const c = collectAudit(dir);
      ok('6f PASS: a failed directory fsync → DENY', decision(out) === 'deny');
      ok('6f PASS: the un-durable record is withdrawn and no temp is left', c.records.length === 0 && c.tempLeft === 0, JSON.stringify(c));
      const next = drive(rec);
      ok('6f PASS: count did not advance — next good bypass is #1', decision(next) === 'allow' && /#1 this session/.test(reasonOf(next)));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ── 6g. the record directory itself must be a real directory ───────────── */
  for (const [label, make] of [
    ['a regular FILE (ENOTDIR)', (p: string) => fs.writeFileSync(p, 'x')],
    ['a SYMLINK to a decoy dir', (p: string) => { fs.mkdirSync(p + '-decoy'); fs.symlinkSync(p + '-decoy', p); }],
    ['a FIFO', (p: string) => execFileSync('mkfifo', [p])],
  ] as const) {
    const dir = freshDataDir();
    const p = path.join(dir, 'orch-bypass-audit');
    make(p);
    withData(dir, () => {
      const t0 = Date.now();
      const out = drive(makeOrchBypassRecorder({ sessionId: 'sess-DIRKIND' }));
      ok(`6g PASS: record dir is ${label} → DENY promptly`, decision(out) === 'deny' && Date.now() - t0 < 1000);
    });
    if (fs.existsSync(p + '-decoy')) ok(`6g PASS: ${label} — decoy untouched`, fs.readdirSync(p + '-decoy').length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ═══ 7. round 5 — FINDING 1: the publish must NOT overwrite an existing target
   * The round-4 clean-room verifier PLANTED a file at the exact final record
   * name; `renameSync` silently CLOBBERED it and still returned allow. Round 5
   * publishes no-clobber with `link(2)`, which fails EEXIST when the final name
   * exists. Both cases drive the REAL recorder; they differ only in the publish
   * primitive, and the collision (a file already at the final name) is forced by
   * a `linkSync` shim so no name has to be predicted. */
  {
    const PLANT = 'PLANTED-DO-NOT-OVERWRITE\n';
    // MUST-FAIL (explicitly constructed pre-fix variant): a rename-based publish
    // overwrites the planted target and ALLOWS.
    {
      const dir = freshDataDir();
      const realRename = fs.renameSync;
      const realLink = fs.linkSync;
      let clobbered = false;
      (fs as any).linkSync = (from: string, to: string) => {
        fs.writeFileSync(to, PLANT);          // a file already sits at the final name
        realRename(from, to);                 // pre-fix publish: rename CLOBBERS it
        clobbered = fs.readFileSync(to, 'utf8') !== PLANT;
      };
      let out: any;
      try { out = withData(dir, () => drive(makeOrchBypassRecorder({ sessionId: 'sess-CLOBBER' }))); }
      finally { (fs as any).linkSync = realLink; }
      ok('7 MUST-FAIL: a rename-based publish overwrites a planted final path and ALLOWS (pre-fix F1 defect)',
        clobbered && decision(out) === 'allow', `clobbered=${clobbered} decision=${decision(out)}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // PASS: the real recorder refuses a pre-existing final path (no-clobber link).
    {
      const dir = freshDataDir();
      const realLink = fs.linkSync;
      let planted = '';
      (fs as any).linkSync = (from: string, to: string) => {
        fs.writeFileSync(to, PLANT);          // target ALREADY present at the exact final name
        planted = to;
        return realLink(from, to);            // real link → genuine kernel EEXIST
      };
      let out: any;
      try { out = withData(dir, () => drive(makeOrchBypassRecorder({ sessionId: 'sess-NOCLOBBER' }))); }
      finally { (fs as any).linkSync = realLink; }
      ok('7 PASS: a pre-existing final path → bypass DENIED (link EEXIST, no clobber)', decision(out) === 'deny');
      ok('7 PASS: the planted file is left byte-for-byte untouched',
        planted !== '' && fs.readFileSync(planted, 'utf8') === PLANT);
      ok('7 PASS: no false LOGGED claim on a collision', !/allowed and LOGGED/.test(reasonOf(out)));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ═══ 8. round 5 — FINDING 2: a double-fault leftover changes neither count nor
   * outcome. When the directory fsync fails AND the rollback unlink of the
   * just-published record ALSO fails, the record stays on disk (a documented
   * OVER-report). The per-session count comes ONLY from the in-memory tally, so
   * the denied bypass advances nothing and the next good bypass is still #1. */
  {
    const dir = freshDataDir();
    const realFsync = fs.fsyncSync;
    const realUnlink = fs.unlinkSync;
    let out: any;
    let leftover = 0;
    withData(dir, () => {
      const rec = makeOrchBypassRecorder({ sessionId: 'sess-DBLFAULT' });
      let nf = 0;
      // Fault 1: the DIRECTORY fsync (the 2nd fsync) fails — the publish is not durable.
      (fs as any).fsyncSync = (fd: number) => { if (++nf === 2) throw Object.assign(new Error('EIO: i/o error, fsync (dir)'), { code: 'EIO' }); return realFsync(fd); };
      // Fault 2: the rollback unlink of the just-published record ALSO fails, so
      // the record cannot be withdrawn and is left behind.
      (fs as any).unlinkSync = (p: string) => { if (typeof p === 'string' && p.endsWith('.json')) throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' }); return realUnlink(p); };
      try { out = drive(rec); } finally { (fs as any).fsyncSync = realFsync; (fs as any).unlinkSync = realUnlink; }
      leftover = collectAudit(dir).records.length;
      const next = drive(rec); // real fsync/unlink restored
      ok('8 PASS: the double-fault bypass is DENIED (fail closed)', decision(out) === 'deny');
      ok('8 PASS: the denied leftover stayed on disk (documented over-report, never under-report)', leftover === 1, `${leftover}`);
      ok('8 PASS: the leftover did NOT advance the count — next good bypass is #1',
        decision(next) === 'allow' && /ORCH-BYPASS #1 this session/.test(reasonOf(next)), reasonOf(next).slice(0, 80));
    });
    fs.rmSync(dir, { recursive: true, force: true });
    // MUST-FAIL contrast (non-vacuity): a count DERIVED from the directory would
    // count the leftover and report the next bypass as #2, not #1 — proving the
    // in-memory-only count source is load-bearing (FEAT-152 F2).
    {
      const dir2 = freshDataDir();
      const rd = path.join(dir2, 'orch-bypass-audit');
      fs.mkdirSync(rd, { recursive: true });
      fs.writeFileSync(path.join(rd, `2026-01-01T00-00-00-000Z-sess-x-${'a'.repeat(24)}.json`),
        JSON.stringify({ event: 'orch-bypass', count: 1, sessionId: 'sess-x' }) + '\n');
      const diskDerivedNext = withData(dir2, () => rt.readOrchBypassAudit().records.length) + 1;
      ok('8 MUST-FAIL contrast: a directory-derived count would MIS-count the leftover as #2 (in-memory is #1)',
        diskDerivedNext === 2, `${diskDerivedNext}`);
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }
} finally {
  try { fs.rmSync(scratchData, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail === 0 ? 0 : 1);
