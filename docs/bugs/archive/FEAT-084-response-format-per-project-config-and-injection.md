# FEAT-084 — response-format: agent-awareness injection + per-project override (close the FEAT-083 gap)

- **Status:** VERIFIED — Option A built + verified (2026-08-18 worker). See worker log below.
- **Area:** src/server/templates.ts (composeInstructions) + agent-bridge.ts (launch) + registry.ts + validate.ts + public/lib/drawer.js
- **Reported:** 2026-08-14 by user (make the response-digest a per-project-configurable system for ANY Orchard project)

## In plain terms
Orchard can format an agent's replies into a tidy structured summary. The parts that read and display that
format were already built — but the piece that actually TELLS each session to produce it was missing, so it
only worked when the agent happened to remember, and no other project got it automatically.

**This is now built and verified (2026-08-18).** Every session is now told to produce the format as part of
its setup, there's one simple per-project text box for tweaking the style, and the format itself stays fixed
and checked so it can't be corrupted. Turning it off for a project is a single flag.

**Why it mattered:** without this the feature was effectively off for everyone except by luck, and couldn't be
adjusted per project — which was the whole point of making it a reusable system.

**Proof it works:** 37/37 targeted checks plus the full anti-regression suite pass, including a byte-for-byte
proof that a project with the format DISABLED gets exactly the same prompt as before (so it can't disturb
existing sessions). Full detail in the 2026-08-18 worker log below. Takes effect on the next session started;
no server restart needed.

**Nothing needed from you** — an independent clean-room re-verify and a visual review of the new per-project
toggle are the sensible next steps before this is fully trusted (flagged in the worker log).

## Key finding (reframes the task)
FEAT-083 shipped the parser/renderer, the `responseDigest.enabled` opt-out, and a convention doc
(`docs/prompts/RESPONSE_FORMAT.md`) — but **nothing injects the format instruction into sessions.**
`composeInstructions` folds WA → local conventions → routing; it does NOT fold a response-format
section. So today the digest only works because the agent emits it by convention/memory; no other
project (or user) gets it automatically, and the doc is inert. Closing that gap is the load-bearing
work here.

## Recommendation (Option A — lead)
Reuse the routing-injection pattern verbatim; add exactly ONE new knob (free-text `guidance`); keep the
digest schema fixed + validated; defer any dynamic-component protocol.
1. **Awareness:** new `responseFormatSection()` in templates.ts (mirrors `routingSection()`), folded LAST
   in `composeInstructions`, gated on the project's `responseDigest.enabled` (same flag the renderer
   reads → disabled ⇒ neither instruct nor parse, zero wasted tokens). `RESPONSE_FORMAT.md` gains
   `<!-- response-format-inject:start/end -->` markers; only the condensed core (~1 KB) is injected.
2. **Config:** extend `ResponseDigestSettings` to `{ enabled: boolean, guidance?: string | null }`.
   `guidance` is a short project-local nudge (verbosity/detail/style/when-to-emit) appended under a
   `## Project override` subhead in the injected section. Length-capped (~600) + control-char-rejected.
3. **Two edit paths:** a drawer toggle-group (+ optional `guidance` textarea), and NL→agent PATCHes
   `/api/projects/:id` `{settings:{responseDigest:{guidance,enabled}}}` (validator whitelists `guidance`;
   the one-level merge already preserves siblings; malformed PATCH rejected, not silently landed).
4. **Zero-config default:** fresh project `{enabled:true}` → format on both sides. Disable = one flag,
   both sides. Backward-compatible (old registries read `guidance:undefined`).

### Rejected (challenge over-configuration — for a tool many people use)
- Typed `verbosity`/`kinds`/`emitPolicy` knobs — validate a matrix the renderer never consumes; `kinds`
  invites renderer scope creep. `guidance` free-text is strictly more expressive and drops out of the NL
  path for free.
- Dynamic agent-generated-component protocol — large XSS/render surface AND breaks the data-loss
  fallback (no clean "fall back to prose" for arbitrary components). Flagged as separate future work with
  its own sanitization + fallback contract.

## Data-loss safety
`guidance` can only steer tone/verbosity — it cannot change the fixed JSON schema, fence name, kind set,
or the fail-closed fallback (FEAT-083, verified 22/22 + adversarial 170/170). It's itself validated so it
can't corrupt the injected prompt or registry JSON. Injection + rendering read the SAME `enabled` flag →
the two sides can't disagree and strand content.

## Verification (§C) — on build
- Injection present in the composed prompt when enabled; ABSENT (byte-identical to no-opt) when disabled
  or no guidance; `guidance` text appears under the override subhead when set. Reuse the routingSection
  test shape. Drawer toggle + textarea round-trip through PATCH; NL-style PATCH with only `guidance`
  keeps `enabled`. Anti-regress: verify:feat-083 (+adversarial), verify:routing-inject,
  verify:local-conventions, verify:sessions, verify:ui, typecheck, leak-gate.
