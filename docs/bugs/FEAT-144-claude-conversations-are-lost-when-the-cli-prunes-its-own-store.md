# FEAT-144 — Claude conversations vanish when the CLI prunes its own store

- **Status:** IN-PROGRESS — round-2 rework verified HOLDS by a SAME-PROVIDER (anthropic) clean-room verify (all four defects re-broken and held, cross-process + busy/stale-reclaim held). NOT flipped to VERIFIED: same-provider decorrelation is reduced; the CROSS-PROVIDER (openai) round on/after 2026-09-19 13:37 is what closes this.
- **Severity:** high
- **Area:** server / transcripts
- **Reported:** 2026-09-16 by orchestrator (dispatch)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
Open a Claude session in Orchard more than ~30 days after its last activity and
the whole conversation is gone — the sidebar row and the transcript both empty,
only the cost roll-ups survive. Orchard never kept its own copy of a Claude
conversation; it re-read the Claude CLI's `~/.claude/projects/<enc>/<id>.jsonl`
live on every request, and the CLI deletes those files by age
(`cleanupPeriodDays`, ~30 days default). When the CLI prunes, the record is
permanently unrecoverable.

## Repro
1. Run a Claude session through Orchard (its conversation lives only in the CLI
   store — `claude-runtime.ts` sets `persistedTranscript:true`, so the
   FEAT-037 `TranscriptRecorder` is never constructed for it).
2. Let the CLI's age pruner remove that session's jsonl (or simulate it by
   removing the file).
3. Open the session in Orchard → transcript route 404s, session vanishes.

## Expected
Orchard keeps its own durable copy so a Claude conversation stays readable after
the CLI prunes its store, without regressing today's behaviour while the CLI
file still exists, and without duplicating or corrupting entries.

## Context pack
- Files/functions in play:
  - `src/server/orchard-transcripts.ts` — NEW `mirrorClaudeStore(encodedDir, sessionId)` + `CLAUDE_MIRROR_PROVIDER='anthropic'`; the existing `resolveOrchardSessionFile` / `listOrchardSessions` pick the mirror up generically.
  - `src/server/agent-bridge.ts` `case 'result'` — turn-end mirror hook (gated `persistedTranscript===true`).
  - `src/server/index.ts` transcript read route (~L1771) — opportunistic mirror-on-read + unchanged Claude-first / Orchard-fallback precedence.
- Related tickets: FEAT-037 P2b (Orchard-owned transcripts for `persistedTranscript:false` engines; the recorder this ticket deliberately did NOT reuse), FEAT-078 (native-codex backfill on the same read path).
- Repro test: `node scripts/verify-feat-144-claude-mirror.mjs` (18 checks).
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-16 — fixer (worker, Opus 4.8)

- **Understood:** For Claude sessions Orchard stored nothing of its own; the UI
  re-read the CLI store live, and the CLI prunes by age → permanent loss. The
  read/list precedence at `index.ts:1771` and `index.ts:338` already prefers the
  live Claude store and falls back to the Orchard store, de-duplicated by
  `sessionId`. So the missing half was purely a durable WRITE, not any reader.

