```orchard-ticket
{
  "id": "FEAT-042",
  "type": "feature",
  "title": "Session model changes were invisible until someone checked",
  "summary": "The running model is now shown at all times near the session status, and it updates live when the model changes for any reason. A change nobody asked for is called out with a highlight and a transcript line. Clicking the indicator opens the existing model picker.",
  "impact_if_we_wait": "Bounded: this is display and awareness, not data loss or model selection. Without the indicator a provider-side switch mid-session goes unnoticed, and work continues on a model the user did not choose.",
  "current_need": "Nothing is outstanding. The indicator was driven end to end in a real browser, the pre-change case failed without it, and the picker and override suites stayed green.",
  "severity": "medium",
  "area": "Session model indicator",
  "reported": "2026-08-05",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The indicator shows the resolved model as soon as a session launches",
    "Switching the model mid-session updates the indicator without a reload",
    "A model change the user did not choose is highlighted and written to the transcript",
    "Clicking the indicator opens the existing model picker rather than a new surface",
    "The check fails when the indicator is absent"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-021",
      "relation": "depends_on"
    },
    {
      "id": "BUG-026",
      "relation": "depends_on"
    },
    {
      "id": "BUG-084",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
      "relation": "see_also"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    },
    {
      "id": "FEAT-051",
      "relation": "see_also"
    },
    {
      "id": "FEAT-054",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-042-always-visible-model-indicator.md",
    "sha256": "6c559ec846930897806f1656cd163dad69e39305b19834563bb29e822942862e",
    "bytes": 9885,
    "original_title": "always-visible live model indicator (catch silent model switches)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the goal, all four requirements, the change-attention behaviour, the per-turn honesty clause and the browser verification bar are present.",
    "dropped": [
      "the verbatim reporter quote, whose substance is in the summary and diagnosis"
    ]
  }
}
```

# FEAT-042 — Session model changes were invisible until someone checked

## Diagnosis

The resolved model was only readable by opening the `/model` picker. The provider can change the model without user action — safeguard downgrades, fallbacks, overload fallbacks — so the client's last pick is not a reliable account of what is running. The indicator therefore had to follow the server-side resolved value, not the client's selection.

## Evidence

Executed suites: `verify:ui` 3/3, `verify:model-picker` 14/14, `verify:overrides` 5/5, `verify:new-session-overrides` 5/5. Typecheck clean. `verify:model-switch` and `verify:model-chip` are named in the ticket as anti-regression targets but no result for them is recorded here.

## Implementation notes

The indicator is a compact chip in the crown area beside FEAT-040's `#sessStatus`, showing the short model form (`fable-5`, `sonnet-5`, `haiku-4.5`). It reads the same effective-config the server emits — BUG-021's resolved value, plus BUG-026's re-emit after a live set-model. Styling follows FEAT-040's affordance treatment: greyscale with moss accent and hairlines, no layout jank on narrow viewports. Clicking opens the existing picker.

