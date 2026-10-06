```orchard-ticket
{
  "id": "FEAT-111",
  "type": "feature",
  "title": "A lane cannot harvest a live background child",
  "summary": "A fixer dispatched a background verifier, its turn ended, and it was told the verifier was likely dead. It saw the child's processes alive, then re-ran the verification anyway because no sanctioned way exists to read a live child's result. The child finished fine seven minutes later. Cost: 51.6 duplicated minutes.",
  "impact_if_we_wait": "Every time a lane's turn ends over a live background child, the fleet pays that child's whole runtime twice and runs two concurrent fleets of scratch servers and containers against one working tree. Bounded to wall clock and duplicated compute, not correctness: both passes here reached the same verdict.",
  "current_need": "Give a lane a bounded way to tell a live child from a dead one and to read a finished child's final report only, so the turn-end rule has a branch other than re-running everything.",
  "severity": "medium",
  "area": "Dispatch and lane coordination (scripts/, docs/prompts/WORKING_AGREEMENT.v2.md)",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A lane can ask, in one bounded call, whether a named background child is alive, finished, or gone, without reading its transcript",
    "A lane can read a finished child's FINAL assistant report only, bounded in size, without ingesting the whole child transcript",
    "A lane that finds its child alive has a stated rule for what to do next, and that rule is not \"re-run everything\"",
    "Must-FAIL: against the recorded BUG-157 pair, the pre-change path shows the parent re-running suites the live child was concurrently running",
    "Two lanes are never told to write the same scripts/verify-*.mjs path in one working tree"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-157",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "see_also"
    },
    {
      "id": "BUG-046",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "e26292db-0a65-4f8f-9e9d-9412626f2019",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:43:38.172Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "clean-room carrier-tree (range 28eb430); 3 findings in harvest-agent.mjs: mid-write partial JSON, per-content-block terminal misread, final record > tail-bytes"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-111 — A lane cannot harvest a live background child

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-27 — agent (measurement behind the filing)

Derived from the two lane transcripts for BUG-157 by the method in
`docs/analysis/COST-METHOD.md` (tool spans = `tool_use` timestamp to its
`tool_result` timestamp; generation = lane wall minus the union of those spans).

**The sequence, with clock times.**

| time | event |
|---|---|
| 10:43:26 | fixer lane starts |
| 10:51:53 | fixer dispatches a background verifier child (`run_in_background: true`) |
| 10:59:27 | fixer's turn ends; harness emits `status=completed` **while the child is live** |
| 10:59:44 | orchestrator resumes the fixer: "your verifier is very likely dead, re-run it in foreground" |
| 10:59:51 | fixer runs `ps`, **sees the child's suite process alive at 41s elapsed**, and re-runs anyway |
| 11:51:19 | fixer reports |
| 11:58:56 | child finishes: 12-check direct suite plus a real-docker container suite, full must-FAIL/PASS |

The task-notification's own note says it fires "each time this agent stops with
no live background children of its own". A live background child existed.

**Where the fixer's 67.9 minutes went.**

| segment | wall | tool calls | blocked on tools | model generation |
|---|---|---|---|---|
| before the turn end (the actual fix) | 16.0 min | 67 | 0.1 min | 15.9 min |
| after the resume (re-running the child's work) | 51.6 min | 46 | 33.3 min | 18.3 min |

The first segment — 67 tool calls, six seconds of tool wall — is the same shape
as the fast lanes it was compared against. Nothing was slow about the fixing.

**What both lanes ran, separately, against the same working tree.**

| suite | fixer | child |
|---|---|---|
| the woken/revival direct suite | 14.3 min | 18.2 min |
| the container close-live-work suite | 7.8 min | 2.6 min |
| the regression sweep (detach, close-background-detach, liveness, snapshot, and the two prior session-death checks) | 11.1 min | 23.9 min |

Both also independently discovered that `git worktree add` is denied by the
git-write policy, and each independently reinvented a synthesized pre-fix tree
(about 1.1 min apiece).

**Collision.** Both lanes wrote the same new `scripts/verify-*.mjs` path in one
working tree. The child overwrote the fixer's container repro; the fixer noticed
and rescued its own copy under a second name. Two container test fleets and two
sets of scratch session-hosts were live at once.

**What is irreducible.** The child's own hour is close to the floor: seven runs
of a suite that starts a real server, a real survival broker and a real
container, at four to five minutes each, iterating on a discriminator that
genuinely had to fail on the old tree and pass on the new one. Two of its runs
came back 11/12 with a different check failing each time — that is the suite
being sharpened, not waste. The avoidable 51.6 minutes is the *second* copy of
that hour, not the hour itself.

### 2026-08-27 — agent (fixing, round 1)

**Built the harvest path.** `scripts/harvest-agent.mjs <agent-id>` — given a
child agent id it reports status from ground truth (never a notification) plus
elapsed / last-activity, and extracts the child's FINAL assistant text only,
from a bounded tail of the transcript. Storage model discovered on disk: a
subagent's transcript is `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`
(all subagents flat there regardless of depth), so the id alone locates it; the
harness's advertised `/tmp/.../tasks/<id>.output` is a symlink to that same file.

Two independent ground-truth signals, combined so neither can lie alone: (1)
ACTIVITY — two size samples across a window + mtime recency; (2) COMPLETION — the
transcript's last turn terminates (an assistant record with **no tool_use
block**; not stop_reason, because real `claude-opus-5` children persist
`stop_reason:null` on a finished answer — an end_turn-only check false-STALLed 25
of 120 real transcripts). Because the harness writes the file concurrently,
FINISHED is only declared when the file is QUIESCENT; a growing/fresh file always
reads RUNNING, so a mid-write snapshot can never be mistaken for done. Exit codes
let a caller branch: 0 FINISHED, 10 RUNNING (with the measured wait-guidance), 11
STALLED (loud: verify by hand), 12 FINISHED_EMPTY (loud), 3 GONE (loud), 2/4
usage/IO. Fail-loud throughout — an absent/unreadable/empty child is never a
silent empty success.

**Verified against all three real states (real output pasted in the return):**
a genuine live background child caught mid-tool → RUNNING (exit 10); the same
child after completion → FINISHED with its exact marker (exit 0); an absent id →
GONE (exit 3). Bounded-read proven on a real 8.1 MB transcript: 13.7% read,
correct FINISHED. Concurrent-write race proven by truncating a real transcript at
10/25/50/75/90/99/100% with a fresh mtime (all RUNNING, never a false FINISHED)
and by an active-append writer during the sampling window (RUNNING via growth).
Batch-classified 120 real transcripts: no crashes; the only STALLED are genuinely
non-terminal (mid-tool / injected-user). Committed regression suite
`scripts/verify-feat-111-harvest.mjs` — 18/18, covering every classification, the
opus-5 null-stop regression, both fail-loud paths, the bounded read, and the race.

**Onboarding decision.** The tool is a general Claude-Code capability (nothing
Orchard-specific — it reads `~/.claude/projects/...`), so it BELONGS in the
onboarded set alongside the gate/hook (`onboard.mjs` METHOD_FILES). NOT wired in
this lane on purpose: `onboard.mjs` currently holds another lane's uncommitted
FEAT-106 changes, and adding my line there would entangle per-file staging across
tickets. Recommend the orchestrator add `scripts/harvest-agent.mjs` to
METHOD_FILES once FEAT-106 settles.

**Working Agreement amended (canonical, then mirror synced byte-identical).**
§C status-report-advisory bullet RECONCILED (not duplicated) to cover completion
notifications and turn-ends; §L turn-end bullet REWRITTEN to split RIGHT
(background-within-a-turn + overlap) from WRONG (end turn to wait) and to correct
the too-strong "the child dies with the turn" wording. CHANGELOG entry added.

No git writes performed; work left unstaged for the user.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run e26292db-0a65-4f8f-9e9d-9412626f2019 — VERDICT: BROKEN — clean-room carrier-tree (range 28eb430); 3 findings in harvest-agent.mjs: mid-write partial JSON, per-content-block terminal misread, final record > tail-bytes. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — clean-room verification (verifying, round 1): BROKEN

**Strategy: CARRIER-TREE.** The fix (`scripts/harvest-agent.mjs`,
`scripts/verify-feat-111-harvest.mjs`) is committed at `d687709` (2026-08-28),
which PREDATES `src/server/seed-sources.mjs` (landed `ca672b9`, 2026-09-23) — so a
clean room exported at `d687709` cannot boot and the harness refuses it. Fell back
to a recent BOOTABLE commit as the carrier: `--range 28eb430` (a FEAT-130 leak-gate
commit after the boundary). Both target files are byte-identical at `28eb430` and at
`d687709`/HEAD, so the room contains the exact fix under test; the verifier was told
in the requirement that the shown diff is an unrelated carrier and to read/attack
`scripts/harvest-agent.mjs` directly and re-run the suite. Same-provider
(anthropic author + anthropic verifier — openai reserved for high-stakes;
decorrelation reduced, noted). Run `e26292db-0a65-4f8f-9e9d-9412626f2019`; verdict
is VALID and manifest-backed (FIXER-TEST re-run 18/18, 8 adversarial runs,
UNTESTED present). Typed proof is in the record's `verification[]` (verdict BROKEN).

**Three real defects found (next fixing round should address):**

1. **Mid-write partial JSON read as FINISHED.** `parseLines` silently skips a
   trailing line that is not valid JSON and `analyzeTail` then trusts the record
   BEFORE it. A quiet transcript cut mid-record (writer died/paused mid-write)
   returns FINISHED (exit 0) with a mid-turn narration line as the "final" result.
   Proof: 1/1 BAD, plus 10/30 cuts of a real-shaped transcript returned FINISHED
   with a non-final result (`aged-cuts-at-many-offsets`).

2. **Per-content-block transcripts misread as terminal.** Any assistant record
   with no `tool_use` block is treated as terminal. When a transcript is written
   one record per content block, the narration text sits in its OWN record before
   the `tool_use` record; a mid-turn state left quiet past `settleSecs` (3s) reads
   FINISHED with the wrong text. The fresh-mtime guard only covers the first 3s.
   Proof: `split-block-midturn-10s-old` → FINISHED with wrong result.

3. **Final record larger than `--tail-bytes` → false STALLED.** When the final
   record exceeds the tail window, the window starts inside it, it is dropped as
   partial, and a genuinely finished agent is reported STALLED (exit 11). Nothing
   reports the window was too small. Proof: `final-record-larger-than-tail-window`.

**What HELD** (so the next fix does not regress it): fresh-mtime cuts never
FINISHED; 11 MB / 24k-record file bounded (fractionRead 0.097); thinking-only final
turn → FINISHED_EMPTY (exit 12), no result; fresh non-terminal tail → RUNNING (exit
10). The suite itself re-ran 18/18.

**Status: left OPEN (not VERIFIED)** per the BROKEN verdict. Findings 1 and 2 are
concurrent-write / real-transcript-shape races — the exact class the ticket exists
to get right — so the next round should drive the REAL subagent transcript layout
(one record per content block) and truncate it at many offsets, not only the
minimal synthesized fixture. This is a session-lifecycle, race-prone change: an
independent clean-room re-verify is warranted once re-fixed.

### 2026-10-02 — agent (fixing, round 2): all 3 defects fixed

**The class the fix now enforces.** "Is this lane finished?" is decided ONLY from
a COMPLETE, terminal record per the transcript schema — never a partial line, never
a non-terminal block.

**Ground-truth schema check first** (read real lane transcripts under
`~/.claude/projects/*/<session>/subagents/`, 3547 of them): Claude Code persists
**one record per content block**, so a turn "narrate then call a tool" is a `text`
record followed by a SEPARATE `tool_use` record sharing the same `message.id` (no
record ever mixes `text`+`tool_use`). The genuinely-final record is an assistant
turn with no `tool_use` block; its `message.stop_reason` is the field that grades
it — but **258/3547 real finished transcripts carry `stop_reason: null`** on a
complete final text answer (across opus-5/opus-4-8/fable-5/sonnet-5, all cleanly
`\n`-terminated, all reading as complete handoffs). So requiring `end_turn` would
false-STALL 7% of real children (the round-1 reason for the `end_turn`-absence
check) — but trusting "no tool_use block" alone is what round-1 got wrong.

**Three fixes in `scripts/harvest-agent.mjs`:**
1. **Mid-write partial read (finding 1).** A tail whose last line lacks a
   terminating `\n` is a record in flight (writer appending, or died mid-record).
   `parseLines` silently drops the fragment and round-1 then trusted the record
   BEFORE it. New: compute `incompleteTail` from the bytes after the last newline;
   if set, the transcript is never FINISHED (fresh → RUNNING, aged → loud STALLED
   naming "mid-record").
2. **Per-content-block narration misread as terminal (finding 2).** `analyzeTail`
   now grades a terminal record's confidence by `message.stop_reason`: DEFINITIVE
   (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`, or a workflow `result`) is
   trusted once quiescent past `settleSecs`; AMBIGUOUS (`stop_reason` null — a
   finished opus-style answer and a not-yet-continued narration block are
   byte-identical) is trusted only past the stall horizon (`--idle-secs`), because
   a live turn would have written its next block within that window. Before the
   horizon an ambiguous terminal reads RUNNING — the safe bias, never a re-run.
3. **Final record larger than `--tail-bytes` (finding 3).** `readTail` →
   `readTailAligned`: if the tail window begins inside the final record (fewer
   than 2 newlines in it), the read is GROWN by doubling until it captures the
   record boundary or reaches file start, so a huge final answer is returned whole
   instead of dropped-as-partial → false STALLED.

**Must-FAIL-before / PASS-after (ran the clean-room's own attack, run e26292db,
against a `.mjs` copy of the round-1 code, then against HEAD):**
- Finding 1: pre → FINISHED with narration "Now I will run the tests."; post →
  STALLED (aged) / RUNNING (fresh). Generalised "aged cuts at 30 offsets": pre
  10/30 FINISHED-with-non-final; post 0/30.
- Finding 2 (`split-block narration, 10s old`): pre → FINISHED with narration;
  post → RUNNING. Companion: the same bytes aged past the horizon → FINISHED
  (null-stop finals still harvest).
- Finding 3 (`final record > tail window`, hex id): pre → STALLED exit 11 (the
  false STALL); post → FINISHED with the full 5000/6000-char result. (The
  clean-room's own attack used non-hex ids `g1`/`h1`, which hit arg-validation
  exit 2 before reaching the logic — re-ran with valid hex ids to get the honest
  before/after.)

**Regression suite extended** `scripts/verify-feat-111-harvest.mjs` 18 → **29/29**,
adding realistic per-content-block fixtures (with `message.id`, the real null-stop
distribution): mid-write guard, aged/fresh many-offset cuts, split-block narration
within vs past the horizon, huge final record (end_turn and null-stop), a REAL
concurrent appender growing the file during a 400 ms sampling window → RUNNING, and
the fresh-end_turn race guard.

**Real-data anti-regression** (my own check, not committed — reads the user's
private transcripts): batch-classified 400 real subagent transcripts: 382 FINISHED,
18 STALLED, 0 crashes, 0 empty-FINISHED anomalies. All 18 STALLED are genuinely
non-terminal (last record `user:text` injected / `user:tool_result` mid-tool /
`attachment`) — no false STALL on finished work.

**Known residual (honest).** A clean-`\n`-terminated file whose last record is a
mid-turn narration with `stop_reason: null`, quiescent PAST the stall horizon, is
byte-indistinguishable from a genuine null-stop final (this is why finding 2's
fixture is aged 10s, not 600s) and reads FINISHED with the narration text. This
requires the writer to have died exactly between a narration block and its sibling
tool_use while still flushing a trailing newline — a crash, not normal pausing —
and the returned text is still real text the child emitted. The horizon makes every
pre-horizon case safe (RUNNING/wait). Not reproducible from the real transcript
corpus.

**Gate:** `npm run gate` PASS (exit 0, unpiped). `board:check` OK — no drift.
No git writes; files left unstaged: `scripts/harvest-agent.mjs`,
`scripts/verify-feat-111-harvest.mjs`, this ticket.

**Handoff.** Session-lifecycle, race-prone, regresses a prior round
(regressed-from: FEAT-111 round 1) → an INDEPENDENT clean-room re-verify is
warranted (not a Task subagent). Re-attack suggestion: drive REAL (not synthesized)
subagent transcripts truncated at many offsets, a live concurrent appender, and a
multi-MB final record; confirm the known residual above is judged acceptable.
