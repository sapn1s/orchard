```orchard-ticket
{
  "id": "FEAT-045",
  "type": "feature",
  "title": "Sessions could not be started on the other engine",
  "summary": "Launching a session offered no way to pick the OpenAI engine without opening project settings, and the model list always showed Claude's models. A session on one engine also overwrote the stored model list for the other. Both are now fixed, with the engine picker on the launch tray and a model list that follows the session's engine.",
  "impact_if_we_wait": "People could not reach the OpenAI engine where sessions actually start, and picked models that did not exist for their session. Bounded: this affected reachability and display of choices, not stored sessions or transcripts.",
  "current_need": "Nothing is outstanding. The launch and picker suites, the engine-runtime suite and the wider interface suites all passed, with typecheck clean.",
  "severity": "medium",
  "area": "Session launch and model picker",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The launch tray offers an engine choice reflecting live detection, defaulting to the project's setting",
    "Picking the unavailable engine still warns and hints rather than failing silently",
    "A session on the OpenAI engine lists that engine's real model catalogue",
    "Claude sessions list exactly what they listed before",
    "A live model switch applies from the session's next turn",
    "One engine's model list no longer overwrites the other's"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "SESSION_OVERRIDABLE",
      "note": "lacked 'provider', so a drawer-armed session-scope provider never rode start.overrides"
    },
    {
      "path": "public/app.js",
      "symbol": "adoptModelList",
      "note": "picker resolution and painting; resolved-name behaviour from BUG-021"
    },
    {
      "path": "public/app.js",
      "symbol": "paintModelChip",
      "note": "FEAT-042 chip with the provider prefix; FEAT-040 crown conventions kept"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "providerGroup",
      "note": "the detection-verdict rendering the tray control mirrors"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "rememberModels",
      "note": "single global lastModels plus models.json — the shared store that let the catalogs poison each other"
    },
    {
      "path": "src/server/index.ts",
      "symbol": "GET /api/models",
      "note": "at :702; GET /api/providers at :706+ supplies the detection state"
    },
    {
      "path": "src/server/runtime/codex-runtime.ts",
      "symbol": "supportedModels",
      "note": "schema-validated model/list; setModel stashes and applies on the next turn/start"
    },
    {
      "path": "scripts/fixtures/codex-fake-app-server.mjs",
      "symbol": null,
      "note": "model/list fixture and the ASSERT_MODEL wire assertion used instead of live usage"
    }
  ],
  "related": [
    {
      "id": "BUG-021",
      "relation": "see_also"
    },
    {
      "id": "BUG-026",
      "relation": "see_also"
    },
    {
      "id": "BUG-031",
      "relation": "see_also"
    },
    {
      "id": "BUG-036",
      "relation": "see_also"
    },
    {
      "id": "FEAT-037",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-040",
      "relation": "see_also"
    },
    {
      "id": "FEAT-042",
      "relation": "see_also"
    },
    {
      "id": "FEAT-046",
      "relation": "see_also"
    },
    {
      "id": "FEAT-051",
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
    "archived_path": "docs/bugs/archive/FEAT-045-provider-at-launch.md",
    "sha256": "7846a155211c9b431a1a85b7ac3fcc38680f3266416e3c4c18c6827cb95a840b",
    "bytes": 11999,
    "original_title": "Provider visible at session-launch + provider-aware /model picker",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the original head: the two symptoms, the three expectations, the context pack files and the verification constraints are all present.",
    "dropped": [
      "the numbered repro steps, whose content is carried by the evidence and the verification plan"
    ]
  }
}
```

# FEAT-045 — Sessions could not be started on the other engine

## Diagnosis

The provider selector built in FEAT-037 P3 lived only in the project settings drawer, so the composer tray — where model and permission overrides are armed before a session starts — had no provider control at all. The server side already accepted one: `SESSION_OVERRIDE_FIELDS` validated `provider`. On the client, `SESSION_OVERRIDABLE` in `public/app.js` omitted `provider`, so even a drawer-armed session-scope provider never rode `start.overrides`.

Separately, `/model` read one global catalog. `knownModels`/`rememberModels` in `src/server/agent-bridge.ts` keep a single `lastModels` and one `models.json`, so a Codex session's `model/list` result overwrote the Claude catalog and vice versa.

## Evidence

With a project defaulting to the Anthropic engine, the tray offered no route to OpenAI. On a Codex session, `/model` listed the Claude aliases rather than the gpt-* catalog the runtime had reported live. After any Codex session ran, `GET /api/models` made the Claude picker show gpt-* rows.