- Risk bucket: touches composeInstructions (every session's system prompt) → moderate; verify the
  disabled/empty path is byte-identical so it can't perturb existing sessions.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user's clarification (per-project-configurable, for anyone using Orchard). Read-only Opus-5
  design pass; key finding = the agent-awareness injection was never built (FEAT-083 gap). Recommendation
  Option A: reuse routing injection + one `guidance` knob, reject typed knobs + component protocol.
  Awaiting user sign-off before build (touches the per-session system-prompt path).

### 2026-08-18 — worker (build + verify, Option A)
User approved Option A. Built and verified. Status → VERIFIED.

**Mirror finding (asked first, per charter):** `docs/prompts/RESPONSE_FORMAT.md` is NOT a mirror.
The methodology canonical repo (`~/projects/methodology/`) holds only WORKING_AGREEMENT{,.v2}.md +
ROUTING.md + CHANGELOG/README, and `scripts/sync-methodology.mjs` FILES syncs only the WA + ROUTING.
RESPONSE_FORMAT.md is a project-local doc → edited directly here (no canonical to sync).

**Fix map (my lane only):**
- `docs/prompts/RESPONSE_FORMAT.md` — added `<!-- response-format-inject:start/end -->` around a NEW
  condensed agent-facing core (~1.1 KB: the envelope rules only). Full doc stays human documentation;
  only the marked region is injected.
- `src/server/templates.ts` — new `responseFormatSection({filePath,guidance,maxChars})` mirroring
  `routingSection()` exactly (marker-core extraction, header pointing at the full doc, length cap,
  `null` on absent/empty/unmarked→degrade-to-capped-body). `composeInstructions` gains a
  `responseFormat?: boolean | string | {guidance?,filePath?}` option, folded LAST (WA → local
  conventions → routing → response-format). `guidance` (non-empty) appended under a `## Project
  override` subhead inside the section.
- `src/server/registry.ts` — `ResponseDigestSettings` extended to `{enabled, guidance?}`. The
  existing one-level merge (`{...defaults, ...cur, ...patch}`) already preserves siblings; verified.
- `src/server/validate.ts` — whitelisted `guidance`: string|null, trimmed, ≤600 chars, control-chars
  rejected (tab/newline allowed for multi-line nudges), empty→null. Unknown sub-keys still hard-error.
- `src/server/agent-bridge.ts` (launch site ~562) — `responseDigestOf(project)` resolved; passes
  `responseFormat: enabled ? {guidance} : false`. Injection gated on the SAME `enabled` flag the
  renderer reads → digest-off project is neither instructed nor parsed, zero wasted tokens.
- `public/lib/drawer.js` — new `responseFormatGroup` in the Instructions & tools section: enable
  toggle (default ON) +, when on, a `guidance` textarea with live char count (≤600). Saves the
  resolved full `{enabled,guidance}` object through the existing `patchProject` path (BUG-088
  echo-check reason). Project-scope only (shapes every session's prompt; not a per-session override).
- `scripts/verify-feat-084-response-format-inject.mjs` (+ `package.json` `verify:feat-084`).

**Byte-identity proof (the named risk — PROVEN not asserted), both directions:**
- direction 1 (safety): `composeInstructions(refs,{routing:true, responseFormat:false})` and
  `{routing:true}` (no opt) and `{...responseFormat:{filePath:<missing>}}` are ALL byte-identical to
  the launch-shaped base `appendOf(systemPrompt)`, and none add the `response-format` applied id.
- direction 2 (MUST-FAIL guard against a vacuous pass): the ENABLED output DIFFERS from base
  (`enabledAppend !== baseAppend && longer`) — so the identity checks can't pass on a no-op injection.
- guidance: present under `## Project override` only when non-empty; empty/whitespace guidance yields
  a section STRICTLY EQUAL to the no-guidance section; null → no subhead.

**Counts (all foreground, must-FAIL guards included):**
- verify:feat-084 — 37/37 (isolation extraction, absent/empty/degraded/capped, guidance subhead,
  byte-identity both directions, realistic 4-layer launch state w/ CONVENTIONS.md, real committed
  doc via `responseFormat:true`, registry sibling-merge both ways, validator accept/reject matrix).
- Anti-regress: verify:feat-083 22/22 · verify:feat-083-adversarial 170/170 · verify:routing-inject
  18/18 · verify:local-conventions 18/18 · verify:wa-injected 15/15 · verify:feat076 36/36 ·
  verify:sessions 52/52 · typecheck clean · `npm run gate` → PASS (exit 0, read directly).

**Restart requirement:** NONE. `enabled`/`guidance` are read per launch (injection) and per render
(client). Injection applies to the NEXT session started; the drawer toggle/textarea take effect on a
client reload. No server/service restart.

**Risk bucket + independent-verify flag:** MODERATE — touches `composeInstructions`, which builds
every session's system prompt (regression-prone path). Byte-identity is the load-bearing safety
property and is proven both directions above, but an independent clean-room verify pass
(scripts/independent-verify.mjs / a second fresh-context agent) is WARRANTED before this is trusted.
Additionally this adds UI (drawer control): a visual + real click-path review of the toggle+textarea
round-trip over a busy project is warranted (delegated tooling) — the automated suite verifies the
persistence chain (patchProject → validator → registry sibling-merge, read-back) but not the rendered
control.
