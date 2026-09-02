```orchard-ticket
{
  "id": "FEAT-113",
  "type": "feature",
  "title": "Orchestrator auto-compacts near its context limit, guided to preserve working state",
  "summary": "The main orchestrator session rides at full context indefinitely and it is the costliest session — each turn re-reads the whole window. When it nears its context-window limit, Orchard should proactively trigger guided compaction: the orchestrator saves what it deems relevant (decisions, in-flight lane charters, open threads, learned facts, standing instructions) so it resumes from a working state, not blank.",
  "impact_if_we_wait": "The orchestrator stays the costliest session on record — measured at 93.2% of one session's spend going to context maintenance ($1,514 of $1,625), with cost per tool call rising from $0.18 to $0.33 as context grew. Every retained token is re-billed on every subsequent turn.",
  "current_need": "Trigger guided compaction automatically when the orchestrator nears its context-window limit, preserving decisions, lane charters, open threads and standing instructions so it resumes working rather than blank, and dropping post-compact usage to a small fraction of the window.",
  "severity": "medium",
  "area": "Orchestrator context lifecycle / cost",
  "reported": "2026-08-29",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Orchard observes per-session token usage and can tell when the orchestrator's context nears its model-specific window limit.",
    "A configurable per-provider/per-model threshold triggers compaction proactively, before the harness's own overflow summarisation would fire.",
    "Compaction is invoked programmatically for the orchestrator session Orchard drives, carrying a guided-summary instruction.",
    "The guidance preserves decisions made, in-flight lane ids and charters, facts learned, and the user's standing session instructions.",
    "Post-compact context usage drops to a small, measured fraction of the window and the orchestrator resumes from a working state, not blank.",
    "The Claude-side window is read per model; the OpenAI side is documented as unknown rather than guessed."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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

# FEAT-113 — Orchestrator auto-compacts near its context limit, guided to preserve working state

## What this is

The main orchestrator session is, by measurement on this project, the costliest
session by a wide margin: it accumulates context (decisions, lane charters,
findings, standing instructions) and holds it in full for the life of the
session, and every subsequent request re-reads the whole window. So retained
context is billed again on every turn, and unnecessary retention compounds.

The ask: when an orchestrator session approaches its context-window limit,
Orchard **automatically triggers compaction** rather than letting the session
ride at full context indefinitely. The compaction must be **guided** — the
orchestrator is instructed to save what it deems relevant so it resumes from a
working state, not a blank one. Post-compact usage should fall to a small
fraction of the window.

**The delta over what the harness already does.** Context summarisation already
happens automatically at overflow. This ticket is NOT about inventing
compaction. The delta is three things: **chosen timing** (a proactive threshold
we pick, below the hard limit), **chosen guidance** (an explicit instruction on
what to preserve), and **predictable post-compact state** (the orchestrator
comes back knowing its open lanes, decisions and standing instructions).

## Motivation — measured, already on this project's record

- 93.2% of one session's spend was context maintenance: $1,514 of $1,625.
- $444 per Mtok of output produced by the orchestrator, versus $131 for a
  dispatched lane.
- Cost per tool call rose from $0.18 to $0.33 as context grew 312k -> 524k tokens.

These come from the process-cost attribution work already on the board — cite
that when implementing rather than re-measuring from scratch.

## What the engineer will need to establish

- **Where context size is observable.** Does the harness expose token usage per
  session, and at what point does Orchard see it (per-turn event, a field on the
  session record, a query)? This gates everything — the trigger needs a live
  signal.
- **The trigger threshold, per provider/model.** Claude's window differs by
  model (some are ~200k, the `[1m]` variants ~1M). The OpenAI side is **unknown**
  and should be recorded as unknown, not guessed. The threshold is a fraction of
  the model's own window, resolved per session.
- **How compaction is invoked programmatically** for a session Orchard drives,
  and whether a guided-summary instruction can be passed alongside it (i.e. can
  we hand the compaction step our own "preserve these things" prompt, or only
  trigger the default summarisation?).
- **What the guidance must tell the orchestrator to preserve:** decisions made;
  in-flight lane ids and their charters; facts learned about the project; the
  user's standing instructions for the session. The goal is that the post-compact
  orchestrator can keep dispatching and reasoning without re-deriving state.

## Open questions — honestly labelled

- Is **~10% post-compact usage** actually achievable, or is there an irreducible
  floor (system prompt, injected WA/CONVENTIONS, standing instructions)? The
  user's 10% is a guess; measure it, don't promise it.
- What is the **right threshold**? Too low wastes a still-cheap window; too high
  risks hitting the hard limit mid-turn.
- Does **repeated compaction degrade orchestration quality** over a long session
  (lossy summarisation accumulating)? Needs a check that a compacted orchestrator
  still dispatches correctly.
- **Prompt-cache interaction (a real cost trade, not free).** Compacting
  rewrites the context and therefore **invalidates the 1h prompt cache**. The
  next turn pays full input price to re-establish the cache. So compaction is not
  strictly cheaper on every axis — the ticket must weigh the recurring
  re-read saving against the one-time cache-rebuild cost, and pick a threshold
  that nets out ahead, rather than assuming compaction is free.

## Scope note

This is a spec/plan ticket filed at the user's request ("add new ticket only for
now, no work"). No implementation, prototype or new measurement has been done.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-29 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-29 — agent
- **finding r1:** **Finding round 1 — measured cost curve, compaction economics, built-in behaviour, ranked alternatives.** All figures from the real long-lived orchestrator session transcript (the Orchard-driven session, ~Aug 2-29, 3,393 priced requests, top-tier model at $10/Mtok in, $50/Mtok out, 1M window), priced with the corrected cost model (scripts/lib/cost-model.mjs; see docs/analysis/COST-METHOD.md — figures are lower bounds, ~5%/session bias).

  **Headline: the session cost $1,906.72 over ~27 days.** Split: cache reads $952 (49.9%), 1h cache writes $833 (43.7%), output $121 (6.4%), uncached input ~$0. Context maintenance = 93.6%, confirming this ticket's 93.2% figure independently.

  **1. Cost curve WITH caching (mean $/request by context size, real):** <50k $0.05; 50-150k $0.16; 150-250k $0.31; 250-400k $0.42; 400-600k $0.63; 600-800k $0.81; 800k-1M $0.85. Near-linear: ~$0.10 per 100k of context per request on this tier (cache read = 0.1x base input). Caching does NOT make a big window cheap — it makes it 10x cheaper than uncached, and it is still half the bill.

  **2. The harness's built-in auto-compact already beats the ~10% goal.** 7 real auto-compactions measured in this one session: fires at ~1.00M (preTokens 0.997-1.010M), postTokens 9.2k-27.3k = **0.9-2.7% of window**; takes 113-174s; first working request after lands at 37-76k context (summary + re-injected docs/reminders); post-compact cache rebuild costs $0.24-0.87 and the summarisation itself ~$1-2. So the floor and the mechanism are already fine — the ONLY delta this ticket can buy on the cost axis is **timing**, plus guidance quality.

  **3. Compaction economics — proactive timing DOES pay, robustly.** Counterfactual on the real request stream (context cycles floor~65k → threshold T instead of → 1M; extra compactions charged at ~$2 each incl. cache rebuild):
  - T=300k: saves $545 (29%) if full-prefix cache rewrites are NOT scaled down, $1,017 (53%) if they are (they should be — a rewrite of a 300k prefix costs 3.3x less than 1M). Honest range: **$0.5k-1.0k/month at T≈300k**.
  - T=200k: $609-1,162 (32-61%). T=400k: $477-886. T=600k: $326-614.
  - Compaction overhead is noise: $1.7-2.1 each, 13-42 extra/month = $25-70, already netted.
  NOT modelled: cost/quality of re-deriving lost context. 7 built-in compactions already happened in this session without recorded catastrophe, which bounds the fear somewhat.

  **4. A second, unrequested finding — cache-miss anatomy is a comparable lever.** Of the $833 write spend, **$746 is 117 full-prefix rewrites (>100k tokens each)**. The provider's own `diagnostics.cache_miss_reason` (recorded in the transcript) attributes them: `system_changed` 49x $318; `previous_message_not_found` (TTL expiry/eviction, matches >55min idle gaps) 46x $294; `model_changed` 15x $79; `messages_changed` 4x $36; `tools_changed` 3x $19. So ~**$400/month is system-prompt churn + mid-session model switches** — avoidable with zero compaction work (stabilise whatever mutates the system block mid-session; never flip model inside a session). The TTL $294 could be mostly recovered by an idle keepalive ping (~$0.5-1 per ping vs $10-20 per full-window rewrite) — or by accepting it. These stack multiplicatively with a lower context cap.

  **5. Mechanism, verified empirically** (isolated scratch store via CLAUDE_CONFIG_DIR, tiny-model session, cost <$0.10): `claude -p --resume <sid> "/compact <guidance>"` works headlessly; the transcript records `compact_boundary` with `trigger:"manual"`, preTokens/postTokens, and the guided summary; the resumed session answered from preserved facts. **Caveat measured, not guessed:** the guidance is advisory over the CLI's fixed summary template — an instruction to DROP specific facts was only partially honoured (they still surfaced inside the template's file-list section). Guidance shapes emphasis; it does not guarantee exclusion. The continuation prompt also embeds the full-transcript path, so a resumed session can recover detail on demand. Live context signal exists: per-request usage in the session transcript (input + cache_read + cache_creation ≈ window), readable per turn; `compactMetadata` gives exact pre/post after the fact. OpenAI side: not examined, remains unknown.

  **6. Window composition (final epoch, ~278k, bytes/4 approximation):** task-notifications + other user-side ~118k (single largest item: one 8k-token lane report notification), dispatch charters (tool_use inputs) ~79k, assistant text+thinking ~81k, misc tool results ~23k. The dispatch loop IS the window; trimming reports/charters slows growth maybe 30-40% but they are also the orchestrator's working material — prevention alone cannot substitute for a reset policy.

  **Ranked by measured impact on this $1,907/month session:**
  1. **Cheaper model tier for the orchestrator** — top tier is 2x Opus tier; same tokens on Opus ≈ **-$950/month**, on Sonnet ≈ -$1,300 (post-Sept rates). Zero mechanism work; the routing-ladder question is whether dispatch-and-relay needs the top tier. (Per-session choice — mid-session switches cause the $79 `model_changed` misses.)
  2. **Context-reset policy at ~300k** — $545-1,017/month. Fresh-session-with-written-handoff is economically equivalent to guided compact (same floor, clean cache restart) and strictly better on control: the handoff is authored, not filtered through an advisory template. Guided `/compact` is proven and cheaper to automate (one command, no session re-registration).
  3. **Cache-miss elimination** — ~$400/month (system churn + model flips), plus up to $294 TTL, orthogonal to 1 and 2.
  4. **Growth trimming (notifications/charters)** — bounded, worthwhile only after the above.

  **Recommendation:** do not build auto-compact machinery first. Order: (a) decide the orchestrator's model tier — largest lever, no code; (b) root-cause and stop the mid-session `system_changed` cache kills — bug-shaped $318; (c) then adopt the ~300k reset policy, preferring a fresh session with a written handoff (the working agreement already prescribes handoffs) with the proven manual `/compact <guidance>` as the automated fallback. The ticket's ~10% post-compact goal needs no work: built-in compaction already lands at 0.9-2.7% + ~4-7% re-injected docs. Error bars: composition is a bytes/4 estimate; counterfactual assumes no re-derivation cost and epoch-linear growth; all transcript dollars are lower bounds. Total investigation spend: <$0.10 of model calls (one tiny-model probe); the rest was local computation over existing transcripts.