Executed afterwards: verify:model-picker 14/14, verify:model-switch 17/17, verify:provider-picker 17/17, verify:codex-runtime 54/54, verify:ui 3/3, verify:model-chip 5/5, verify:overrides 5/5, verify:new-session-overrides 5/5, verify:orchard-transcripts 15/15, and typecheck clean.

## Implementation notes

The tray control mirrors the drawer's detection-verdict rendering (`.prov-state`, `.grp-note[data-warn]`) rather than inventing a second one, and defaults to the project's setting. Choosing openai while the engine is not connected keeps the honest warn-and-hint behaviour from BUG-031. The live switch rides the existing set-model path; on the Codex runtime the model is stashed and applied on the next `turn/start`, and the picker copy says so. FEAT-042's chip and FEAT-040's crown conventions are kept, with no new colours.

## Verification plan

The proposed Playwright spec `scripts/qa/FEAT-045-provider-at-launch.spec.ts` (package entry `verify:provider-launch`) covers: the tray control showing detection state; arming openai and launching through the fake app-server seam `CLAUDE_STATION_CODEX_BIN` yielding a codex session; `/model` on that session listing the fake's catalog and not the Claude list; a live switch asserted on the next turn via `ASSERT_MODEL`; and a scrubbed HOME/PATH server rendering the warn plus hint. Screenshots under `docs/bugs/assets/FEAT-045-*.png`. Constraints: never touch :4317, scratch ports, kill by pid, fake preferred over live usage.

## Risks

Both engines shared one persisted model store, so any change there risks a stale catalog leaking across sessions. Serialize with other tickets touching `public/app.js`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-06 — orchestrator (via fix agent filing)
- Filed from the live user report. FEAT-037 P3 deliberately scoped the picker
  to the drawer; this ticket brings the provider to the launch surface and
  makes the model catalog per-provider end to end.

### 2026-08-06 — fix agent (FEAT-045) — built + VERIFIED (fixture seam, no live codex usage)

**Understood (two real root gaps beyond the missing control):**
1. The client-side `SESSION_OVERRIDABLE` mirror (public/app.js:33-ish) LACKED
   `'provider'` — so even the P3 drawer's session-scope provider override was
   armed into `state.overrides` but silently never rode `start.overrides`
   (`sessionOverrides()` filters by that list). The server has validated the
   field since P3; the client just never sent it.
2. The server's model catalog was ONE global `lastModels` + `models.json`:
   a codex session's fire-and-forget `supportedModels()` refresh overwrote the
   Claude catalog (and vice versa) — the picker could offer gpt-* rows to a
   Claude session. Provider-awareness had to start server-side.

**Changed (file:line):**
- `src/server/agent-bridge.ts:106-131` — per-provider catalog memory:
  `lastModelsByProvider` Map, `knownModels(provider='anthropic')`,
  `rememberModels(provider, models)`; `models.json` keeps its pre-045
  name/shape for anthropic (existing cache carries over), other providers get
  `models-<provider>.json`. `:796-803` — the per-session refresh remembers
  under `this.effective.provider`.
- `src/server/index.ts:701-713` — GET /api/models takes `?provider=`
  (anthropic|openai; unknown → 400 named; no query = pre-045 byte-identical).
- `public/lib/api.js:276-283` — `api.models(provider?)` + `api.providers()`.
- `public/index.html:238-240` (tray `#provBtn`, hexagon icon, same `.ic`
  voice) + `:160-173` (`#provPop` popover, same chrome as `#modelPop`).
- `public/app.js`:
  - `:33-38` — `SESSION_OVERRIDABLE` gains `'provider'` (gap 1).
  - `:5675-5851` — the FEAT-045 block: `providerView()` (live effective →
    armed override → project setting → 'anthropic'; the exact resolution the
    P3 chip used inline, now shared), `CODEX_MODEL_OPTS` +
    `adoptCodexModelList` + `activeModelOpts()` (anthropic ALWAYS returns
    MODEL_OPTS — claude path byte-identical), `refreshCodexModels()` (lazy +
    change-guarded: repaint only when the list changed, because paintModelPop
    itself refetches — unconditional repaint looped and detached rows
    mid-click, caught by the spec's first post-change run),
    `paintProvBtn`/`paintProvPop`/`pickProvider` + handlers. The popover
    renders the LIVE /api/providers verdict (`.prov-state`, drawer voice);
    picking openai while not connected is allowed but warns with the hint;
    picking the project default clears the override; a provider CHANGE drops
    an armed model/effort override loudly (it named the other engine's
    catalog). Hidden while `state.live` — the engine is fixed mid-session and
    the FEAT-042 chip already names it.
  - model picker provider-aware: `:5895,:5911` (resolveInheritedModelLabel),
    `:5943,:5953` (paintModelBtn + paintProvBtn piggyback), `:5977`
    (shortModelName), `:5995-5996` (sameModel), `:6056-6062,:6087,:6121-6128`
    (paintModelPop: catalog = activeModelOpts(), honest empty-catalog note),
    `:6016-6019` (paintModelChip uses providerView + lazy catalog probe).
  - `:1852-1856` — finishModel copy for codex: "confirmed — Codex switches at
    turn boundaries, so it applies from the next turn" (model rides
    turn/start, P2c); claude copy byte-identical (BUG-026 spec still green).