- **Design decision — mirror the CLI's own jsonl (chosen), not the FEAT-037
  recorder (rejected).** The charter's hypothesis was to reuse `TranscriptRecorder`
  for Claude. I verified that is the wrong tool and pivoted (the charter granted
  the latitude and named this exact stop-condition):
  - The recorder writes a FILTERED, re-synthesised shape — main-thread renderable
    `user`/`assistant` text only, dropping `tool_use`/`tool_result`/`thinking`
    that the CLI store carries. As a post-prune fallback it would show a degraded
    transcript, diverging from what the user had. It also cannot capture turns
    from BEFORE it was enabled.
  - `mirrorClaudeStore` instead copies the CLI's own append-only jsonl BYTE-FOR-BYTE
    into `dataDir()/transcripts/anthropic/<enc>/<id>.jsonl` — the exact layout the
    existing reader understands, so zero new reader and the fallback is identical
    to the original. It captures the FULL history the CLI already wrote, including
    turns predating this feature.
  - **Idempotency (the main risk) is structural, not guarded:** the mirror is
    always a strict complete-line PREFIX of the source, so a sync appends only the
    bytes past the mirror's end, up to the last COMPLETE line (a half-written
    trailing line is deferred). Re-open / resume / restart therefore cannot
    double-append — a repeat sync with nothing new is a no-op. A divergent in-place
    prefix rewrite (compaction) is detected via a join-window compare and triggers
    a full atomic re-snapshot rather than interleaving; a source SHORTER than the
    mirror, or a pruned/absent source, leaves the mirror untouched (the record we
    exist to protect).
  - **Provider dir `'anthropic'`** (the canonical Claude key the resume-provider
    resolver and sidebar badge already speak), so a post-prune survivor routes and
    badges as the Claude session it is.
  - **Precedence unchanged:** Claude store authoritative while it exists (a
    source-only entry shows through), mirror is the FALLBACK once the CLI file is
    gone — never a merge, so double-writing cannot corrupt the read.
  - **One owner of "where is it durably stored" (ARCH-010):** `mirrorClaudeStore`
    declares it; no reader re-derives it.
  - **Two write triggers, one function:** the turn-end hook (live common case) and
    an opportunistic mirror-on-read (captures pre-existing sessions on first view,
    and the final turn after a server restart the turn-end hook missed).
  - **Disk growth:** the mirror duplicates Claude conversation bytes under
    `dataDir/transcripts/anthropic`, unbounded and un-swept BY DESIGN — surviving
    the CLI's age-prune is the whole point, and this matches the existing Codex
    transcript store's policy. Plain visible files; no age pruner reintroduced.
  - **Honest limits:** only bytes the CLI already flushed are captured (a turn lost
    to a server crash before the CLI wrote it is not recoverable); and the mirror
    is readable HISTORY, not CLI-resumability — resume needs the CLI's own store,
    which is exactly what a prune removed. A post-prune resume would fail with the
    CLI's honest error, which is strictly better than the session not existing.

- **Changed:**
  - `src/server/orchard-transcripts.ts` — added `mirrorClaudeStore`, `CLAUDE_MIRROR_PROVIDER`, `MirrorResult`/`MirrorStatus`, and the `readRange`/`lastCompleteLineEnd`/`atomicCopyPrefix` helpers.
  - `src/server/agent-bridge.ts` — import + turn-end mirror hook in `case 'result'` (gated `persistedTranscript===true` && `sdkSessionId`, best-effort).
  - `src/server/index.ts` — opportunistic mirror-on-read in the transcript route, precedence preserved.
  - `scripts/verify-feat-144-claude-mirror.mjs` — new (18 checks).

