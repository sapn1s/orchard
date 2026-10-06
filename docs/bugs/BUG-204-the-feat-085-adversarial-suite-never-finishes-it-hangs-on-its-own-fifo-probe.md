# BUG-204 — the FEAT-085 adversarial suite never finishes: it hangs on its own FIFO probe

- **Status:** FIXED (round 1, 2026-09-29). `finalAssistantText()` now reads only a REGULAR file
  (`fs.statSync(p).isFile()` gate), so the harness never does a blocking synchronous read of the
  section-J FIFO. Suite completes and prints its summary (78 passed, 1 failed [pre-existing G5],
  1 warn [J1 FIFO, its intended WARN]). BUG-192 suites all still green. See the round-1 Activity entry.
- **Severity:** medium. The suite can never print its verdict, so it cannot pass or fail. Every agent that waits for its summary line waits forever. This is the direct cause of the 5 hung waiters in session 7f7e39a1 (FEAT-154 round 6/7). No data loss.
- **Area:** `scripts/verify-feat-085-adversarial.mjs` (`payload()` → `finalAssistantText()`, section J "FIFO / never-closing transcript")
- **Reported:** 2026-09-29
- **Related:** FEAT-154 (the list read "working" because of the waiters this hang created), BUG-140 (the class: a wait that outlives the work it watches), BUG-192 (the lane whose edit introduced the hang)
- **regressed-from:** BUG-192. Its fix lane (`a852391c…`, session 7f7e39a1) made the edit on 2026-09-27 at 21:02:13Z, and it landed in commit 561ad6b.

## Symptom
`node scripts/verify-feat-085-adversarial.mjs` prints its header, the G5 FAIL line, and
`(I2 took Nms …)`, and then hangs forever. The summary line
`FEAT-085 adversarial: N passed, M failed …` never appears and the process never exits.

## Why
During BUG-192, `payload(transcriptPath)` was changed to also send `last_assistant_message`. To do
that it now calls `finalAssistantText(transcriptPath)`, which does a **synchronous read of the
transcript inside the harness process itself**. Section J deliberately passes a FIFO held open by a
writer that never closes. Before the change, only the hook child read that FIFO. The harness
SIGKILLs the child at its 6s cap, and the probe reported a WARN. Now the **harness's own main thread** blocks in
that read before it ever spawns the hook. The 6s cap cannot help, because it only guards the child. No
JS handler can run either, since the event loop is blocked.

## Evidence (2026-09-29, HEAD `a977e76`)
- `timeout 150 node scripts/verify-feat-085-adversarial.mjs` exited 124 after 150.0s. Output stopped
  after the I2 line.
- Spawn tracing via a `--require` preload: the last hook spawn is at 2.8s (I2) and none follows. The
  main thread's `wchan` is `anon_pipe_read`, which is a blocking pipe/FIFO read. A `SIGUSR2` handler
  never ran, which confirms the loop is blocked synchronously and is not merely waiting.
- The same suite completed in about 20s at 20:38Z on 2026-09-27 (`77 passed, 2 failed, 1 warn`),
  before the 21:02:13Z edit. Every run after the edit hung: 21:02, 21:06, 21:13, 21:16, 21:29,
  22:00 and 22:08Z.

## Repair candidate (not built — explore lane)
In `payload()`, read the final assistant text only from a regular file. Guard it with
`fs.statSync(p).isFile()`, or catch the error and skip the read. A FIFO then goes to the hook
unread, as it did before BUG-192. That restores J1's intended question: does the HOOK wedge? The
check must first fail as-is, which is already demonstrated by the exit-124 run above. It must then
complete under a hard `timeout`. Separately, G5 (`digest NOT at top → BLOCK`, got ALLOW) FAILs at
HEAD; this ticket does not diagnose it.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent (FEAT-154 explore lane, round 7)
- Filed while tracing why 5 background waiters in 7f7e39a1 never ended (see FEAT-154, same date).
  The waiters polled for this suite's summary line. The line cannot appear, because the suite hangs
  before printing it. Reproduced live on HEAD, as above. My probe processes were killed by `timeout`,
  and I confirmed none were left.

### 2026-09-29 — dispatched fix lane (fixing, round 1)
- **Cause confirmed (matches the ticket's hypothesis exactly):** `payload(fifo)` at section J
  (`verify-feat-085-adversarial.mjs:399`) calls `finalAssistantText(fifo)`, which did an
  unconditional `fs.readFileSync(fifo, 'utf8')` — a synchronous read of a FIFO held open by a
  writer that never closes (`fs.openSync(fifo, 'r+')`, :398). That blocks the harness's own main
  thread forever, before the hook is ever spawned. The 6s `HARD_CAP_MS` guards only the hook child,
  and the blocked event loop can run no JS handler. Section J's intent is to probe whether the HOOK
  wedges on such a FIFO, so the harness must not read it itself. BUG-192 introduced the read (it
  derives `last_assistant_message` for the block-safe grader path); the FIFO case was the one input
  it did not account for.
- **Fix (`scripts/verify-feat-085-adversarial.mjs`, `finalAssistantText`):** gate the read on
  `fs.statSync(transcriptPath).isFile()` — only a regular file is read. `statSync` fetches metadata
  and does NOT block on a FIFO. A FIFO/socket/device/absent/unreadable path now returns `''`, leaving
  `last_assistant_message` unset, so the FIFO goes to the hook unread exactly as it did before
  BUG-192, and J1 falls back to its intended WARN. BUG-192's real-regular-file path is unchanged
  (real transcripts pass the gate and still derive the block-safe text).
- **Must-FAIL proof (bounded):** HEAD (pre-fix) `timeout 120 node scripts/verify-feat-085-adversarial.mjs`
  → EXIT 124, output stopped after the I2 line, summary never printed. AFTER the fix,
  `timeout 300 …` → completes in seconds: `FEAT-085 adversarial: 78 passed, 1 failed, 1 warn`, and
  J1 prints its `WARN … FIFO transcript (non-realistic sync-read block)`.
- **BUG-192 still holds:** `verify-bug-192-stop-hook-race-and-length` 15/0;
  `verify-feat-137-138-enforcement` 12/0; `verify-feat-150-completion-claim` 11/0;
  `verify-feat-085-readability` 16/0 (1 skipped); `verify-feat-085-stop-hook` 61/61 — all match
  BUG-192's round-3 counts.
- **Not a regression (pre-existing):** the lone failure, G5 (`digest NOT at top -> BLOCK`, got
  ALLOW), fails on HEAD too and is the documented FEAT-143 short-reply exemption; this ticket does
  not diagnose it. The J1 WARN is the intended, expected outcome, not a failure.
- **Gate:** `npm run gate` → PASS (exit 0) — leak-gate + check-nul + typecheck. No git commands run;
  work left unstaged.
- **Cleanup:** every run was bounded with `timeout` and run in the foreground. No leftover
  processes (`pgrep` clean). The hung HEAD runs left stale `/tmp/feat085-adv-*` scratch dirs
  (this suite's own short-lived scratch); removed them. The fixed run self-cleans its TMP at exit
  (confirmed none remain). No `:4317` / systemd / host processes touched.
- **Independent verify:** LOW-risk — this is a test-harness-only change (no product/hook/session-
  lifecycle file touched); a clean-room pass is not warranted.
