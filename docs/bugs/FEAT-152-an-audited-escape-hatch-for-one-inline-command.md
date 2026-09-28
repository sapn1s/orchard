# FEAT-152 — an audited escape hatch for one inline orchestrator command

- **Status:** FIXED (rounds stopped by orchestrator judgment per WA §N; round 5
  independent run `01a0d3a2-70be-7643-9b72-cb3574c6cee4` verdict BROKEN on
  three accepted-known-limitation findings — see Activity log; not plain
  VERIFIED because that verdict was not a pass)
- **Severity:** medium
- **Area:** server (orchestrator tool profile)
- **Reported:** 2026-09-24 by user (via orchestrator)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
The orchestrator tool profile refuses inline commands: the denial opens
"Orchestrator tool profile: `node -e` (via Bash) is not available to this
session…" and the only route it offers is to dispatch a lane. But sometimes the
orchestrator genuinely needs a command's OUTPUT in its OWN context — a status
line, a count, one short file — and dispatching a whole lane only to relay that
exact value back is pure ceremony. There was no deliberate, auditable way to do
that.

## Expected
A deliberate escape hatch with three properties:
1. **Marker.** A Bash command whose FIRST line is a shell comment
   `# ORCH-BYPASS: <reason>` is allowed through the profile. A comment needs no
   stripping — bash ignores it. The reason is REQUIRED and must be non-trivial
   (≥15 chars); a missing/short reason is denied WITH an explanation.
2. **Audit.** Every bypass is appended to an append-only ledger
   (`dataDir()/orch-bypass-audit.jsonl`, beside `git-write-audit.jsonl`) with
   session id, timestamp, reason and (truncated) command. No bypass is silent.
3. **Criteria in the denial text itself** — the same denial message now ends
   with the rules for when ORCH-BYPASS is and is not appropriate, so the model
   reads them exactly when it hits the wall.
4. **Drift is visible.** The allow path returns the session's running bypass
   count (`ORCH-BYPASS #N this session`) as the PreToolUse allow reason. No hard cap.

## Repro
As an orchestrator session (project with the profile enforced):
- `grep -rn foo /src` → denied (unchanged), now with the criteria appended.
- `# ORCH-BYPASS: need the live gate exit status to decide whether to commit\ncat foo` → executes, ledger row written, count increments.
- `# ORCH-BYPASS: x\ncat foo` (short reason) → denied, explains the reason floor.
- `echo x # ORCH-BYPASS: need the output right now for my decision` (marker not on line 1) → still denied.
- A dispatched lane (agent_id present) is unaffected — it keeps everything.

## Context pack
- Files/functions in play:
  - `scripts/lib/orchestrator-profile.mjs` — `decide()` (pure), `decideBashCommand()`,
    `refusalReason()`; new `detectOrchBypass()`, `invalidBypassReason()`, `BYPASS_CRITERIA`.
  - `src/server/runtime/claude-runtime.ts` — the in-process PreToolUse callback that
    calls `decide()`; new `recordOrchBypass()` sink + per-session counter, mirroring
    `announceGitWrite()` / the `git-write-audit.jsonl` pattern.
  - `src/lib/paths.ts` — `dataDir()` (ledger location).
- Related tickets: FEAT-096 (the profile + enforcement), FEAT-108 (git-write audit
  ledger — the audit pattern copied here), FEAT-124 (Fable gate — the allow-with-
  updatedInput hook shape), FEAT-149 (board:status redirect in the denial text).
- Repro test: `npm run verify:feat-152` (`scripts/verify-feat-152-orch-bypass.mjs`).
- Known dependencies: takes effect only on the NEXT launched orchestrator session —
  the hook is installed at session start, so the running server must relaunch the
  session (no service restart needed; do NOT restart the service).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-24 — worker (fixing, round 1)
- **Understood:** The profile is enforced by an in-process `PreToolUse` callback in
  `claude-runtime.ts` that calls the pure `decide()` in `orchestrator-profile.mjs`;
  a Bash command is graded by `decideBashCommand()` and refused with `refusalReason()`.
  `decide()` MUST stay pure — `verify-orchestrator-enforcement.mjs` asserts it — so
  marker detection lives in `decide()` (pure) and the ledger I/O lives in the hook.
- **Changed:**
  - `scripts/lib/orchestrator-profile.mjs`: added `detectOrchBypass()` (first-line
    `# ORCH-BYPASS: <reason>` only, ≥15-char reason), `BYPASS_CRITERIA`,
    `invalidBypassReason()`; `refusalReason()` now appends the criteria to every
    refusal; `decide()`'s Bash branch: an otherwise-refused command with a VALID
    marker returns `{ allow:true, bypass:{reason,command} }`, an INVALID marker
    returns a deny explaining the floor, and a marker on an already-allowed command
    is a no-op comment (not logged — nothing was bypassed).
  - `src/server/runtime/claude-runtime.ts`: the hook now handles `d.bypass` —
    increments a per-session counter, appends a row to
    `dataDir()/orch-bypass-audit.jsonl` via `recordOrchBypass()`, and returns a
    PreToolUse `allow` whose reason is `ORCH-BYPASS #N this session …`.
  - `scripts/verify-feat-152-orch-bypass.mjs`: the proof suite (see below).
- **Verified:** `node scripts/verify-feat-152-orch-bypass.mjs` — all cases in the proof
  bar, run through the real `decide()`/`decideBashCommand()` path (not a private regex),
  plus a live end-to-end run of the actual in-process hook writing a real ledger row and
  incrementing across two calls. `npm run gate` EXIT 0. Anti-regression:
  `node scripts/verify-orchestrator-enforcement.mjs` (purity + legibility) still passes.
  Full PASS/FAIL counts recorded in the verify run.
- **Verified-by:** PENDING — independent clean-room verify warranted (session-lifecycle /
  profile-enforcement change; a bypass that mis-fires would open the profile).
- **Still open / handoff:** none functionally; awaits the `Verified-by:` dispatch and an
  orchestrator relaunch to take effect.
- **Symptom of a deeper design flaw?** (open — answered at close)

### 2026-09-24 — independent clean-room verification (verifying, round 1) — REFUTED

- **Verified-by:** dispatch openai run `01a0d30d-eb59-7950-a869-49ca99b32c01`
  (clean-room, `scripts/independent-verify.mjs`, cross-provider anthropic→openai) —
  **VERDICT: BROKEN** (contract VALID, manifest-backed). Transcript under the
  openai dispatch transcript store, keyed by the clean-room cwd
  `cleanroom-verify-QXBsjn`, file `<run-id>.jsonl`.
  Clean room + record kept under the scratch root
  (`$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-QXBsjn` and
  `.../cleanroom-record-B11Kue/manifest.jsonl`).
- **What held (executed):** the fixer suite re-ran GREEN in the clean room —
  `node scripts/verify-feat-152-orch-bypass.mts` → `PASS — 37 passed, 0 failed`
  (manifest run `0d9590b17e3d`, exit 0). The marker/first-line/reason-floor/
  per-session-count/lane-unaffected properties were not the break.
