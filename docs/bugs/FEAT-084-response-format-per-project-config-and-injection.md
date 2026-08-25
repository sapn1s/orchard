```orchard-ticket
{
  "id": "FEAT-084",
  "type": "feature",
  "title": "Sessions were never told to produce the structured reply format",
  "summary": "Every session is now told to produce the tidy structured reply summary as part of its setup, and each project gets one free-text box for nudging style. Before this the format only appeared when an agent happened to remember it. A project that turns the format off receives a byte-for-byte unchanged prompt.",
  "impact_if_we_wait": "Bounded: the work shipped and is live for new sessions. Nothing is at risk while it stands; a project that disabled the format is provably unaffected, and no stored data or existing session prompt changes.",
  "current_need": "Nothing is outstanding. The targeted checks, the anti-regression suites and the byte-identical disabled-path proof all passed, and the change is live for newly started sessions.",
  "severity": "medium",
  "area": "Project reply formatting",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-18",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "Should the reply format be steered by one free-text nudge or by typed configuration knobs?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-14",
      "chosen_by": "user",
      "note": "A single free-text guidance field was chosen. Typed verbosity and kind knobs were rejected as a matrix nothing consumes, and an agent-generated component protocol was deferred as separate future work with its own sanitisation and fallback contract."
    }
  ],
  "success_criteria": [
    "The format instruction appears in a session's composed prompt when the project has it enabled",
    "With the format disabled, the composed prompt is byte-identical to the pre-change prompt",
    "Project guidance text appears under its own subhead when set",
    "A patch carrying only guidance leaves the enabled flag intact",
    "A fresh project gets the format on both the instructing and the rendering side"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": "composeInstructions",
      "note": "folded working agreement, local conventions and routing, but no reply-format section; the new section folds last and is gated on the project's enabled flag"
    },
    {
      "path": "src/server/templates.ts",
      "symbol": "responseFormatSection",
      "note": "mirrors the routing section; injects only the marked condensed core, roughly 1 KB"
    },
    {
      "path": "docs/prompts/RESPONSE_FORMAT.md",
      "symbol": null,
      "note": "gained start and end injection markers so only the condensed core is folded in"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "launch",
      "note": "session launch path that composes the instructions"
    },
    {
      "path": "src/server/registry.ts",
      "symbol": null,
      "note": "response digest settings extended from a bare enabled flag to enabled plus optional guidance; older registries read guidance as undefined"
    },
    {
      "path": "src/server/validate.ts",
      "symbol": null,
      "note": "whitelists guidance, caps it near 600 characters and rejects control characters; a malformed patch is rejected rather than silently landed"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "per-project toggle group and guidance textarea"
    }
  ],
  "related": [
    {
      "id": "FEAT-083",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-085",
      "relation": "blocks"
    },
    {
      "id": "FEAT-089",
      "relation": "blocks"
    },
    {
      "id": "FEAT-093",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-084-response-format-per-project-config-and-injection.md",
    "sha256": "b2238dcb62bf22bcadbae0a845faa8e3503c2106a292c04fe7950c9624056c85",
    "bytes": 10734,
    "original_title": "response-format: agent-awareness injection + per-project override (close the FEAT-083 gap)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the injection gap, the single free-text knob, the rejected alternatives, the data-loss argument, the disabled-path proof and the flagged next steps are all present.",
    "dropped": [
      "the approximate 1 KB and 600-character figures were moved out of the human layer into a code_ref note",
      "the ticket's own restatement of its status line"
    ]
  }
}
```

# FEAT-084 — Sessions were never told to produce the structured reply format

## Diagnosis

### The gap

FEAT-083 shipped the parser, the renderer and the per-project opt-out, plus a convention document describing the format. Nothing injected the format instruction into a session. `composeInstructions` folded the working agreement, then local conventions, then routing — and stopped. The digest therefore only appeared when the agent emitted it from convention or memory, no other project received it automatically, and the convention document was inert.

### The shape of the fix

A new `responseFormatSection()` mirrors the existing routing section and folds last, gated on the same `responseDigest.enabled` flag the renderer already reads. Injection and rendering consulting one flag is what stops the two sides from disagreeing and stranding content. The settings type grew one field: a short free-text `guidance` nudge, appended under its own subhead, length-capped and rejected if it carries control characters.

### What guidance can and cannot do

It steers tone, verbosity and when to emit. It cannot change the fixed JSON schema, the fence name, the kind set or the fail-closed fallback to prose. Being validated, it also cannot corrupt either the injected prompt or the registry file.

## Evidence

The fixer's own runs: `verify:feat-084` 37/37; `verify:feat-083` 22/22 and `verify:feat-083-adversarial` 170/170; `verify:routing-inject` 18/18; `verify:local-conventions` 18/18; `verify:sessions` 52/52; `verify:wa-injected` 15/15; `verify:feat076` 36/36. Typecheck clean. The load-bearing case is the byte-for-byte comparison showing that a project with the format disabled composes exactly the prompt it composed before.

`verify:ui` and `verify:feat-084-response-format-inject` are named in the plan but no result is recorded against them.

No independent clean-room verdict was dispatched for this ticket; the worker log flags an independent re-verify and a visual review of the new per-project toggle as the sensible next steps.

## Implementation notes

Two edit paths reach the setting: the drawer toggle group with its guidance textarea, and a natural-language-driven PATCH to `/api/projects/:id` carrying `{settings:{responseDigest:{guidance,enabled}}}`. The existing one-level merge preserves sibling settings, so a patch naming only guidance leaves the enabled flag as it was.

A fresh project defaults to enabled, so the format is on for both instructing and rendering with no configuration. Disabling is one flag and takes both sides down together. Old registry files read `guidance` as undefined and need no migration.

## Verification plan

Assert the injected section is present in the composed prompt when enabled, and that the composed prompt is byte-identical to the no-option baseline when disabled or when guidance is empty. Assert guidance text appears under the override subhead when set. Reuse the routing-section test shape. Round-trip the drawer toggle and textarea through a PATCH, and confirm a guidance-only PATCH preserves the enabled flag. Anti-regression: the FEAT-083 suites including the adversarial one, routing injection, local conventions, sessions, UI, typecheck and the leak gate.

## Migration and rollback

Takes effect on the next session started; no server restart is required. Registries written before this change are read without alteration.

## Risks

This touches the composition path for every session's system prompt, which puts it in a moderate risk bucket. The mitigation is the byte-identical proof on the disabled and empty-guidance paths, so an unrelated project cannot be perturbed. The rejected agent-generated-component protocol was set aside partly on risk: it opens a large cross-site-scripting and rendering surface, and it breaks the fallback to prose because arbitrary components have no clean degraded form.

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

### 2026-08-20 — worker (BUG-128 repair, record only)

- **Understood:** this ticket's record listed itself in `related` — `FEAT-084 --see_also--> FEAT-084`. Nothing about the feature is wrong; the edge is a record defect.
- **Changed:** removed that one entry from `related`. Nothing else in the record or the prose was touched. Traced first: the edge is present in the pre-reconciliation staging backup, so the migration authored it and `--reconcile` did not.
- **Verified:** `node scripts/verify-bug-128.mjs` — 43/43, including a sweep of all 197 records on the board that now finds none. `npm run board:check` named this ticket before the repair and does not after.
- **Still open / handoff:** nothing, for this repair. The defect that allowed it is BUG-128.