If the only available signal is per-turn (each assistant message's model field), the chip updates from that, and the boundary is stated rather than papered over: a session that reconnects can show a model one turn out of date until the next turn arrives.

## Verification plan

Real browser against a real driven session: assert the chip shows the resolved model at launch; perform a live model switch through the BUG-026 path and assert the chip updates without reload; drive a server-side effective-model change and assert both the chip update and the visible flag (highlight plus system line). The spec must fail before the change, when no chip exists. Alongside it: `verify:ui --offline`, typecheck, and the anti-regression suites `verify:model-switch` and `verify:model-picker`.

## Risks

The live-update fidelity depends on what signal the SDK exposes. A per-turn-only signal means the chip is accurate as of the last turn, not continuously.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from user request. Queued behind BUG-028 (holds app.js); dispatch when it frees. The
  per-turn assistant-message model field is likely the only trustworthy switch signal — the fix
  agent must confirm what the SDK actually emits rather than assume a dedicated event exists.

### 2026-08-05 — build + verify agent (FEAT-042) — VERIFIED

**The switch signals, CONFIRMED against the installed SDK (not assumed).** Read
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` end to end for model-bearing shapes:

1. **A dedicated push signal DOES exist** — `SDKModelRefusalFallbackMessage`
   (`type:'system'`, `subtype:'model_refusal_fallback'`, carrying `original_model`,
   `fallback_model`, `api_refusal_category`): "the primary model ends the stream with
   stop_reason 'refusal' and the turn is retried once on a fallback model with the swap
   made PERSISTENT for the session." This is byte-for-byte the "anthropic auto-switches on a
   safeguard" case the user filed this for. The bridge's `#handleSystem` default-dropped it.
   Sibling `model_refusal_no_fallback` (refused, nothing ran, model unchanged) also existed
   and was dropped.
2. **The per-turn field is real** — every SDK `assistant` frame's `message.model` is the wire
   id that actually produced it (`jsonl.ts:110` already persists exactly this field to
   transcript reads, confirming the transcript path carries per-turn model). The bridge
   dropped it live.

**DETECTION BOUNDARY (stated honestly):** a refusal-triggered fallback is caught the moment
the CLI announces it (dedicated signal, mid-turn). EVERY OTHER provider-side switch is only
observable per-turn — it becomes visible when the new model first produces a main-thread
assistant message, never earlier; a switch during a turn that yields no main-thread assistant
message is invisible until the next one, and an alias remap that resolves to the SAME wire id
is (correctly) not a change. Subagent frames are deliberately excluded — subagents
legitimately run different models than the main thread.

**Changed:**
- `src/server/events.ts` (~line 194): two new StationEvents — `model-observed` (deduped
  per-turn wire id, main thread only) and `model-changed` (refusal fallback, `from`/`to`/
  `category`).
- `src/server/agent-bridge.ts`: `#lastWireModel` field (~line 371); `assistant` case emits
  `model-observed` when the main-thread `message.model` changes (skips `<synthetic>` frames,
  ~line 1272); `#handleSystem` gains `model_refusal_fallback` (emit `model-changed` + fold
  into `#applyModel` so the effective config re-emits and every surface agrees) and
  `model_refusal_no_fallback` (honest non-fatal error line) (~line 1508).
- `public/index.html`: `#modelChip` button beside FEAT-040's `#sessStatus` in the crown.
- `public/styles.css` (~line 385): `.model-chip` — hairline, mono, greyscale; moss glyph when
  the value is the running session's own report (`data-live`); `data-flag` = moss pulse ×3 +
  a tinted hairline that STAYS until clicked (catchable even if the pulse was missed);
  ellipsized `max-width:min(180px,42vw)` so a wire id can never jank a narrow viewport;
  `.ran-lbl.model-change` transcript-line accent.
- `public/app.js`: `liveWireModel`/`expectedLiveModel` (~line 370) — the session's live report
  vs what the user chose/launched with; `paintModelChip` / `shortModelName` / `sameModel` /
  `flagModelChange` / `clearModelFlag` (after `paintModelBtn`, ~line 5560). Wired: crown paint,
  `effective-config`, `session-init` (baseline = the CLI's own launch pick), `finishModel`
  (a CONFIRMED user switch becomes the new expectation — never flags), `closeSocket` (reset),
  new `model-observed`/`model-changed` handlers (~line 4790: mismatch vs expectation = silent
  switch → flag once + transcript "model changed: X → Y" line + status line; null expectation
  or pending user switch adopts WITHOUT flagging — a false "silent switch!" alarm is the one
  failure mode this feature must never have). Chip click acknowledges the flag and opens the
  EXISTING `/model` picker anchored at the chip. `sameModel` accepts alias⊂wire containment
  ('sonnet' vs 'claude-sonnet-5-20250929') so a user's own confirmed switch can never
  false-flag when no picker row joins the two spellings.
- `package.json`: `"verify:model-chip": "playwright test scripts/qa/FEAT-042-model-chip.spec.ts"`.

**Verified (real browser, real driven haiku session, scratch server on a free port, killed by
pid, :4317 never touched):**
- `npm run verify:model-chip` (new spec) — **PASS**. One journey: chip visible pre-launch with
  the resolved default; after a REAL turn it carries the CLI's own wire id (`session-init`) with
  the live treatment, unflagged; chip click opens the existing picker; a live `/model` switch to
  sonnet updates the chip WITHOUT reload and does NOT flag; a second REAL turn proves the
  per-turn path end to end (the chip's live report becomes the sonnet WIRE id purely via the
  bridge's `model-observed` — session-init cannot re-fire — still unflagged); an injected
  `model-changed` (refusal fallback — a genuine safeguard refusal cannot be triggered on
  demand without shipping a jailbreak, so the two not-user-initiated shapes go through the real
  client event contract `window.__station.onEvent`, the same seam BUG-021's verify used) flags
  the chip + appends the transcript "model changed: sonnet-5 → haiku-4-5 (refusal fallback ·
  cyber)" line; clicking acknowledges; a mismatching `model-observed` flags again; a REPEAT of
  the same wire id does not double-flag/double-line.
- **Non-vacuity proven:** git-stashed the five fix files (spec kept) → the spec **FAILS** at its
  first assertion (`#modelChip` not found — the element did not exist at all pre-change). Restored.
- Anti-regression: `verify:model-switch` (BUG-026) PASS 24.9s; `verify:model-picker` (BUG-021)
  14/14; `verify:ui -- --offline` 3/3; `verify:overrides` 5/5; `verify:new-session-overrides`
  5/5; `npm run typecheck` clean; `node --check public/app.js` clean.
- FEAT-040 spec (this change touches the crown): failed twice post-change, which forced a real
  investigation — pre-change baseline (stash) PASSED once, then POST-change it passed 3/3
  consecutive runs (19.5s/19.7s/20.5s). The two failures were the spec's 20s idle-poll racing a
  slow reattached "continue" turn (state honestly `thinking`/`streaming` — the turn genuinely
  still running; a client wedge from this change would fail deterministically, and the chip
  code is not on that turn's event path when the model does not change). Conclusion: pre-existing
  latency flake in that spec's tightest poll, not a regression — left as-is (not this ticket's
  file to loosen).
- Screens: `docs/bugs/assets/FEAT-042-chip.png` (live chip, unflagged),
  `docs/bugs/assets/FEAT-042-flagged.png` (flagged chip + transcript line + status line).

**Open:** none for the stated scope. Handoffs if anyone extends this: (1) the `model_refusal_
fallback` server mapping is exercised by typecheck + shape-faithful injection, not a live
refusal — if a harmless deterministic refusal trigger ever exists, add it to the spec; (2) the
chip trusts `session-init`/per-turn reports, so a reattach before any new turn shows the
effective-config value (alias) rather than a wire id until the model next speaks — honest, but
a server-side `#lastWireModel` replay on reattach could close it (one field on the `start` ack).
