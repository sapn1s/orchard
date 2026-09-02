```orchard-ticket
{
  "id": "FEAT-120",
  "type": "feature",
  "title": "Hitting a provider limit strands the conversation on that engine",
  "summary": "When a session hits its usage window the conversation stalls with no way to continue on the other provider. The build is a cross-provider conversation handoff: seed the target's first turn from the uniform transcript both engines project into — human turns and assistant text answers, tool activity summarised not replayed — as a new session linked to the parent.",
  "impact_if_we_wait": "A blocked provider means the thread is abandoned mid-work: the user re-types the context by hand into the other engine. This recurs on every window hit. Nothing is corrupted while we wait — a missing capability, not a defect — but each block is a conversation reconstructed or lost.",
  "current_need": "A build lane once the Anthropic window resets. The design, asymmetries, seeding mechanism, identity decision and proof bar are below. One product fork sits in Diagnosis (gate to after-reset-only, or offer on demand); the recommended default lets building proceed.",
  "severity": "medium",
  "area": "runtime / session store / bridge",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A pure readUniformSession yields the existing uniform entry shape for both a Claude-store session and an Orchard-owned Codex transcript, no new format, no forked reader.",
    "A pure handoff-seed builder turns uniform entries into a first-turn string in mode replay-text (deterministic) or summary (injected summariser), never the system prompt.",
    "Every human turn and every assistant text answer appears in the seed in order; no tool_use or tool_result is presented as executed state.",
    "The seed carries an explicit lost-context notice listing what did not carry over (reasoning, tool state, subagents, attachments), shown on the continued session's first render.",
    "The continued session is a new session with the target engine's own id, linked to the parent by write-once provenance (continuedFrom).",
    "Truncated-source safety: a source transcript truncated mid-write yields a digest that never presents a half-written turn as complete.",
    "Proven against the user's REAL Claude session and a REAL Codex rollout (read-only), not only a synthetic fixture."
  ],
  "code_refs": [
    { "path": "src/server/runtime/runtime.ts" },
    { "path": "src/server/runtime/codex-runtime.ts" },
    { "path": "src/server/codex-native.ts" },
    { "path": "src/server/orchard-transcripts.ts" },
    { "path": "src/server/transcript.ts" },
    { "path": "src/server/jsonl.ts" },
    { "path": "src/server/fork.ts" },
    { "path": "src/lib/session-provenance.mjs" }
  ],
  "related": [
    { "id": "FEAT-102", "relation": "see_also" },
    { "id": "BUG-165", "relation": "see_also" }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format; no legacy original.",
    "dropped": []
  }
}
```

# FEAT-120 — Hitting a provider limit means losing the conversation instead of finishing it on the other engine

> User request (verbatim): *"btw rn i'd want to switch to codex, but can't. we should probably centralize sessions, but after usage reset so that one can't continue another's? implement simply parsing into uniform and then ya u get the idea"*

## Diagnosis

### The key realisation: the uniform representation ALREADY EXISTS as the read model

The "parse into uniform" the user asks for is largely built. The Orchard transcript entry shape —

```
{ type:'user'|'assistant', uuid, parentUuid, timestamp, sessionId, cwd, provider,
  message:{ role, content:[ blocks ] } }        // blocks: text | thinking | tool_use | tool_result
```

— is Claude's native `.jsonl` shape (`jsonl.ts#toMessage` consumes it), and BOTH Codex paths already project INTO it:
- live Codex sessions: `orchard-transcripts.ts#TranscriptRecorder.recordRuntimeMessage`;
- native Codex rollouts: `codex-native.ts#translateItem` (maps `function_call`/`local_shell_call` → `tool_use`, `function_call_output` → `tool_result`, `reasoning` → an EMPTY `thinking`, message text → `text`).

So reading, history render, listing and within-provider resume are one coordinate system today. **The gap is not parsing. It is SEEDING a new session on the OTHER engine from that uniform transcript.**

### The asymmetries — things on one side with no faithful counterpart (this is the whole difficulty)

