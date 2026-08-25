# FEAT-042 — always-visible live model indicator (catch silent model switches)

- **Status:** VERIFIED
- **Area:** claude-station UI (+ server signal if needed)
- **Reported:** 2026-08-05 by user ("currently we see model only via /model … anthropic loves to
  auto switch when encountering some safeguards etc and i may miss, but if immediately visible
  its better to catch")

## Goal
The session's CURRENT resolved model is visible at a glance at all times (crown area, near
FEAT-040's #sessStatus) — not only inside the /model picker. Because the provider can switch the
model WITHOUT user action (safeguard downgrades, fallbacks, overloads), the indicator must
track the LIVE server-side resolved value, not the client's last pick.

## Requirements
- Always-visible compact chip/label showing the resolved model (short form, e.g. "fable-5" /
  "sonnet-5" / "haiku-4.5"), sourced from the same effective-config the server emits (BUG-021's
  resolved value + BUG-026's re-emits after a live set-model).
- LIVE-UPDATING: if the effective model changes mid-session for ANY reason (user /model switch,
  server-side auto-switch), the chip updates without a reload. If the SDK/CLI exposes a
  model-changed or per-turn model signal, wire it; if the only signal is per-turn (e.g. each
  assistant message's model field), update from that and note the boundary honestly in the ticket.
- CHANGE ATTENTION: when the model CHANGES to something other than what the user chose/launched
  with, make it noticeable (brief highlight/pulse + a transcript system line like "model changed:
  fable-5 → sonnet-5"), so a silent downgrade is caught — that is the point of this feature.
- Clicking the chip opens the existing /model picker (no new surface). Greyscale + moss accent,
  hairlines — match FEAT-040's affordance styling. No layout jank on narrow viewports.

## Verification (REQUIRED, user-observable)
Real browser + real driven session: chip shows the resolved model at launch; a live /model switch
(BUG-026 path) updates the chip without reload; simulate/drive a server-side effective-model
change and assert the chip updates + the change is visibly flagged (highlight + system line).
Must FAIL pre-change (no chip exists). Playwright spec + verify:ui --offline + typecheck +
anti-regression verify:model-switch + verify:model-picker.

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
