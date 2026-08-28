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
  "updated": "2026-08-27",
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
  "verification": [],
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
