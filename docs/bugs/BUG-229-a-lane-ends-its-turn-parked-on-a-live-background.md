```orchard-ticket
{
  "id": "BUG-229",
  "type": "bug",
  "title": "A lane ends its turn parked on a live background child",
  "summary": "A worker lane launches something long — its own background Agent sub-agent, or a separate dispatch / independent-verify process — then ends its turn \"to wait for it.\" The harness reports it completed with no result, and nothing wakes it; the orchestrator must resume it by hand. The injected WA rule has not held — twice on 2026-10-01, plus 2026-08-27.",
  "impact_if_we_wait": "Every long lane risks stalling for however long the orchestrator takes to notice — hours in recorded cases — and risks a destructive re-run of a still-live child (51.6 lane-minutes lost once). Bounded: no data loss, no wrong verdict; the cost is stalled time and duplicated work.",
  "current_need": "A STRUCTURAL way to stop a lane ending its turn over a live child it will not harvest; an injected text rule has failed repeatedly. It must not wedge a lane when the child is actually dead.",
  "severity": "high",
  "area": "lane turn-end / background child lifecycle",
  "reported": "2026-10-01",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A lane cannot silently end its turn while a background child of its own is PROVABLY alive; it is corrected to poll or hand off.",
    "A lane whose child is dead, finished, or stalled is NEVER blocked — the guard blocks only on positive proof of life.",
    "The guard fails OPEN on any error and caps at one correction per turn, so a buggy guard cannot wedge a lane.",
    "Must-FAIL: the pre-change path reproduces a lane ending its turn over a live child with no automatic resume.",
    "No background child, clean room, scratch server, or container is orphaned or double-run at the lane's turn end."
  ],
  "code_refs": [
    {
      "path": ".claude/settings.json",
      "symbol": "SubagentStop",
      "note": "already registers a SubagentStop hook (ticket-leak-gate) — the slot a park-gate would join"
    },
    {
      "path": "scripts/hooks/ticket-leak-gate.mjs",
      "symbol": null,
      "note": "working template: a SubagentStop hook that BLOCKs with a corrective reason and uses stop_hook_active as the one-correction latch"
    },
    {
      "path": "scripts/harvest-agent.mjs",
      "symbol": null,
      "note": "FEAT-111 — ground-truth RUNNING/FINISHED/STALLED/GONE verdict for a background child by agent id; the signal a park-gate must block on (RUNNING only)"
    },
    {
      "path": "src/server/liveness.ts",
      "symbol": null,
      "note": "ARCH-001 — the single authority on is-X-alive; unknown is first-class, never coerced"
    }
  ],
  "related": [
    {
      "id": "BUG-210",
      "relation": "see_also"
    },
    {
      "id": "ARCH-017",
      "relation": "see_also"
    },
    {
      "id": "BUG-046",
      "relation": "see_also"
    },
    {
      "id": "FEAT-111",
      "relation": "see_also"
    },
    {
      "id": "BUG-145",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-229 — A lane ends its turn parked on a live background child

## The invariant that breaks

A dispatched lane must not end its turn with a live background child it will not harvest (worker charter line 10; WA §I; BUG-046). Two shapes both violate it, and the injected text rule does not stop either:

1. **Own in-process Agent sub-agent.** The lane launches a background `Agent`/`worker` child, then ends its turn "to wait for it." The harness emits the lane's completion the instant its turn ends even while the child is live (WA §C, measured 2026-08-27); once the lane's context is gone it may never be scheduled to read the result.
2. **Separate OS process** (`npm run dispatch`, `scripts/independent-verify.mjs`). A `claude -p` child that legitimately runs longer than the 10-min foreground Bash cap, so the lane backgrounds it and the turn ends over it. For an OS child nothing re-invokes the lane at all — only the orchestrator noticing resumes it.

## Evidence

- **2026-10-01:** seen twice in one orchestrator session (this dispatch's origin). Not in any ticket's own Activity log, because a lane only writes its entry after it resumes — the same reporting gap BUG-210 notes.
- **2026-08-27 (WA §C / §I):** a harness emitted `completed` while a child was still live; the parent, told the child was probably dead, re-ran its ~1h suite; the child finished an identical verdict 7.6 min later — 51.6 duplicated lane-minutes. Also measured that day: a child ran ~1h past its parent's turn end.
- **BUG-210:** the verify-lane-specific instance — independent-verify parked at turn-end four times verifying BUG-196; one park lasted ~12 hours.

## Why a charter sentence keeps failing

The rule is injected whole into every lane and is correct, but (a) for the OS-process shape it conflicts with a hard limit (foreground Bash caps at 600000 ms; a real verifier runs longer), leaving the lane no compliant option, and (b) for the Agent-child shape the lane has no cheap sanctioned way to overlap-and-harvest, so "park and wait" looks like the only branch. BUG-145 already established that an injected categorical rule here is ignored roughly half the time; a louder sentence is not the fix.

## What already exists (so no one re-derives it)

- **SubagentStop IS a supported hook event** in this CLI (confirmed: bundle hook-event list in `docs/bugs/_scratch-denial-hook-options.md` §2; SDK `sdk.d.ts`), and Orchard **already registers one** in `.claude/settings.json` (the leak-gate). It can BLOCK (`{"decision":"block","reason":…}`), feeds `reason` back to the sub-agent as a just-in-time correction, and honours `stop_hook_active` as a one-correction latch. `ticket-leak-gate.mjs` is a complete working template.
- **Ground-truth liveness already exists.** `scripts/harvest-agent.mjs` (FEAT-111) returns FINISHED / RUNNING / STALLED / GONE for a background child from two independent on-disk signals, reading only a bounded tail. `src/server/liveness.ts` (ARCH-001) is the single authority on is-X-alive, with `unknown` as a first-class answer. These are exactly what a park-gate must consult so it blocks ONLY on positive proof of life.
- **The gap:** there is NO single authoritative registry of "the long background runs this lane owns." `dispatch.mjs` writes a transcript + `--meta-out`; `independent-verify.mjs` writes a record dir + `manifest.jsonl`; a background Agent child lands under `…/subagents/agent-<id>.jsonl`. Three places, no index. A hook can enumerate an Agent child's id from the lane's own transcript, but it cannot cheaply discover an OS dispatch child the lane started via Bash.

## Approaches (for the engineer to weigh — not decided here)

### A — A SubagentStop park-gate hook (the structural lever)
Add `scripts/hooks/lane-park-gate.mjs` to the existing `SubagentStop` array. On a sub-agent stop it finds the lane's background children, asks harvest-agent/liveness for each, and emits `{"decision":"block","reason":"a background child of yours is still RUNNING — poll it in the foreground now and harvest its result; do not end your turn"}` **only when something is provably RUNNING**. STALLED / GONE / FINISHED → allow. Any detection error → **fail OPEN** (opposite of the leak-gate: a false block wedges a lane, so FEAT-085's hard-won fail-open philosophy applies, not leak-gate's fail-safe). `stop_hook_active` caps it at one correction, so even a buggy detector costs one extra poll, never a wedge.
- **Buys:** the structural enforcement the text rule cannot give; zero cost on clean turns; reuses a proven, already-wired pattern.
- **Costs / risks:** session-lifecycle / regression-prone (a Stop hook can wedge every lane turn) — needs FEAT-085-grade adversarial + truncated-read verification. Detection of the lane's OWN children is the hard part: clean for an in-process Agent child (its id is in the lane's transcript tool-use records), but it CANNOT see an OS dispatch child without Approach C. Unverified at build time and must be proven: (1) that SubagentStop actually fires when a worker lane parks, and (2) exactly what its `transcript_path` points at.

### B — Never let a worker own a cross-turn child; hand the long run to the orchestrator
The lane returns with a "background this yourself" hand-off; the orchestrator backgrounds it at top level, where the completion-notice re-invocation actually works. This is the ARCH-017-honest framing (a dispatched lane's completion is owned by the harness; a worker's turn-end has no re-invocation, so nesting a cross-turn child in a worker is the root error).
- **Buys:** no new hook, no detection heuristics, no wedge risk.
- **Costs:** it is a workflow/charter change, and the charter says prose rules have already failed — so it only holds if the hook (A) enforces "don't park" and points the lane to this hand-off as the sanctioned exit. Adds an orchestrator round-trip.

### C — An authoritative live-run registry + harvest over OS children (the ARCH-010 foundation)
Have whoever starts a long run (dispatch, independent-verify, a background Agent) record it in ONE place a hook and a resuming lane can read cheaply — closing the three-places-no-index gap above — and extend harvest-agent to grade an OS dispatch child, not only a sub-agent transcript. Then both A's detector and a resuming lane ask one ground-truth source "is anything of mine still alive, and what is its verdict."
- **Buys:** makes A correct and non-wedging for BOTH shapes instead of heuristic for one; the fact "what long runs this lane owns" declared by its owner and read elsewhere (ARCH-010).
- **Costs:** the most build of the three; best as the foundation A sits on rather than a standalone fix.

### D — text-only (rejected)
A sharper WA/charter sentence. BUG-145 and BUG-210 both record that an injected sentence here does not hold. Out on its own; at most the wording of A's corrective `reason`.

## Recommendation

**A, built on C, with B as the sanctioned escape — phased.** The structural lever is the SubagentStop park-gate (A); its correctness depends entirely on a ground-truth liveness signal and the block-only-on-proof-of-life rule, so the "must not hang on a dead child" constraint is priced in by construction (block on RUNNING only; allow on STALLED/GONE/FINISHED; fail open on error; one-correction latch). **Phase 1:** scope the hook to the in-process Agent-child case, where SubagentStop + the lane's own transcript give a clean child-id enumeration and harvest-agent already gives the verdict; its `reason` points a lane whose run genuinely cannot fit a turn to B. **Phase 2:** add C's live-run registry so the OS dispatch case (BUG-210) is covered by the same guard. Verify as session-lifecycle/regression-prone: a must-FAIL reproducing a park, an adversarial suite proving no wedge on a dead/stalled/finished child, truncated-transcript reads (another process is writing the child transcript the hook grades), and an independent clean-room pass.

## Open questions to resolve at build time

- Does SubagentStop fire when a `worker` lane ends its turn parking on a live child, and what does its `transcript_path` point at (the sub-agent's own transcript, needed to enumerate child ids)? Probe before building.
- Can a park-gate distinguish "lane legitimately finished and is returning" from "lane parking mid-work"? Blocking only on a provably-live child is the proposed discriminator; confirm it has no false-positive on a normal clean return.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-01 — agent
- **explore findings:** **Explore (finding, round 1) — structural fix scoped, decision needed.** Confirmed the problem is two shapes of one invariant break (own background Agent sub-agent; separate dispatch/independent-verify OS process). Evidence: WA §C/§I 2026-08-27 (51.6 lost lane-minutes; a child ran ~1h past turn end); BUG-210 (verify-lane instance, ~12h park); the originating orchestrator reports two instances 2026-10-01. Key structural findings: (1) SubagentStop IS a supported hook event and Orchard ALREADY registers one (ticket-leak-gate) in .claude/settings.json — it can BLOCK with a corrective reason and honours stop_hook_active as a one-correction latch, so the block lever and anti-wedge latch both already exist and are proven. (2) Ground-truth liveness already exists: harvest-agent.mjs (FEAT-111, RUNNING/FINISHED/STALLED/GONE from a bounded tail) and liveness.ts (ARCH-001). (3) GAP: no single authoritative registry of the long runs a lane owns — dispatch writes a transcript+meta-out, independent-verify a record dir+manifest, a background Agent child a subagents/agent-<id>.jsonl; three places, no index. A hook can enumerate an Agent child id from the lane's own transcript but cannot cheaply see an OS dispatch child. RECOMMENDATION: Approach A (SubagentStop park-gate hook that blocks ONLY on provably-RUNNING children, fail-OPEN on error, one-correction latch — so a dead child never wedges the lane), Phase 1 scoped to the in-process Agent-child case, built on Approach C (live-run registry) for Phase 2 to cover the OS dispatch case (BUG-210); Approach B (hand the long run to the orchestrator) as the sanctioned escape the hook's reason points to; text-only (D) rejected. Build-time unknowns to probe FIRST: does SubagentStop fire when a worker lane parks, and what does its transcript_path point at. This is session-lifecycle/regression-prone — a build needs FEAT-085-grade adversarial + truncated-read + independent clean-room verification. No code written (explore). DECISION FOR ORCHESTRATOR: approve the phased A+C+B design (vs. folding into BUG-210 or deferring to ARCH-017) before a fixing dispatch.