- **Verified (fixer's own run — necessary, not sufficient):**
  `node scripts/verify-feat-144-claude-mirror.mjs` → **19 passed, 0 failed**.
  - Part 1 (real `mirrorClaudeStore` + real `session-history`/`transcript` reader
    over a REALISTIC multi-turn jsonl with thinking+text+tool_use+tool_result):
    append-only + idempotent (repeated/hammered syncs → `up-to-date`, no dup,
    byte-identical); truncated read (half-written trailing line → `partial-only`,
    never mirrored; completed → appears exactly once); prefix divergence →
    `recopied` full snapshot, no interleaving; source-shorter → mirror kept;
    pruned source → mirror kept & still reads N messages; EQUAL-SIZE in-place
    rewrite (a same-length compaction — size alone cannot catch it) → caught by
    the join-window compare and recopied; unsafe id refused; resolver tags
    provider `anthropic`.
  - Part 2 (the USER'S real read path — running server `/api/transcript`):
    MUST-FAIL baseline (a pruned, never-mirrored session 404s — today's loss,
    anchored to a constructed no-mirror state, not HEAD); live read renders AND
    mirrors to disk; precedence (source-only entry shows through while the CLI
    file exists); repeated reads keep the mirror a byte-identical prefix; **THE
    PROOF — after the CLI jsonl is removed the SAME route returns 200 and renders
    from the mirror**; post-prune list surfaces the survivor tagged `anthropic`.
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
  - Anti-regression: `scripts/verify-orchard-transcripts.mjs` (codex/FEAT-037
    recorder path, shares the modified read route) fails at codex session
    STARTUP — but it fails IDENTICALLY on a pristine HEAD export
    (`P2B_SERVER_ROOT` = `git archive HEAD`), so it is a PRE-EXISTING
    environmental breakage of the codex fake fixture (its `-workspace-orchard`
    cwd artifact), NOT a regression from this change. My edits are unreachable at
    codex startup (turn-end hook gated off for `persistedTranscript:false`;
    read-route split is byte-identical when the Claude file is null), and Part 2
    independently exercises the Orchard-store read path through the same route.

- **Verified-by:** PENDING — independent clean-room dispatch. This is a
  session-lifecycle / data-durability change (idempotency + concurrent partial
  reads), so a clean-room verify is warranted per §C; the fixer's suite is not the
  last word. Recommended attack surface: interleave `mirrorClaudeStore` calls with
  a source file that is being appended one byte at a time across a line boundary
  (a real CLI mid-flush race). NOTE: the equal-size in-place-rewrite hole I first
  flagged here is now CLOSED — the join-window compare runs BEFORE the size-equality
  shortcut, and the suite covers it (check 19). A clean-room should still try to
  break the mid-flush race independently.

- **Still open / handoff:** none blocking. Optional follow-up: suppress the resume
  affordance for a mirror-only (post-prune) session so the UI doesn't offer a
  resume the CLI can no longer honour (readability is delivered; resumability was
  never recoverable once the CLI pruned its store).

- **Symptom of a deeper design flaw?** no — this closes a known FEAT-037 gap
  (Orchard owned durable transcripts only for `persistedTranscript:false` engines)
  by extending the same one-owner store to the reference engine; it does not
  reveal a new class.

### 2026-09-16 — independent clean-room verify, round 1 (verify-harness driver, Opus 4.8)

- **Verdict: BROKEN** (VALID per the executed-evidence contract: fixer test
  re-run + 7 named adversarial attacks, each its own recorded run, + an explicit
  UNTESTED list). Cross-provider: the fix was authored by a Claude (anthropic)
  lane; the verifier ran as an OpenAI dispatch in an exported clean room with the
  ambient instruction surface (`CLAUDE.md`/`.claude`/`docs/prompts`/`docs/bugs`)
  stripped, over the UNSTAGED working tree (`scripts/independent-verify.mjs
  --working-tree`). The verifier never saw the fixer's report or rationale.

- **Verified-by:** dispatch openai run `01a0a739-542c-7a81-a856-a8e60b435c11`
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: **BROKEN**.

- **Two BLOCKING defects (data corruption / silent divergence — the ticket's
  stated harm class):**
  1. **In-place rewrite OUTSIDE the 8 KiB join window is missed → silent
     permanent divergence.** The divergence detector only compares the last
     ~8192 bytes. Attack `rewrite-outside-window` (run `34b11a8864e6`, exit 1):
     an equal-size rewrite that changes the FIRST entry (a 100-entry / 47580-byte
     file, edit before the tail window) returns `status:'up-to-date'` with
     `mirrorEntries===sourceEntries` but `equal:false, staleFirstEntry:true`; a
     subsequent append then returns `appended` while the mirror stays divergent
     (`equal:false`). This is the SAME equal-size-compaction class the fixer
     claimed CLOSED by the join-window compare (suite check 19 passes only because
     its twist lands inside the last 8 KiB). A real CLI compaction that rewrites
     an early turn is mirrored as stale, forever.
  2. **Concurrent mirror passes duplicate the entire conversation.** Attack
     `overlapping-writers` (run `449713fcbd87`, exit 1): 12 overlapping passes
     (barrier paused immediately before the real append syscall, no shim byte
     edits) turned **2001 source entries into 24001 mirror entries** — 12×
     duplication, `equal:false`. The mirror is unguarded against its own two
     triggers (turn-end hook + mirror-on-read) racing; the read-length→append is
     a check-then-act with no lock. This is exactly the "duplicate/corrupt on
     append" harm the ticket set out to avoid.

- **Two NON-blocking defects (robustness / disk hygiene):**
  3. **Partial append interrupted by ENOSPC leaves a torn trailing line in the
     mirror** (attack `write-failures`, run `7a5c9c59cd66`, exit 1):
     `originalPrefixPreserved:true` but `endsWithNewline:false` — an incomplete
     fragment remains (error logged, earlier bytes intact). Recoverable on the
     next sync via the deferred-partial path, but the mirror is momentarily
     mid-line.
  4. **`atomicCopyPrefix` leaks temp files on failed snapshots** (same run): 8
     injected-ENOSPC snapshot failures left 8 temp files (160 bytes) —
     repeated-failure temp accumulation, unbounded, not cleaned up.

- **Attacks that HELD (no defect found):** `bytewise-mid-flush` (run
  `9dfc8155f69f`, 545 sync-between-every-byte checks across two line boundaries →
  0 violations, mirror == source) — the mid-flush race the fixer flagged for the
  clean room is in fact handled; `post-prune-http` (run `9d4dea00258e`, 150
  messages identical before/after prune across 20 reads); `fresh-process-
  idempotence` (run `2b8aab6919c2`, 500 syncs over 5 fresh processes, 40==40 no
  dup); `provider-precedence` (run `7a5c5e0ddf01`, Claude-store-preferred while
  present, source-only entry shows through, Codex/merged read unaffected).

- **Fixer test re-run caveat (NOT a fix defect):** `node
  scripts/verify-feat-144-claude-mirror.mjs` exited 1 in the clean room, but ALL
  of Part 1 (mechanics, 12/12) PASSED; Part 2 (HTTP) could not boot because the
  server's `seedTemplates` now reads `docs/prompts/WORKING_AGREEMENT.v3.md`, which
  is NOT in `independent-verify.mjs`'s `BOOT_STUBS` seed list, so the stripped
  clean room lacked it (`server never became healthy`). This is a clean-room
  harness gap (BOOT_STUBS out of sync with seedTemplates), not a defect in this
  change — the verifier confirmed the HTTP behaviour independently with its own
  scratch template records (attacks C/F). Follow-up: add `WORKING_AGREEMENT.v3.md`
  (and any new pattern seeds) to `BOOT_STUBS`.

- **UNTESTED (verifier's own list):** physical disk exhaustion / power-loss
  durability (ENOSPC was injected, not real); actual CLI turn-end execution and
  native Codex import (concurrency used worker threads + a scheduling barrier;
  OpenAI coverage used `TranscriptRecorder`).

- **Handoff to the fixer:** defects 1 and 2 are blocking and must be fixed before
  re-verify — (1) the divergence check cannot be a fixed-size tail window (compare
  full content or a content hash, or detect rewrite by mtime/inode + size+hash),
  and (2) the mirror append needs a real lock (the project's `file-lock` helper)
  so the two triggers cannot interleave. Defects 3 and 4 should be fixed in the
  same pass (write to a temp + atomic rename so a torn line never lands; clean up
  temp files in a `finally`). Status stays IN-PROGRESS; do NOT mark VERIFIED.

### 2026-09-16 — fixer, round 2 (worker, Opus 4.8) — rework of the 4 clean-room defects

- **Understood:** all four defects accepted as real. All fixes land in
  `src/server/orchard-transcripts.ts`; the two write triggers (agent-bridge
  turn-end hook, index.ts read hook) are unchanged and both call the hardened
  `mirrorClaudeStore`.

- **Changed (design):**
  - **Defect 1 (divergence outside the 8 KiB window → silent permanent
    divergence).** Deleted the fixed tail-window compare entirely. New
    `prefixesEqual(src, dst, dstSize)` streams and byte-compares the WHOLE mirror
    against `source[0,dstSize)`, so an in-place rewrite of ANY entry — early, late,
    or equal-size — is detected and routed to the existing `atomicCopyPrefix`
    re-snapshot. Cost is O(prefix) per sync; accepted as sound-over-cheap (syncs
    are turn/read frequency, and the read route already streams the file). The
    optional size+mtime fast-path was deliberately NOT added — correctness must not
    depend on a cache. Fixed the vacuous fixture: the equal-size test now rewrites
    the FIRST entry in a ~60 KiB file (byte 215, far outside the last 8 KiB).
  - **Defect 2 (concurrent passes duplicate 12×).** Wrapped the entire
    read-check→append/recopy critical section in `withMirrorLock(dst, fn)`, which
    REUSES FEAT-129's file-lock: acquire via the module's atomic link-create
    pattern (temp + `linkSync`, never observed empty), staleness via FEAT-129's
    `reclaimReason` (dead-owner `pidAlive` rung + shared `FILE_LOCK_TTL_MS`),
    release by unlink in `finally`. It is a bounded critical section, not
    `evaluateFileLock`'s claim-until-heartbeat model, which cannot express
    acquire-run-release. Fail toward SKIP → new `busy` status (a benign no-op;
    idempotency loses nothing). Lockfile is `<dst>.mirror-lock`; readers filter
    `*.jsonl` (`session-history.ts:515,545`) so it stays invisible to listings.
  - **Defect 3 (torn trailing line on ENOSPC).** Replaced `appendFileSync` with
    `appendCompleteLines(dst, dstOffset, delta)`: `r+` open + `writeSync` at
    explicit offset in a loop; on a short write OR any throw, `ftruncateSync` back
    to the complete-line boundary (`dstOffset`) then rethrow — a half-written line
    can never remain. (First-mirror create still goes through the atomic
    temp+rename `atomicCopyPrefix`.)
  - **Defect 4 (`atomicCopyPrefix` temp leak).** The temp is `unlink`ed in a
    `catch` on any copy/rename failure, so repeated failures cannot accumulate.
  - Added `busy` to `MirrorStatus`; imported `os` + `reclaimReason`/`FILE_LOCK_TTL_MS`.

- **Verified (fixer's own run — necessary, not sufficient):**
  `node scripts/verify-feat-144-claude-mirror.mjs` → **22 passed, 0 failed**
  (working tree). Three new tests added; MUST-FAIL proven against a SYNTHESIZED
  pre-fix module (a tree copy with exactly the three round-1 behaviours reverted:
  8 KiB window + unlocked + `O_APPEND`; anchors asserted so the revert cannot
  no-op), run via `F144_MODULE_ROOT`:
  - **DEFECT 1** — pre-fix: `status:'up-to-date', mirrorEqualsSource:false`
    (divergence silently missed, flip at byte 215 outside the last 8 KiB of a
    59584-byte file); fixed: `recopied`, mirror == source.
  - **DEFECT 2** — pre-fix: 2000 source entries → **23141 mirror entries** (~11.5×,
    all 12 workers `appended`), reproducing the clean-room's 12× duplication;
    fixed: `mirrorEntries === sourceEntries === 2000`, byte-identical.
  - **DEFECT 3/4** — a failed append (read-only mirror file, writable dir) over 5
    repeats leaves the mirror INTACT (no torn line, ends with newline) and the dir
    with NO lock/temp litter (`litterFiles:[]`); recovers exactly once when
    writable again. (This is a robustness guard, not a must-fail demo — see limits.)
  - Attacks that must stay holding all re-passed: bytewise mid-flush (via the
    partial/complete tests), post-prune HTTP read (THE PROOF, 200 from mirror),
    fresh-process idempotence (hammered re-syncs), provider precedence (source-only
    entry shows through while the CLI file exists).
  - `npm run gate` → typecheck PASS, check-nul PASS. **leak-gate FAILS, but ONLY on
    `scripts/verify-feat-145-container-account.mjs` (a concurrent FEAT-145 lane's
    file, a deliberately-invalid fake token) — MY files contribute 0 hits.** Not my
    change; flagged to the orchestrator. `npm run board:check` DRIFT is the
    pre-existing doc-freshness warnings only; none concern FEAT-144.

- **Verified-by:** PENDING — the coordinator will commission the next clean-room
  round. Status stays IN-PROGRESS (not self-flipped to VERIFIED).

- **Limits / honest gaps (§C):** defect 4's temp-unlink and defect 3's mid-write
  `ftruncate` rollback are verified by code + the read-only-file robustness test,
  but my black-box suite CANNOT deterministically inject a post-temp copy failure
  or a mid-write ENOSPC without root/`ulimit`+SIGXFSZ games — the authoritative
  injection is the clean-room's own ENOSPC harness (`write-failures`), which should
  be re-run. The O(prefix) full-compare cost on very large sessions (the 286 MB
  outlier) is a known trade-off, chosen for soundness over a cache.

- **Still open / handoff:** re-verify defects 3 & 4 with the clean-room's ENOSPC
  injection; confirm defect 2's lock under a real multi-PROCESS topology (my test
  used worker threads in one process — the OS link-create lock covers processes
  too, but it was not exercised cross-process).

### 2026-09-16 — independent clean-room re-verify, round 2: BLOCKED (verify-harness driver, Opus 4.8)

- **No round-2 verdict — the change is NOT independently verified.** The
  cross-provider clean-room re-verify was commissioned exactly as round 1
  (`scripts/independent-verify.mjs --working-tree`, author anthropic → verifier
  openai, ambient surface stripped, verifier shown only requirement + diff + run
  guidance + the fixer's test code). The clean room built cleanly (working-tree
  snapshot HEAD `dc1f4ea` → tree `e4775b6c0aae`; node_modules reflink-copied;
  `docs/prompts`+`docs/bugs` stripped). The dispatch then FAILED before the
  verifier ran: **openai/codex provider quota exhausted** —
  `dispatch failed [quota-window] … try again at Sep 19th, 2026 1:37 PM`.
  Confirmed non-transient on an immediate retry (thread
  `01a0b171-994a-72b2-a9e6-0212898b2638`, same quota-window error).
  `independent-verify.mjs` correctly fail-closed: `VERDICT-CONTRACT: INVALID — the
  verification dispatch itself failed, so nothing was verified.`

- **Provider availability:** the host broker (`dispatch-client.mjs --check`)
  routes ONLY `openai`; there is no `anthropic` dispatch target here, so a
  same-provider fallback verify is not possible either. The round-2 re-verify must
  wait for the openai quota window to reset (2026-09-19 13:37) and be re-run then.

- **The round-2 requirement + named attacks were fully composed** (equal-size
  early-entry rewrite re-run, overlapping-writers duplication re-run, CROSS-PROCESS
  lock race + SIGKILL-mid-critical-section reclaim, busy-is-not-silent-loss,
  ENOSPC no-torn-line / no-`.tmp` litter, and the four non-regression holds) and
  are staged for immediate re-dispatch once quota returns.

- **Leak check (cheap, requested):** the three tracked FEAT-144 files
  (`orchard-transcripts.ts`, `agent-bridge.ts`, `index.ts`) contribute ZERO leak
  hits — `node scripts/leak-gate.mjs` = `PASS — 0 hits across 1102 files
  [REPO (git-tracked)]`. The untracked `scripts/verify-feat-144-claude-mirror.mjs`
  is synthetic fixture data only (padded zero-uuids, scratch temp paths). FEAT-144
  is not the source of the current `npm run gate` red (that is the concurrent
  FEAT-145 lane's `scripts/verify-feat-145-container-account.mjs`, untouched here).

- **Verified-by:** NONE for round 2 — dispatch blocked, no verdict. Round 1's
  BROKEN verdict (openai run `01a0a739-542c-7a81-a856-a8e60b435c11`) remains the
  last completed independent verdict; the round-2 rework has NOT been independently
  re-verified. Status stays IN-PROGRESS; NOT flipped to VERIFIED.

### 2026-09-16 — independent clean-room re-verify, round 2 (SAME-PROVIDER fallback): HOLDS (verify-harness driver, Opus 4.8)

- **Verdict: HOLDS (VALID per the executed-evidence contract).** Run with the
  openai window still exhausted, so — on the coordinator's routing call (degrade
  within the available ladder rather than stall) — the round-2 charter was
  re-dispatched VERBATIM on the ANTHROPIC path. Same clean room
  (`independent-verify.mjs --working-tree`, tree `e4775b6c0aae`), same ambient
  strip, same `--sandbox workspace-write`, verifier shown only requirement + diff
  + run guidance + the fixer's test code.

- **INDEPENDENCE CAVEAT (the one thing this round does not buy):** the verifier
  provider is anthropic — the SAME provider as the author. The clean room is
  intact (no shared context, fresh process, board/methodology stripped), but
  cross-provider decorrelation of blind spots is REDUCED. This round is
  corroboration, NOT the ticket's final proof; the cross-provider (openai) round
  on/after 2026-09-19 13:37 is what closes it. That is why the status is NOT
  flipped to VERIFIED despite a clean verdict.

- **Verified-by (round 2, weakened):** dispatch **anthropic** (SAME-PROVIDER as
  author — decorrelation reduced) run `97800f97-5b3d-492a-acd8-33dfb82b0e2e`
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: **HOLDS**.

- **Fixer test re-run:** `node scripts/verify-feat-144-claude-mirror.mjs` →
  **22 passed, 0 failed** (exit 0) in the clean room — including the newly-added
  regression checks: DEFECT 1 (early-entry equal-size rewrite OUTSIDE the former
  8 KiB window, flip at byte 215 of a 59584-byte file → `recopied`, mirror ==
  source); DEFECT 2 (12 concurrent passes, source 2000 == mirror 2000, statuses
  `appended` + 11×`busy`); DEFECT 3/4 (a failed append leaves mirror intact, ends
  with newline, zero lock/temp litter across 5 repeats; deferred delta lands once
  when writable). Part 2 HTTP (post-prune read proof, precedence, survivor list)
  all green.

- **Named attacks — outcomes:**
  - **A1 equal-size early-entry rewrite (re-run of round-1 defect 1): HOLDS** —
    covered by fixer check DEFECT 1 above; the full-prefix `prefixesEqual` compare
    catches a flip outside any tail window.
  - **A2 overlapping-writers duplication (re-run of round-1 defect 2): HOLDS** —
    fixer check DEFECT 2 (2000==2000), and independently below.
  - **cross-process-race: HOLDS** (run `659458581c67`, exit 0) — 8 SEPARATE OS
    PROCESSES (not worker threads) racing the link-create lock on one session:
    `sourceEntries 1600 == mirrorEntries 1600`, bytes equal, 0 invalid-JSON lines,
    child statuses `appended` + 7×`busy`. This is the exact cross-process topology
    the prior fix had not exercised.
  - **busy-not-silent-loss + stale-reclaim: HOLDS** (run `e679221958c9`, exit 0) —
    held the lock with a genuinely-ALIVE foreign pid → pass returns `busy`, mirror
    untouched, live lock NOT reclaimed; then SIGKILLed the holder → a LATER pass
    RECLAIMED the dead lock and appended the whole skipped delta (`600 == 600`,
    bytes equal). Proves invariant 2 (a `busy` skip is never permanent loss) and
    the reclaim-dead / respect-live split.
  - **Non-regression (post-prune HTTP read, fresh-process idempotence, provider
    precedence, bytewise mid-flush): HOLDS** — exercised within the 22/22 fixer
    suite (Part 1 mid-flush/idempotence/precedence, Part 2 HTTP prune proof).

- **UNTESTED (verifier's own list) — residual for the cross-provider round:**
  1. A GENUINE mid-write ENOSPC/short-write was NOT exercised — it needs a
     size-capped mount (tmpfs/loopback) requiring privileges absent in the
     sandbox. The verifier drove the failure/no-litter path via an EACCES
     read-only mirror (passed), but the specific `ftruncate` torn-line ROLLBACK in
     `appendCompleteLines` against a real short write was not hit. This is a
     verification-coverage gap, not a known defect (the rollback code exists and
     the EACCES path is clean); the openai round on the 19th should attempt a real
     capped-mount ENOSPC if privileges allow, else this stays an accepted
     honest limit.
  2. The diff was truncated at 60000 of 1580243 bytes; files beyond
     `orchard-transcripts.ts`/scripts were judged from the checked-out working
     copy, not the diff. (The FEAT-144 mechanism lives in `orchard-transcripts.ts`,
     which was fully in-diff.)
  3. Part 2 HTTP only booted after the verifier created stub
     `docs/prompts/WORKING_AGREEMENT.v3.md` and `.v4.md` — the clean-room
     `BOOT_STUBS` list in `independent-verify.mjs` is missing v3/v4 (seedTemplates
     now reads them). Harness follow-up (separate from FEAT-144): add v3/v4 to
     `BOOT_STUBS`. Mirror code itself unaffected.