- `public/styles.css:1602-1614` — `#provBtn[data-set]` override dot (same as
  modelBtn), `.pop .prov-state`/`.pop .grp-note` spacing. No new colors —
  greyscale + the one warm warn accent those classes already own.
- `scripts/qa/FEAT-045-provider-at-launch.spec.ts` (NEW) — see below.

**Verified (§C, all real paths, fake app-server seam CLAUDE_STATION_CODEX_BIN):**
- **MUST-FAIL proven first:** spec run pre-change → **2 failed / 0 passed**
  (no `#provBtn` exists; both tests die at the control).
- `npx playwright test scripts/qa/FEAT-045-provider-at-launch.spec.ts` →
  **2 passed**: (1) launch surface shows the control; popover lists both
  engines + `.prov-state[data-status]` EQUAL to the live /api/providers
  verdict; picking OpenAI arms `sessionOverrides().provider==='openai'` and
  the crown chip marks `codex`; launching yields a codex session (fixture
  reply rendered); /model lists **GPT-5.2 Codex / GPT-5.2** and NOT
  opus/sonnet/haiku; live switch to gpt-5.2 confirmed with the next-turn
  copy and `effective.model==='gpt-5.2'`; the NEXT turn carries the model ON
  THE WIRE — the fake's `ASSERT_MODEL:gpt-5.2;` marker is a protocol
  violation (transport death) if turn/start lacks it, and the turn completed
  with the session still live; GET /api/models (claude) carries NO gpt-*
  row while ?provider=openai carries the codex catalog (poisoning fixed).
  (2) not-connected server (scrubbed HOME/PATH) → `.prov-state`
  data-status not-installed; picking OpenAI still arms but warns with the
  install hint in #fine AND the popover.
- Anti-regression, all green: `verify:model-picker` **14/14** ·
  `verify:model-switch` **1 passed** (real live haiku switch — claude path
  byte-identical) · `verify:model-chip` **1 passed** · `verify:overrides`
  **5/5** · `verify:new-session-overrides` **5/5** ·
  `verify:provider-picker` **17/17** · `verify:codex-runtime` **54/54** ·
  `verify:orchard-transcripts` **15/15** · `verify:ui -- --offline` **3/3** ·
  `npm run typecheck` clean · `node --check` app.js/api.js clean.
- Screenshots: `docs/bugs/assets/FEAT-045-launch-picker.png` (control +
  connected verdict), `FEAT-045-codex-model-list.png` (codex session, /model
  = codex catalog), `FEAT-045-live-switch.png`, `FEAT-045-not-connected.png`
  (armed warn + hint).
- Constraints: :4317 untouched (health 200 after), scratch ports/data dirs,
  killed by pid, nothing installed, no live codex usage by the new spec (the
  one tiny real turn in the run was verify:provider-picker's pre-existing
  report-only section E). No git commit.

**package.json entry to add (reported, NOT applied — per charter):**
`"verify:provider-launch": "playwright test scripts/qa/FEAT-045-provider-at-launch.spec.ts"`

**Still open / handoff:** none for the stated scope. Notes for later: (a) the
codex catalog is learned from a session's own `model/list` — before the FIRST
codex session ever runs on a server the picker shows the honest "fills in when
a Codex session runs" note (a detection-time `model/list` probe without a
session would need a short-lived app-server spawn — deliberate non-goal here);
(b) EFFORT rows are still the static claude list for both engines (codex
model/list carries per-model effort options — a follow-up could surface them);
(c) the drawer's session-scope provider override now genuinely rides `start`
(gap 1) — behaviour it always CLAIMED, so no drawer copy change needed.