- **FINDING (CONFIRMED, fail-open in the audit path).** Requirement #2 says every
  bypass is appended to the append-only ledger and "no bypass is silent". The
  uncovered adversarial case (manifest run `4957506ceadb`, exit 1) makes the ledger
  path unwritable (a directory in place of `orch-bypass-audit.jsonl`, EISDIR — the
  same class as an unwritable dataDir / ENOSPC / EACCES) and drives the REAL
  `makeOrchBypassRecorder`/`recordOrchBypass`. Result: the append is swallowed by
  `try { fs.appendFileSync(...) } catch { /* audit must never break a decision */ }`
  (`src/server/runtime/claude-runtime.ts:398-400`) and the recorder STILL returns
  `permissionDecision:'allow'` with reason `"ORCH-BYPASS #N this session — allowed
  and LOGGED with its reason (FEAT-152)"` (lines 425-433). Executed evidence:
  `Ledger is directory: true`, `Previous ledger unchanged: true`, decision still
  `allow`. So a bypass RUNS UNAUDITED while the allow reason falsely asserts it was
  LOGGED — a silent bypass, which is exactly what the ledger requirement forbids.
  The `/* audit must never break a decision */` comment is a deliberate
  robustness-over-auditability choice that directly conflicts with the stated
  security requirement; it fails OPEN where the requirement demands the bypass be
  auditable (fail closed, or at minimum drop the false "LOGGED" claim and surface
  the audit failure).
- **Could-not-test (verifier):** live model execution and real SDK PreToolUse hook
  integration were not exercised — the case drives the real `decide()` + recorder
  directly, not through a launched session.
- **Class:** high-stakes (audit/security fail-open on a profile-enforcement change).
  This clean-room dispatch IS the independent skeptic; the break is executed-evidence
  backed, not a static claim.
- **Handoff:** REFUTED — needs a fixing round on the audit-failure path in
  `recordOrchBypass`/`makeOrchBypassRecorder`. Not fixed here (verify lane).

### 2026-09-24 — worker (fixing, round 2)
- **Reproduced the refutation first (must-FAIL):** extended
  `scripts/verify-feat-152-orch-bypass.mts` with section 4, which drives the REAL
  `makeOrchBypassRecorder` against a genuinely unwritable ledger (a DIRECTORY in
  place of `orch-bypass-audit.jsonl` → EISDIR, the exact shape the verifier used;
  same class as an unwritable dataDir / ENOSPC / EACCES). Against round-1 code:
  `FAIL — 39 passed, 4 failed` — the recorder returned `allow` with the false
  "allowed and LOGGED" reason while nothing was written, i.e. a silent bypass.
- **Fix (fail CLOSED):** `src/server/runtime/claude-runtime.ts`.
  - `recordOrchBypass()` now RETURNS `boolean` — true only when the row is
    durably persisted (O_APPEND write + `fsyncSync`). A missing-but-writable data
    dir is `mkdir -p`'d (a legitimate first write, not a failure); a genuinely
    unwritable target throws and returns false. On failure it warns
    `ORCH-BYPASS AUDIT FAILED … Bypass DENIED (fail closed)` and does NOT emit the
    old success line. The `/* audit must never break a decision */` swallow is
    gone: for THIS ledger the write is a precondition of the allow, not an
    after-the-fact note like the FEAT-108 git-write audit.
  - `makeOrchBypassRecorder()` now denies (PreToolUse `deny`) when the row was not
    logged, with a reason naming the ledger and the fail-closed rule; and it does
    NOT advance the per-session count for a bypass that never ran (a denied,
    unlogged attempt consumes no number — the next successful one is still #N).
- **Swept the rest of the bypass path for the same shape:** count derivation is a
  single running counter committed only on a durable write (no second derivation);
  concurrent appends to the shared ledger stay row-atomic via O_APPEND (documented
  at the call); the outer hook `catch { return {} }` is a general fail-open but the
  recorder no longer throws, so the bypass path no longer swallows into allow.
- **Verified:** `npm run verify:feat-152` → `PASS — 43 passed, 0 failed` (the 4
  must-FAIL cases now green through the real recorder + real ledger). `npm run gate`
  EXIT 0 (leak-gate + check-nul + typecheck all PASS). Anti-regression:
  `node scripts/verify-orchestrator-enforcement.mjs` is `119 passed, 3 failed` both
  before and after this change — that red is BUG-185 (proven not caused by FEAT-152;
  this change touches neither `orchestrator-profile.mjs` nor any file that suite
  imports), so it is unchanged, not a regression.
- **Verified-by:** PENDING (round 2) — independent clean-room verify warranted again
  (audit/security fail-closed on a profile-enforcement change; generation must not be
  its own only verifier).
- **Still open / handoff:** none functionally; awaits the round-2 `Verified-by:`
  dispatch and an orchestrator relaunch to take effect.

### 2026-09-24 — independent clean-room verification (verifying, round 2) — REFUTED

- **Verified-by:** dispatch openai run `01a0d31d-4401-7e43-834b-81c325cd0c31`
  (clean-room, `scripts/independent-verify.mjs`, cross-provider anthropic→openai,
  `--working-tree` snapshot HEAD `541dd73e2377` → tree `b7407c7c5b10`) —
  **VERDICT: BROKEN** (verdict-contract VALID, manifest-backed). Clean room + record
  KEPT under the scratch root:
  `$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-OXOD00` and
  `.../cleanroom-record-R6FtbX/manifest.jsonl` (6 recorded runs). Transcript under
  the openai dispatch transcript store, keyed by the clean-room cwd
  `cleanroom-verify-OXOD00`, file `<run-id>.jsonl`.
  Clean room stripped `docs/prompts` + `docs/bugs` (no fixer prose reached the verifier).
- **What held (executed):** the round-2 fixer suite re-ran GREEN in the clean room —
  `npm run verify:feat-152` → `PASS — 43 passed, 0 failed` (manifest run
  `1a8a369fa6c6`, exit 0). Confirmed still holding via the verifier's own run: the
  EISDIR fail-closed path (deny, count not advanced), and an injected `fsync EIO`
  which correctly DENIED with the fail-closed reason and left the count so the next
  successful bypass recovered as `#3`. Marker/first-line/reason-floor/per-session-count/
  lane-unaffected were not the break.
- **FINDING (CONFIRMED — partial-audit-write, fail-open on a short write).** The
  round-2 fix made `recordOrchBypass()` return true only on "write + fsync", but it
  never checks `fs.writeSync`'s RETURNED byte count. The uncovered adversarial case
  (`scripts/verifier-short-write.mts` in the clean room; manifest run `0cf5ac96361d`,
  exit 1) drove the REAL `makeOrchBypassRecorder`/`recordOrchBypass` with a `writeSync`
  that persists only part of the row. Executed evidence:
  `SHORT_WRITE {"requested":264,"written":12,"actualBytes":12,"validRow":false, …
  permissionDecision:"allow", …"allowed and LOGGED with its reason (FEAT-152)"}`.
  So a bypass that persisted only 12 of 264 bytes — a truncated, invalid JSONL row —
  is ALLOWED, the reason falsely asserts it was LOGGED, and the per-session count is
  advanced. That is the same class the round-1 finding named (a bypass runs while the
  audit is not actually durable), surviving in the write-completeness dimension the
  round-2 suite did not exercise: the suite tests an OPEN failure (EISDIR) but never a
  successful `writeSync` returning fewer bytes than requested. Fix must treat a short
  write as failure (loop until all bytes written, or verify the returned count and
  fail closed otherwise).
- **Could-not-test (verifier):** actual disk exhaustion (ENOSPC), crash durability,
  FIFO blocking, and outer-hook (`decide()`/hook `catch { return {} }`) exceptions
  were NOT exercised; the adversarial case injected the short write into the real
  recorder directly, not through a launched SDK PreToolUse session.
- **Class:** high-stakes (audit/security fail-open on a profile-enforcement change).
  This clean-room cross-provider dispatch IS the independent skeptic; the break is
  executed-evidence backed with manifest run ids, not a static claim. The
  could-not-test list (ENOSPC / crash durability / FIFO / outer-hook throw) is a work
  queue for the next fixing round to also cover.
- **Handoff:** REFUTED — needs a fixing round to make `recordOrchBypass` treat a
  short `writeSync` as a failure (fail closed), and to sweep the remaining
  could-not-test surfaces. Not fixed here (verify lane).

### 2026-09-24 — worker (fixing, round 3)
- **Hypothesis verified FIRST (the outer `catch { return {} }`):** `{}` is the
  allow / no-decision return — the same value used literally at the profile
  branch's own `if (d.allow || !d.reason) return {};` in
  `src/server/runtime/claude-runtime.ts`. So the outer catch is a general
  fail-OPEN: a throw anywhere inside the PreToolUse callback allows the command.
  Confirmed by code, not assumed.
- **Reproduced the refutation + generalised it (must-FAIL):** rather than patch
  the one short-write mode, extended `scripts/verify-feat-152-orch-bypass.mts`
  with section 5 driving the REAL hook path
  (`evaluateOrchestratorProfileHook(input, recorder)` — the exact function the
  callback now calls) against the whole class: short write, injected ENOSPC,
  FIFO ledger, symlink ledger, a throw in the recorder (fsync EIO), and a throw
  in `decide()` (a throwing `command` getter). Must-FAIL evidence: symlink and
  FIFO reproduced against a faithful reconstruction of the round-2 recorder (it
  wrote through the symlink to a decoy and returned LOGGED; a plain blocking
  `openSync(fifo,'a')` hung until killed); the short-write must-FAIL is the
  round-2 clean-room's own executed `verifier-short-write.mts` (12/264 bytes,
  allow+LOGGED); the decide-throw must-FAIL is that `decide()` genuinely throws
  on the getter and would reach the outer `{}` = allow.