1. **Private reasoning.** Claude extended-thinking blocks carry reasoning text and a cryptographic `signature` (provider-bound). Codex reasoning is opaque — Orchard already records it as empty `thinking`. So reasoning crosses neither direction: Claude→Codex it must be dropped (the signature is unusable off-engine), Codex→Claude there is nothing to carry.
2. **Tool-call history is engine-private.** Tool NAMES differ (Claude Read/Edit/Bash/Task vs Codex shell/apply_patch/`local_shell`), id namespaces differ (`toolu_*` vs `call_*`), and a `tool_use` block is only valid paired with a `tool_result` the SAME engine produced. Handing engine B a `tool_use` naming engine A's tool plus a replayed result is a lie: B never ran it and may not even have that tool.
3. **Subagents.** Claude sidechains (a `parent_tool_use_id` tree of full sub-transcripts) vs Codex collab-agent threads (`collabAgentToolCall`/`subAgentActivity`/sub-thread `thread/started`). Structurally different; neither engine can adopt the other's subagent records as live work.
4. **Branch structure.** Claude entries form a `parentUuid` TREE (forks, sidechains); Codex rollouts are linear. Fork/branch history exists on the Claude side only.
5. **Resume handle & store layout.** Claude: a uuid `sessionId` in a cwd-keyed store. Codex: a `thread` id in a DATE-keyed store (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`). Each engine can resume ONLY its own handle (`codex-runtime.ts` `thread/resume`|`thread/fork`; Claude CLI `--resume`). Neither can resume the other's — this is why "continue" cannot mean literal resume.
6. **Cost.** Claude reports `total_cost_usd` (`structuredCost:true`); Codex reports tokens only (`thread/tokenUsage/updated`, no cost). A chained cost view sums two different currencies.
7. **System/instruction layer.** Claude accepts `Options.systemPrompt` (preset+append) and per-session `mcpServers`; Codex has NO per-session mcpConfig (`config.toml`) and injects instruction context as `<environment_context>`/`<user_instructions>`/`<skills_instructions>`/`<multi_agent_mode>` user-role wrappers. `planMode` is Claude-only. The "system" layer is provider-shaped and not portable.

### What "continue" can honestly mean

Full-fidelity replay is impossible (items 1,2,3,5). The honest deliverable is a **conversation handoff**: the target engine is seeded with the prior CONVERSATION — human turns plus the assistant's TEXTUAL answers — and a SUMMARY of tool activity/outcomes, NOT re-executed tool state. **What is lost, stated to the user, not hidden:**
- the model's private reasoning (never portable);
- exact tool invocations and their results — narrated as a summary, not re-run; anything the assistant "knew" only from a tool result must be RE-DERIVED (re-read the file, re-run the command). This is correct anyway: a replayed tool result can be stale, whereas the new engine re-establishes ground truth against the real repo;
- subagent internals collapse to "N subagents did X";
- attachments/images need re-attachment (the two dialects carry them differently).

This is useful and honest: the user carries the thread of thought across; the new engine re-grounds itself on the live tree.

### The product-direction fork (named, one sentence)

**Should the handoff be OFFERED only after the source provider's usage window has reset (the user's "after usage reset"), making it a limit-recovery escape hatch, or on demand any time, making it a general provider-switch feature?** — decided by whether the user wants cross-provider switching as a first-class everyday workflow or strictly as a fallback when blocked. It changes ONE guard on the "Continue on other provider" action (wire step 4), not the build shape. Recommended default to let the build proceed: **on demand**, with the source provider's `ProviderError.resetsAt` (already surfaced) shown as advice — the strictly-gated variant is a one-line predicate added later if the user picks it. (The user's phrase "so that one can't continue another's" is read as the IDENTITY rule below — a continued session is a new linked session, never a masquerade of the other engine's id — not as a hard time-gate; confirm on review.)

## Evidence

Read directly, this lane (read-only):
- `codex-native.ts#translateItem` / `readRolloutHead` — the native Codex rollout schema and its existing projection into the uniform entry (including `reasoning`→empty `thinking`, `<...>` wrapper skipping).
- `orchard-transcripts.ts` — `TranscriptRecorder` writes the SAME entry shape under `dataDir()/transcripts/<provider>/<encodedDir>/<sessionId>.jsonl`; every history reader takes a `{root}` option, so listing/resolve/live-detect reuse the Claude-store paths unchanged.
- `transcript.ts` — `tailMessages`/`readForward`/`countMessages`: one canonical renderable space over the uniform entries; malformed/partial trailing lines already skipped (basis for the truncation proof).
- `codex-runtime.ts` lines ~281-289 — Codex `thread/fork` works on the wire but the STATION path REFUSES codex forks precisely because "the fork's new thread would need its Orchard transcript seeded with ancestor history (P2b follow-up)". That is this ticket, generalised across providers.
- `runtime.ts` — capability flags (`persistedTranscript`, `structuredCost`, `fork`, `planMode`, `mcpConfig`, `permissionModeMidTurn`) already encode the asymmetries; `RuntimeStartConfig.firstPrompt` is the seed carrier.
- `session-provenance.mjs` — write-once per-session records (`startedBy`, `source`, `at`); the natural home for the parent link.
- `fork.ts` — the WITHIN-Claude fork (stage a copy, let the CLI replay). Instructive but NOT reusable across providers: it relies on the Claude CLI replaying its own `.jsonl`; the target engine here is different, so we seed via a first-turn preamble, not a staged replay file.

## Implementation notes

Deliberately small, pure-first, additive.

- **`readUniformSession(encodedDir, sessionId) -> UniformEntry[]`** — a thin formaliser over what exists: resolve the source in the Claude store OR via `resolveOrchardSessionFile`, yield the canonical uniform entries. No new format, no behaviour change.
- **`buildHandoffSeed(entries, { mode, summarise }) -> { seed, lostContext }`** — pure. `mode:'replay-text'` (default under a size threshold): deterministic, emits human turns + assistant text answers in order, tool activity as one-line summaries, no model call — fully testable offline. `mode:'summary'`: for long sources (Claude sessions reach 286 MB), calls an INJECTED summariser. Always appends the explicit lost-context notice. The seed is wrapped so the target treats it as CONTEXT, not the user's live instruction (mirroring Codex's own `<...>` wrappers / Claude's append), and states "you are continuing a prior session; tool state is NOT carried — re-derive from the repo".
- **Seeding rides the FIRST TURN** (`RuntimeStartConfig.firstPrompt`), never the system prompt — BUG-165 proved volatile content in the system prompt busts the provider prompt cache. This is why literal resume is not needed and not possible: we START a normal new session whose first turn is the seed.
- **Identity / provenance link.** The continued session is a NEW session with the target engine's own id (engine stores are provider/cwd/date-keyed; resume handles are engine-private — a target CANNOT adopt the source id, and doing so would let one engine's history masquerade as the other's, exactly the "one can't continue another's" the user flagged). Extend `session-provenance` (server `.ts` + `.mjs` mirror, kept in lockstep by `verify-session-provenance.mjs`) with a write-once `continuedFrom: { sessionId, provider }` and `handoffMode`. The picker badges "continued from <source>"; the board/cost view chains parent→child.
- **UI.** A "Continue on <other provider>" action on a session that starts the new session with `firstPrompt=seed`, records the provenance link, and renders a one-line "what did NOT carry over" disclosure on the continued session's first paint. The source `ProviderError.resetsAt` (already surfaced on quota-window errors) is shown as advice.

## Verification plan

- **Conversation fidelity (real artifact):** seed a Codex session from the user's REAL Claude session's uniform entries — assert every human turn and every assistant TEXT answer appears in order in the seed; assert NO `tool_use`/`tool_result` is presented as executed state. Reverse direction from a REAL Codex rollout.
- **Lost-context notice:** present and enumerates reasoning, tool results/state, subagents, attachments.
- **Truncation safety (concurrent writer):** take the real source transcript, truncate at several plausible byte points, build the seed at each — no half-written turn is ever presented as complete.
- **Cache guard (BUG-165 regression):** assert the seed is delivered as the first turn and the system prompt is unchanged by session content.
- **Provenance:** `continuedFrom` is write-once (a re-record cannot flip it) and survives; the cost view sums across the link.
- **Anti-regression:** `verify:codex-runtime`, the transcript/paging suites, and `verify-session-provenance.mjs` (the `.ts`/`.mjs` lockstep) all green.
- **High-stakes note:** touches session lifecycle + provenance (regression-prone) — an independent clean-room verify pass is warranted before VERIFIED; generation must not be its own only verifier.

## Migration and rollback

Landable, additive steps — each is inert until the next lands:
1. `readUniformSession` (pure reader; no wiring). 
2. `buildHandoffSeed` (pure; `replay-text` deterministic, summariser injected). 
3. `session-provenance` `continuedFrom` field (`.ts` + `.mjs`, lockstep test). 
4. Wire the "Continue on other provider" action: start a new session with `firstPrompt=seed`, record the link. The fork's gate (on-demand vs after-reset-only) is a one-line predicate here. 
5. UI: picker badge + first-render lost-context disclosure.
Rollback: steps 1-3 are pure/additive and dormant without 4; removing the action reverts the feature with the readers left harmless.

## Risks

- **Silent context loss** — the whole failure mode the design guards against; the lost-context notice must be prominent, not a footnote, or the handoff is worse than none.
- **Long-source cost/context** — a 286 MB Claude source overflows any target context in `replay-text`; the `summary` mode and size threshold must be the default above the threshold, and the summariser call itself costs budget.
- **Provenance flip** — must be write-once (proven), or a mislink corrupts cost chaining.
- **Cache bust** — seeding via system prompt would reintroduce BUG-165; the first-turn rule is load-bearing and must be asserted.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — agent (design + file; build deferred by the window constraint)
- **Understood:** the user wants to continue an existing conversation on the other provider after a limit; "parse into uniform" is mostly already built (the Orchard entry shape both engines project into).
- **Established (read-only):** the seven asymmetries above from `codex-native.ts`, `orchard-transcripts.ts`, `transcript.ts`, `codex-runtime.ts`, `runtime.ts`, `session-provenance.mjs`, `fork.ts`; that a faithful conversation handoff (tools summarised, reasoning dropped) is the only honest deliverable; that seeding must ride the first turn (BUG-165); that the continued session must be a NEW linked session, never a same-id masquerade.
- **Changed:** filed this ticket only. No code. Nothing staged.
- **Still open / handoff:** build after the Anthropic window resets, in the five migration steps above. Resolve the one product fork (on-demand vs after-reset-only gate) on review — recommended on-demand. Build lane should verify against the user's REAL Claude session and a REAL Codex rollout, and truncate the source at several points.