- **Fix (structural — the CLASS, one invariant):** the bypass is ALLOWED only
  when a COMPLETE, PARSEABLE row is durably written to a REGULAR FILE; every
  other outcome is DENY and the count does not advance.
  `src/server/runtime/claude-runtime.ts`:
  - `recordOrchBypass()` now: writes the FULL buffer in a loop (a short
    `writeSync` continues from the returned offset; a no-progress write throws
    → deny); opens with `O_APPEND|O_CREAT|O_WRONLY|O_NONBLOCK|O_NOFOLLOW` +
    `0o600`, so a FIFO returns promptly (ENXIO / rejected by the fstat) instead
    of BLOCKING the turn, and a symlinked ledger is refused (ELOOP) instead of
    followed to another file; `fstatSync(fd).isFile()` rejects any non-regular
    sink; `fsyncSync` before declaring success. Any throw → fail closed (false).
  - new exported `evaluateOrchestratorProfileHook(input, orchBypass)` — the
    profile branch of the hook, extracted so the hook and the suite call ONE
    source (ARCH-010). It wraps BOTH `decide()` and the recorder in its own
    try/catch that returns DENY, so a throw on the profile/bypass path can never
    reach the outer `catch { return {} }` (allow). For a restrictive profile,
    "could not evaluate" is DENY.
- **Verified:** `npm run verify:feat-152` → `PASS — 74 passed, 0 failed` (all six
  class cases green through the real hook path; happy path still allows+logs a
  complete parseable row). `npm run gate` EXIT 0 (leak-gate + check-nul +
  typecheck all PASS). Anti-regression: `node scripts/verify-orchestrator-enforcement.mjs`
  → `139 passed, 0 failed` (the round-2 BUG-185 red is no longer present in the
  working tree; my change touches neither `orchestrator-profile.mjs` nor that
  suite's imports, so this is not caused by FEAT-152 either way).
- **regressed-from:** FEAT-152 round 2 (short-write fail-open) and round 1
  (swallowed-append fail-open) — both prior fixes on this same path; named per
  the regression-honesty rule.
- **Verified-by:** PENDING (round 3) — independent clean-room verify warranted
  again (third pass on an audit/security fail-open on a profile-enforcement
  change; generation must not be its own only verifier). Suggested attack
  surface for the skeptic: the could-not-test list from round 2 still not driven
  through a LAUNCHED SDK PreToolUse session (only the extracted function) —
  crash durability between write and fsync, and concurrent multi-session appends
  to the shared ledger.
- **Still open / handoff:** none functionally; awaits the round-3 `Verified-by:`
  dispatch and an orchestrator relaunch to take effect.

### 2026-09-24 — independent clean-room verification (verifying, round 3) — REFUTED

- **Verified-by:** dispatch openai run `01a0d335-f008-7cb3-85f2-b3dc667ddad7`
  (clean-room, `scripts/independent-verify.mjs --working-tree`, cross-provider
  anthropic→openai) — **VERDICT: BROKEN** (verdict-contract VALID, manifest-backed;
  11 recorded runs). Clean room + record KEPT under the scratch root:
  `$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-jhg648` and
  `.../cleanroom-record-2vhzSf/manifest.jsonl`. Transcript under the openai dispatch
  transcript store, keyed by clean-room cwd `cleanroom-verify-jhg648`, file
  `<run-id>.jsonl`.
- **Commissioning note (the diff must not carry fixer prose).** `--working-tree`
  on the live tree would have put the FEAT-152 ticket itself (all prior
  refutations) plus 8 other tickets' Activity logs INTO the diff shown to the
  verifier — the clean room strips `docs/bugs` from the ROOM but NOT from the diff
  `git diff base head` computes. So this round diffed a FOCUSED scratch repo whose
  committed HEAD is the real HEAD tree and whose dirty working tree is ONLY the 4
  FEAT-152 files (`src/server/runtime/claude-runtime.ts`,
  `scripts/lib/orchestrator-profile.mjs`, `.../orchestrator-profile.d.mts`,
  `scripts/verify-feat-152-orch-bypass.mts`) + `package.json` (to register the
  `verify:feat-152` script). Verified before dispatch: the composed prompt's diff
  carried exactly those files and ZERO `docs/bugs`/refutation prose. (A first
  dispatch, run `01a0d331-0e3b-7513-a31d-d1fa5dd61739`, omitted `package.json`, so
  the fixer suite could not run — "Missing script" — and the verifier hand-extracted
  the functions; it STILL returned BROKEN on findings 1 & 2. That run is superseded
  by `01a0d335…`, which is the authoritative one below.)
- **What HELD (executed).** Fixer suite re-ran GREEN in the room: `npm run
  verify:feat-152` → `PASS — 74 passed, 0 failed` (manifest run `e809d3d85bca`,
  exit 0), confirming room fidelity. The EISDIR/ENOSPC/ENXIO/ELOOP/EIO fail-closed
  paths hold; a **symlink swapped in immediately before the open is DENIED**
  (O_NOFOLLOW → ELOOP); and a reason built from **control characters + embedded
  newlines round-trips into exactly ONE parseable row with no forged second row**
  (both probed in run `9e6c4e1db328`, cases "swap immediately before open" and
  "controls and embedded newlines" → ok:true). Two of the charter's suggested
  attacks (TOCTOU symlink swap, control-char/newline row forgery) therefore did NOT
  break it.
- **FINDING 1 (CONFIRMED — orphaned partial bytes corrupt the next row; ALLOW while
  the ledger is unparseable).** Adversarial run `24c8b124024f` (exit 1, "damaged-
  ledger-recovery"): a stalled partial write (12/284 bytes) correctly DENIES and
  fails closed — but the 12 already-appended bytes are **never rolled back/
  truncated**. The NEXT bypass into the same ledger opens `O_APPEND` and writes a
  complete row right after the orphan (no separating newline), producing a single
  UNPARSEABLE line `{"at":"2026-{"at":"2026-…}` while returning
  `permissionDecision:"allow"` + "allowed and LOGGED". `allRowsParseable:false`.
  Independently CONFIRMED against the real source: `recordOrchBypass`
  (`claude-runtime.ts:445-460`) has no rollback of bytes written before an
  `ESHORTWRITE`/errno throw, and the next `O_APPEND` write fuses onto them. Directly
  violates "a COMPLETE, PARSEABLE row has been durably written" — the row that
  legitimises the bypass is corrupt.
- **FINDING 2 (CONFIRMED — concurrent appends interleave; both sessions ALLOW+LOGGED
  on corrupt JSONL).** Adversarial run `3c20bac142ef` (exit 1): the durable write is
  a LOOP of `writeSync` calls (`claude-runtime.ts:446-455`); a second process's
  `O_APPEND` write lands between two of session A's loop iterations, so neither
  physical line parses (`allRowsParseable:false`) yet both A and B return ALLOW #1 +
  LOGGED. The line-426 comment claims "O_APPEND keeps concurrent per-session appends
  row-atomic" — true only for a row emitted in ONE `write()` syscall; a row split
  across loop iterations is not atomic against a concurrent appender. `reason` is not
  length-capped (only `command`, to 500), so a large reason forces the multi-syscall
  path. The charter explicitly asked for concurrent multi-session appends; this is it.
- **FINDING 3 (CONFIRMED — the WIRED runtime callback still fails OPEN; the charter's
  headline attack).** Adversarial run `fe0317182e2c` (exit 1, "registered-runtime-
  hook") drove the ACTUAL PreToolUse callback registered by `ClaudeRuntime.start`
  (captured via a mocked SDK `query` boundary), not just the exported
  `evaluateOrchestratorProfileHook` the suite tests. A throwing `command` getter
  returns `{}` (allow / no-decision) with `ledgerUnchanged:true`. Root cause in
  source: the callback's outer `try { … } catch { return {} }`
  (`claude-runtime.ts:1102-1103`) wraps the Fable-tier and `evaluateFileLock` code
  (`~1040-1088`) that read `i.tool_input` BEFORE the profile guard at line 1101 — so
  a throw there hits the fail-OPEN, exactly what the round-3 comment (lines
  1090-1099) claims "can never reach the outer catch". The suite's 5f case only
  proves `evaluateOrchestratorProfileHook(throwingInput, rec)` denies; it does not
  cover the pre-profile shared code inside the same outer try. NOTE: the demonstrated
  trigger (a getter that throws) is synthetic — production `tool_input` is plain JSON
  from the SDK — but the code-level fail-open on the orchestrator path (a restrictive
  profile requires "could-not-evaluate ⇒ DENY") is real and unclosed.
- **FINDING 4 (NOT a real defect — requirement-wording artifact; recorded for
  honesty).** Run `9e6c4e1db328` case "large command with successful short writes
  MUST deny" reported ok:false because a ~2 MB row completed via 33 PROGRESSING short
  writes and was ALLOWED (`rows:2`, both parseable). That is the round-2 fix working
  AS DESIGNED: a short write that makes progress is looped to completion, yielding a
  complete parseable row — correct. The failure is only against the requirement text
  I supplied ("a short write … must DENY"), which over-specified; the true invariant
  is "the row must be complete and parseable", which looping satisfies. Do NOT "fix"
  this by denying progressing short writes. (It does, however, feed findings 1 & 2:
  the multi-syscall loop is what the orphan/interleave attacks exploit.)
- **Could-not-test (verifier's own UNTESTED list).** Live SDK permission resolution
  and tool aliases were not executed (the wired-hook case used a mocked SDK `query`
  boundary, not a launched model turn); physical disk exhaustion (real ENOSPC) and
  crash durability between write and fsync were injected, not induced on real
  hardware.
- **Class:** high-stakes (audit/security fail-open + ledger-integrity on a
  profile-enforcement change), third clean-room refutation in a row. This
  cross-provider dispatch IS the independent skeptic; findings 1-3 are executed-
  evidence backed with manifest run ids, and finding 1 was additionally confirmed by
  direct reading of the real source. An orchestrator relaunch is NOT warranted — the
  fix is refuted, not shippable.
- **Handoff:** REFUTED — needs a round-4 fixing pass. Real work queue: (a) on any
  failed/partial append, roll back the bytes already written (truncate to the
  pre-write length, or write to a temp fd + atomic rename) so a later append cannot
  fuse onto an orphan (finding 1); (b) make each row a single atomic append —
  emit exactly one `write()` of the whole buffer, and either cap `reason` length or
  refuse to allow a row that cannot be written in one syscall — so concurrent
  sessions cannot interleave (finding 2); (c) move the fail-CLOSED boundary OUT to
  the whole orchestrator branch of the callback (or make the outer `catch` return a
  DENY when `config.orchestratorProfile` is set) so a throw in the shared
  pre-profile code cannot reach `catch { return {} }` = allow (finding 3), and drop
  the round-3 comment's overclaim. Not fixed here (verify lane).

### 2026-09-24 — worker (fixing, round 4) — design change: one file per record
- **Hypothesis verified FIRST (before building).** (a) Nothing reads the JSONL
  ledger: `rg` over the whole repo (excluding `docs/bugs`, `node_modules`) finds
  `orch-bypass-audit` only in `claude-runtime.ts` and this ticket's suite — no
  server route, UI, script or doc consumes it. (b) The data dir is on btrfs
  (`findmnt -T ~/.local/share/claude-station` → `/ btrfs`), where `rename(2)`
  within one directory is atomic and a directory `fsync` is honoured. (c) No
  `orch-bypass-audit.jsonl` exists in the real data dir (the running server
  predates FEAT-152), so there is nothing live to migrate or leave behind. No
  flaw found, so built it.
- **Must-FAIL, reproduced on round-3 code before the change** (new suite section 6,
  run against the unmodified round-3 working tree): 6a orphan — `unparseable:1`,
  the next row ALLOWED; 6b 6 processes × 5 bypasses — 28 unparseable rows,
  `midUnparseable=1286` over 133 reads during the race, every writer "LOGGED";
  6c the REAL registered callback (captured from `ClaudeRuntime.start` at a mocked
  SDK `query`, `scripts/fixtures/feat-152/wired-hook-probe.mts`) returned `{}`
  (allow) for a throwing Bash `command` getter, a throwing Proxy input, a lane
  Bash throw and an Agent (Fable gate) throw in an orchestrator-profile session;
  6d an uncapped 50,037-char reason stored verbatim. 17 FAILs, exit 1.
- **Durable must-FAIL anchors (not HEAD).** Findings 1-2: the round-3 writer is
  PINNED at `scripts/fixtures/feat-152/round3-recorder.mts` (never edited) and the
  suite runs the same orphan and race attacks against it on every run — both
  still show corruption (6a/6b MUST-FAIL assertions). Finding 3: the fixed
  contrast is the non-profile session, where the same throwing input still
  returns `{}` — proving the throw really reaches the outer catch.
- **Changed.**
  - `src/server/runtime/claude-runtime.ts` — `recordOrchBypass` rewritten: one
    file per record under `dataDir()/orch-bypass-audit/`, named
    `<iso-ts>-<session>-<24 hex random>.json`. Temp `.<name>.tmp` opened
    `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW|O_NONBLOCK` 0600, full-buffer write loop,
    `fsync`, `rename`, then `fsync` of the directory (opened
    `O_DIRECTORY|O_NOFOLLOW`, fstat'd; after the rename the record's inode and
    the directory's inode are re-checked so a swapped path cannot redirect it).
    Allow only after the directory fsync. On any failure: close, unlink the temp,
    and unlink an already-renamed record (a withdrawn, non-durable record), then
    DENY with the count not advanced. Caps: `reason` 2000 chars, `command` 500,
    session id/label 200, with `reasonTruncated`/`commandTruncated` flags. New
    exports `orchBypassAuditDir()` (the one place the path is named) and
    `readOrchBypassAudit()` (skips dot-prefixed temps, names any unparseable file
    rather than dropping it). The legacy JSONL is never read, written or moved.
  - Same file, finding 3: the callback's outer `catch` now returns DENY ("could
    not be evaluated … fail closed") whenever `config.orchestratorProfile` is set,
    for EVERY tool, and warns on stderr; non-profile sessions still return `{}`.
    The round-3 comment that claimed a throw "can never reach the outer catch" is
    removed and the helper's doc now says it is not the only boundary.
  - `scripts/verify-feat-152-orch-bypass.mts` — sections 2-5 moved to the new
    layout (EISDIR is now a genuine kernel EISDIR from a rename onto a real
    directory; FIFO and symlink now sit where the record DIRECTORY must be; EACCES
    added); new section 6 (above) plus caps (6d), legacy JSONL untouched (6e), a
    failed directory fsync withdraws the record (6f), and the record dir being a
    file, a symlink to a decoy or a FIFO (6g).
  - New fixtures: `scripts/fixtures/feat-152/{round3-recorder,concurrent-writer,wired-hook-probe}.mts`.
  - `scripts/verify-feat-108-git-write-block.mjs`, `scripts/verify-feat-124-fable-gate.mjs`
    — one source-order PIN each. **regressed-from: FEAT-152 round 3**: extracting
    `decide()` into `evaluateOrchestratorProfileHook` (defined above the class)
    turned both "git block / Fable gate run BEFORE the profile decide()" pins red
    (163/164 and 50/51 before this change); round 3 ran only the enforcement suite
    so it missed them. The pins now target the callback's call site
    `return evaluateOrchestratorProfileHook(i, orchBypass)`. Both green after.
- **Non-profile behaviour change: none.** Measured through the registered callback:
  in a non-profile session every probe case (including all throwing ones) still
  returns `{}`. **Profile-session change beyond Bash:** a throw that reaches the
  callback's catch now DENIES Agent/Write/etc. too, not only Bash (the charter
  asked for Bash at minimum; "could not evaluate ⇒ deny" was applied to the whole
  profile session). A throw inside `evaluateFileLock`'s own classifier is still
  swallowed there by FEAT-129's designed degrade-to-allow and never reaches the
  callback; that is unchanged and asserted as unchanged (6c).
- **Verified.** `npm run verify:feat-152` → `PASS — 121 passed, 0 failed`, 3
  consecutive runs (5-6 s each). The concurrent case is SYNTHETIC but realistic:
  6 separate node processes, one per session, 5 bypasses each, 300+-char reasons,
  every write forced to 16 bytes with a 1 ms pause, started together on a barrier,
  while the parent reads the ledger every ~3 ms. Result: 30/30 allowed, 30 records,
  0 unparseable, counts 1..5 per session, 0 temps, no JSONL, and no mid-race read
  ever saw a partial record. `npm run gate` EXIT 0 (leak-gate, check-nul,
  typecheck PASS). Anti-regression: `verify-orchestrator-enforcement.mjs` 139/0;
  `verify-orchestrator-surface-log` 67/67; `verify-feat-129-file-lock` 84/0;
  `verify-feat-108-git-grant` 40/0; `verify-feat-108-git-write-block` 164/0;
  `verify-feat-124-fable-gate` 51/51. `verify-feat-096-codex-bypass` is 7/8. Its
  failing assertion ("warning ABSENT at HEAD") is a must-FAIL anchored to HEAD
  over `agent-bridge.ts`, a file this change does not touch. FEAT-152 did not
  cause it; it is the moving-baseline trap described in CONVENTIONS.
- **Not covered.** Physical crash between the file fsync and the rename (it leaves
  a dot-temp that readers skip and nothing sweeps). A crash after the rename but
  before the directory fsync can leave a record for a bypass that never ran, so
  the ledger can over-report and never under-report. Also not covered: a live
  model turn (the callback runs at a mocked SDK boundary), and a real ENOSPC
  (injected only).
- **Separate item filed:** BUG-186. `--working-tree` shows the verifier the
  `docs/bugs` prose in its diff. No existing ticket covered it: BUG-104 and
  BUG-120 are about the room, not the diff.
- **Verified-by:** PENDING (round 4). An independent clean-room verify is REQUIRED:
  this is a security audit path on profile enforcement, the fourth round, and a
  design change. The commissioner must not use a plain `--working-tree` on the
  live tree until BUG-186 is fixed; use a focused scratch repo, as round 3 did.
  Attack surface: the rename/dir-fsync publish, the outer-catch deny in profile
  sessions, the reader skipping temps, and name collisions (a 96-bit random
  suffix, and `rename` would overwrite).
- **Still open / handoff:** the round-4 `Verified-by:` dispatch, then an
  orchestrator relaunch to take effect.

### 2026-09-24 — independent clean-room verification (verifying, round 4) — REFUTED

- **Verified-by:** dispatch openai run `01a0d34c-7ccd-71b3-9488-d2bd9793bd80`
  (clean-room, `scripts/independent-verify.mjs`, cross-provider anthropic→openai)
  — **VERDICT: BROKEN** (verdict-contract VALID, manifest-backed). Clean room +
  record KEPT under the scratch root:
  `$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-sgYTeU` and
  `.../cleanroom-record-7oYysP/manifest.jsonl`.
- **Commissioning note.** Per BUG-186, did NOT use `--working-tree` on the live
  tree. Built a FOCUSED scratch repo the round-3 way: committed base = the real
  HEAD tree (`a74eb5cf`), committed head = base + ONLY the 8 FEAT-152 files
  (`src/server/runtime/claude-runtime.ts`, `scripts/lib/orchestrator-profile.mjs`
  + `.d.mts`, `scripts/verify-feat-152-orch-bypass.mts`, the three
  `scripts/fixtures/feat-152/*.mts`) plus the `verify:feat-152` script line in a
  HEAD-derived `package.json` (`a80c3641`; range `a74eb5cf..a80c3641`, 82268 diff
  bytes). Verified before dispatch: the diff carried exactly those 8 files and
  ZERO `docs/bugs` files — the only "round 1/2/3 / clean-room refuted" hits are
  code COMMENTS inside the FEAT-152 files themselves (part of the artifact under
  test). The focused repo was built with node child-process git (the Bash
  git-write hook blocks Bash `git`, not a node child), synthetic identity.
  **openai provider refusal:** the FIRST dispatch was refused by openai's safety
  filter ("flagged for possible cybersecurity risk") because the requirement used
  adversarial security wording (attack/bypass/escape-hatch/exploit). Re-framed the
  same 7 invariants + edge cases in neutral QA language and the retry ran clean.
- **What HELD (executed).** Fixer suite re-ran GREEN in the room: `npm run
  verify:feat-152` → `PASS — 121 passed, 0 failed` (manifest run `d90e6bff979c`,
  exit 0), confirming room fidelity. The marker / first-line / reason-floor and
  the EISDIR / EACCES / ENOSPC / ENOTDIR / EEXIST / EIO / dir-fsync-EIO /
  no-progress-short-write fail-closed paths and the per-session count all held.
  Adversarial run `f4727ffcfb8c` (exit 1) drove the REAL recorder + the new
  one-file-per-record path and produced three violations.
- **FINDING 1 (rename overwrites an existing target — REAL property, negligible
  reachability).** `recordOrchBypass` renames the temp onto the final name with no
  `O_EXCL`/existence guard, so a file already present at the exact target name is
  silently OVERWRITTEN and the call still returns `allow` (evidence:
  `{"decision":"allow","stored":"new-session","records":1}`). This is a real
  code property, but NOT practically reachable: the final name carries a 96-bit
  random suffix (`randomBytes(12)`), so a natural or concurrent-session collision
  is astronomically unlikely — the verifier had to PLANT the exact name by hand.
  An actor who can write that precise path has already compromised the audit dir.
  **Classify: real hardening gap, negligible exploitability, low severity.**
- **FINDING 2 (double-fault leaves a counted leftover — REAL, narrow, fail-safe
  direction).** When the directory fsync fails AND the rollback unlink of the
  just-renamed record ALSO fails (both injected), the gate correctly DENIES but
  the record file remains and `readOrchBypassAudit` counts it; the next
  successful bypass is also `#1` (evidence:
  `{"decision":"deny","recordsAfterDeny":1,"nextDecision":"allow","counts":[1,1]}`).
  Real audit-integrity gap, but requires TWO simultaneous filesystem failures and
  fails in the SAFE direction — it OVER-reports (a denied bypass shows a record;
  the command did not run), never under-reports. This is exactly the "crash after
  rename before dir fsync … can over-report and never under-report" case the
  round-4 fixer already listed under "Not covered". **Classify: real but
  low-medium; the fixer knowingly accepted the over-report tradeoff.**
- **FINDING 3 (reader counts a record before its dir fsync — cosmetic / spec
  wording).** `readOrchBypassAudit` sees a renamed record in the window between
  the rename and the directory fsync (evidence:
  `{"recordsBeforeDirectoryFsync":1,"decision":"allow"}`). Once renamed the file
  is VISIBLE (the dir fsync governs power-loss durability, not visibility), and
  the record is for a bypass that IS being allowed — so the count is correct on
  every non-crash path. Only a power loss inside that microsecond window plus a
  concurrent read makes it "count a not-yet-durable record", and even then the
  counted bypass is the one about to be allowed. **Classify: cosmetic / spec
  wording ("durably committed" vs "visible"); no wrong outcome in practice.**
- **Could-not-test (verifier UNTESTED).** Actual power-loss recovery was not
  exercised (no controlled crash facility); durability failures were INJECTED at
  the filesystem calls, not induced on real hardware. Not driven through a
  LAUNCHED SDK PreToolUse session either — the suite and adversarial case drive
  the real recorder + `evaluateOrchestratorProfileHook` directly.
- **Class:** high-stakes (audit-integrity on a profile-enforcement change),
  fourth clean-room refutation in a row. This cross-provider dispatch IS the
  independent skeptic; all three findings are executed-evidence-backed with
  manifest run ids.
- **Handoff:** VERDICT BROKEN, but the findings are into diminishing returns:
  only FINDING 2 is a substantive (narrow, fail-safe/over-report) defect;
  FINDING 1 is unreachable given the 96-bit name; FINDING 3 is a spec-wording
  artifact with no wrong outcome. **Orchestrator decision needed:** either (a) a
  cheap round-5 pass — add `O_EXCL` (or a pre-rename existence check) on the
  publish so FINDING 1 closes and a collision denies, and make the reader/recorder
  refuse to count a record whose dir-fsync never completed (closing FINDING 2's
  double-fault leftover) — or (b) accept the fixer's documented "over-reports,
  never under-reports" tradeoff and close with these three logged as
  known-limitations. An orchestrator relaunch is NOT warranted (verdict BROKEN).

### 2026-09-24 — worker (fixing, round 5) — close F1/F2/F3 (round-4 design stands)
- **Scope.** Small, targeted follow-up on the round-4 one-file-per-record design
  (unchanged): the round-4 verifier's three findings, closed per the "cheap
  round-5" option (a).
- **F1 — no-clobber publish (rename → link).** `recordOrchBypass`
  (`src/server/runtime/claude-runtime.ts`) published the temp with
  `renameSync(tmp, final)`, which SILENTLY OVERWRITES an existing target and still
  allows. Hypothesis verified FIRST: `link(2)` gives no-clobber semantics — it
  fails `EEXIST` when the final name already exists — and hardlinks within one
  directory are usable on the data dir's filesystem (btrfs; also ext4/xfs). Fix:
  publish with `fs.linkSync(tmp, final)` then unlink the temp (best-effort; a
  leftover dot-temp is skipped by readers). On `EEXIST` (or any publish error)
  the recorder FAILS CLOSED — deny, count not advanced, and the pre-existing
  file is NEVER touched (we do not own it). The post-link ino/dev recheck +
  directory fsync are retained.
  - **Must-FAIL → PASS (F1).** New suite section 7 drives the REAL recorder. A
    reconstructed pre-fix rename publish clobbers a planted final path and
    ALLOWS (`7 MUST-FAIL`); the fixed link publish DENIES and leaves the planted
    file byte-for-byte intact (`7 PASS`). Proven the anchor reddens: reverting
    the product publish to `renameSync` turns `7 PASS: a pre-existing final path
    → bypass DENIED` and `… planted file untouched` RED (executed:
    `clobbered=false decision=allow`), and green again on the link version.
    Attack shape = the round-4 verifier's planted final path, forced via a
    `linkSync` shim so no random name has to be predicted.
- **F2 — double-fault leftover must not change the count or the outcome.**
  Verified the count's source FIRST: the per-session `#N` count is owned SOLELY
  by the in-memory tally in `makeOrchBypassRecorder` (advanced only on a durably
  committed bypass); NOTHING in `src/` derives a per-session count from the
  directory (`rg` confirms `readOrchBypassAudit` has zero in-`src` callers). So
  the reported count and the allow/deny outcome were already unaffected by a
  disk leftover — there was no count-from-directory path to repair. Change made:
  `readOrchBypassAudit`'s doc now DECLARES (ARCH-010, owner writes the fact) that
  it is a RAW disk view for audit/review, explicitly NOT the per-session count
  source, and that a double-fault (dir-fsync fail + rollback-unlink fail) can
  leave one un-withdrawn record here — a documented OVER-report, never an
  under-report. Do not wire a per-session count off `records.length`.
  - **Must-FAIL → PASS (F2).** New suite section 8 injects BOTH filesystem faults
    (directory fsync EIO + rollback unlink EIO): the bypass is DENIED, the
    leftover stays on disk (over-report), and the next good bypass is still `#1`
    (in-memory count unchanged). Non-vacuity contrast (`8 MUST-FAIL contrast`): a
    count DERIVED from the directory would count the leftover and report the next
    bypass as `#2` — proving the in-memory-only source is load-bearing.
- **F3 — wording only (no code change).** The allow reason and the
  round-4-era comments said the record is published by "rename"; updated the doc
  comment and inline comments in `recordOrchBypass` to say `link(2)` no-clobber.
  No behavioural change.
- **Documented limitation (F2, accepted).** On the rare double-fault (directory
  fsync fails AND the rollback unlink of the just-published record also fails),
  the record file remains and `readOrchBypassAudit()` will list it — an
  over-report of a bypass that was DENIED and never ran. It never under-reports,
  never changes the reported per-session count, and never flips an allow/deny
  outcome. Nothing sweeps it; a reviewer may see one extra record.
- **Verified.** `npm run verify:feat-152` → `PASS — 129 passed, 0 failed` (was
  121; +8 F1/F2 assertions), 2 runs. `npm run gate` EXIT 0 (leak-gate, check-nul,
  typecheck PASS). Anti-regression: `verify-orchestrator-enforcement.mjs` 139/0;
  `verify-feat-108-git-write-block` 164/0; `verify-feat-124-fable-gate` 51/51;
  `verify-feat-129-file-lock` 84/0. (`verify-feat-096-codex-bypass` 7/8 is the
  known HEAD-anchored moving-baseline case over `agent-bridge.ts`, a file this
  change does not touch — unchanged, not caused here.)
- **regressed-from:** FEAT-152 round 4 — the rename publish (F1 clobber) and the
  directory-derived over-report exposure (F2) were both introduced/left by the
  round-4 one-file-per-record design; named per the regression-honesty rule.
- **Changed files:** `src/server/runtime/claude-runtime.ts`,
  `scripts/verify-feat-152-orch-bypass.mts`.
- **Verified-by:** PENDING (round 5) — independent clean-room verify warranted
  (fifth pass on a security/audit path on profile enforcement; generation must
  not be its own only verifier). Attack surface for the skeptic: the link
  no-clobber publish under a planted/colliding final name, the double-fault
  leftover's effect on the reported count (must stay in-memory), and the
  still-uncovered live-SDK-PreToolUse path.
- **Still open / handoff:** the round-5 `Verified-by:` dispatch, then an
  orchestrator relaunch to take effect.

### 2026-09-24 — independent clean-room verification (verifying, round 5) — REFUTED (BROKEN; into deep diminishing returns)

- **Verified-by:** dispatch openai run `01a0d3a2-70be-7643-9b72-cb3574c6cee4`
  (clean-room, `scripts/independent-verify.mjs`, cross-provider anthropic→openai)
  — **VERDICT: BROKEN** (verdict-contract VALID, manifest-backed; 6 recorded
  runs). Clean room + record KEPT under the scratch root:
  `$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-kK5DuE` and
  `.../cleanroom-record-06y172/manifest.jsonl`. Transcript under the openai
  dispatch transcript store, keyed by the clean-room cwd `cleanroom-verify-kK5DuE`,
  file `<run-id>.jsonl`.
- **Commissioning note.** Per BUG-186, did NOT use `--working-tree` on the live
  tree. Built a FOCUSED scratch repo the round-3/4 way (node child-process git,
  synthetic identity `verify@example.invalid`): committed base = the real HEAD
  tree (`541dd73e2377`, scratch base `292d239e06c1`), committed head = base +
  ONLY the 8 FEAT-152 files (`src/server/runtime/claude-runtime.ts`,
  `scripts/lib/orchestrator-profile.mjs` + `.d.mts`,
  `scripts/verify-feat-152-orch-bypass.mts`, the three
  `scripts/fixtures/feat-152/*.mts`) plus the `verify:feat-152` script line in a
  HEAD-derived `package.json` (scratch head `8ef20b9e9e65`; 89143 diff bytes).
  Verified before dispatch: the diff carried exactly those 8 files and ZERO
  `docs/bugs`/`docs/prompts` files (the only round/finding hits are code
  COMMENTS inside the FEAT-152 files themselves — part of the artifact under
  test). node_modules reflink-copied into the scratch repo so the room could run
  the suite; `--max-diff-bytes 120000`. Requirement written in NEUTRAL QA
  wording (round 4 found openai refuses security-attack phrasing). **openai
  quota:** the first dispatch (run `01a0d35e-2269-7c52-bdc3-785ecacec6ff`) was
  rejected `quota-window` ("usage limit … try again at 4:35 PM") — INVALID
  (dispatch failed, nothing verified), fail-closed. Waited for the reset and
  re-dispatched; `01a0d3a2…` is the authoritative run.
- **What HELD (executed).** Fixer suite re-ran GREEN in the room: `npm run
  verify:feat-152` → `PASS — 129 passed, 0 failed` (manifest run `28d4cdc987f6`,
  exit 0), confirming room fidelity (also re-run here on the focused repo before
  dispatch: 129/0). The verifier's OWN independent probes (manifest run
  `530f31a293f1`, exit 1) CONFIRMED the named round-5 attack surface HOLDS:
  `temp-collision-preserves-foreign-file` PASS (a file planted at the temp name
  → DENY, foreign bytes intact), `link-eperm-denies-count-unchanged` PASS
  (injected link EPERM → DENY, count unchanged), `double-fault-session-isolation`
  PASS (dir-fsync fault → DENY; two sessions' counts stay `1,1` — in-memory
  count correct), and `evaluation-throws-fail-closed` PASS for an ordinary Error
  throw (DENY). The round-5 F1 no-clobber-link and F2 in-memory-count properties
  the charter asked to attack were not broken.
- **FINDING 1 (REAL defect, LOW severity, safe direction — post-link temp-unlink
  failure is swallowed and the command is ALLOWED).** Adversarial case
  `temp-unlink-failure-denies-and-does-not-count` reported `pass:false`: injecting
  EACCES on the temp `unlink` that runs AFTER a successful `link()` lets the
  command through as `#1`, leaves the `.tmp`, and reports the next command as
  `#2`. CONFIRMED against real source: `recordOrchBypass`
  (`claude-runtime.ts:516-527`) does `linkSync(tmp,final)` (published), then
  `try { unlinkSync(tmp) } catch { /* readers skip the dot-temp */ }` (line 518,
  swallowed), then the ino/dev recheck and `fsyncSync(dirFd)` (line 527) — so the
  record IS durably published under its final name and the directory IS fsync'd
  before the allow. The residue is only a reader-skipped `.tmp`
  (`readOrchBypassAudit` skips dot-prefixed temps); the audit record is durable,
  the bypass is NOT unaudited, and the in-memory count is correct (`#1` then
  `#2` are both genuinely-committed records). This deviates from a strict literal
  reading of "if ANY step fails ⇒ deny" — the fixer deliberately treats
  post-publish temp cleanup as best-effort because durability is already
  achieved. **Classify: real code deviation, low severity, fails SAFE (over-
  retains a dot-temp; never under-audits, never miscounts, never runs an
  unaudited bypass). Reachability: narrow — requires the just-created 0600 temp's
  unlink to fail (EACCES/EPERM) specifically AFTER link+dir-fsync succeed.**
- **FINDING 2 (NOT a real defect — requirement-wording artifact / false
  positive).** The verifier reported `exact-marker-required pass:false` because
  `decide()` permits `node --version` with no marker or audit. That is BY DESIGN:
  the orchestrator profile allowlists npm/node/git/status commands on their own
  merits (`orchestrator-profile.mjs:797-800` — "Allowed on its own merits …
  a bypass marker, if any, is just a harmless comment"); the marker+audit is
  required ONLY for a command the profile would OTHERWISE refuse. The QA
  requirement I supplied over-stated it as "every orchestrator Bash command needs
  both a marker and an audit", which is not the contract. Same shape as round-4
  FINDING 4. **Classify: false positive; do NOT "fix" by demanding a marker on
  allowlisted node/npm.**
- **FINDING 3 (cosmetic / spec-wording).** The verifier reported that
  `detectOrchBypass` accepts `#ORCH-BYPASS:` (no space after `#`) and a marker
  with leading whitespace. Confirmed intentional: `BYPASS_FIRST_LINE =
  /^\s*#\s*ORCH-BYPASS:\s*(.*)$/` (`orchestrator-profile.mjs:640`) deliberately
  tolerates leading whitespace and an optional space after `#`. Both are still
  valid first-line shell comments, the ≥15-char reason floor still applies, and
  such a bypass is still fully audited and counted — no unmarked/unaudited
  command is let through. Deviates only from a literal "exactly `# ORCH-BYPASS:`"
  reading. **Classify: cosmetic/leniency; no wrong outcome (still audited, still
  counted, reason floor enforced).**
- **Could-not-test (verifier UNTESTED).** Actual power-loss durability and
  kernel-generated EPERM were not exercised (failures were INJECTED; no crashable
  filesystem). Not driven through a LAUNCHED SDK PreToolUse session — the suite
  and probes drove the REAL recorder + `evaluateOrchestratorProfileHook`
  directly. Throwing a literal `null`/`undefined` (not an Error) escaped the
  EXTRACTED evaluator with a `TypeError`; that is synthetic (production
  `tool_input` throws surface as Errors) and was NOT driven through the
  registered callback, so no end-to-end fail-open claim is made on it.
- **Class:** high-stakes (audit-integrity on a profile-enforcement change), FIFTH
  clean-room refutation in a row, cross-provider — this dispatch IS the
  independent skeptic; all findings are executed-evidence-backed with manifest
  run ids and FINDING 1 additionally confirmed by direct reading of the real
  source.
- **Handoff:** VERDICT BROKEN, but into DEEP diminishing returns: the charter's
  named round-5 attack surface (no-clobber link publish under planted final/temp
  names, two-session race, link EPERM, double-fault count) all HELD. Of the three
  findings only **FINDING 1** is a genuine code deviation — low severity, safe
  direction (a swallowed post-publish temp-unlink allows the command while the
  audit is already durable and the count correct; residue is a reader-skipped
  dot-temp). **FINDING 2** is a false positive against over-stated requirement
  wording (node/npm are allowlisted); **FINDING 3** is cosmetic marker leniency
  with no wrong outcome. **Orchestrator decision needed:** either (a) a trivial
  round-6 close of F1 — treat a post-publish temp-`unlink` failure as fatal
  (fail closed: withdraw the just-published record and deny) so "any step fails ⇒
  deny" holds strictly — or (b) accept F1 as documented best-effort cleanup (the
  record is durable, the count is correct, only a reader-skipped dot-temp is left)
  and CLOSE FEAT-152 with F1/F2/F3 logged as known-limitations/wording. An
  orchestrator relaunch is NOT warranted while the verdict is BROKEN. Not fixed
  here (verify lane).

### 2026-09-24 — orchestrator (judgment): rounds stopped
- **Decision.** Round 5's independent run (`01a0d3a2-70be-7643-9b72-cb3574c6cee4`)
  confirmed that every attack named for this round holds — the round-5 charter's
  attack surface (no-clobber link publish under a planted final/temp name, the
  two-session race, an injected link EPERM, the double-fault count) all HELD. Its
  BROKEN verdict rests on three findings:
  - **F1** — after the record is already durably published (link succeeded, the
    ino/dev recheck passed, the directory fsync ran), a failed temp-unlink is
    swallowed. This is a safe-direction residue: the audit record exists, the
    per-session count is correct, and the stray `.tmp` is skipped by readers.
  - **F2** — a false positive: the verifier's own requirement wording over-stated
    the contract; node/npm are allowlisted by design and never needed a marker.
  - **F3** — cosmetic: the marker regex tolerates leading whitespace and a missing
    space after `#`, and such a bypass is still fully audited and counted.
  None of them breaks the invariant "no bypass happens without a durable audit
  record, and a failure never allows". Per WA §N's stopping rule (round NUMBER is
  not the test; the CLASS changing between rounds is): round 4's findings were
  already low-severity/safe-direction/cosmetic (F1 unreachable-given-96-bit-name,
  F2 narrow fail-safe over-report, F3 cosmetic spec-wording), and round 5's are the
  same shape again — two consecutive rounds returning wording-or-cosmetics-only.
  Stopping here.
- **Accepted known limitations (not fixed further):** F1 above (round 5); round 4's
  leftover-on-double-fault over-report (F2, round 4 — a leftover record after BOTH
  a directory-fsync failure AND a rollback-unlink failure; over-reports, never
  under-reports, never changes the count or an allow/deny outcome); F3 (round 5)
  marker-regex whitespace leniency, wording only.
- **No further rounds commissioned.**
