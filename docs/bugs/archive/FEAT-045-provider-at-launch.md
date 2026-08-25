# FEAT-045 — Provider visible at session-launch + provider-aware /model picker

- **Status:** VERIFIED
- **Severity:** medium (UX gap — the OpenAI engine exists but is invisible where sessions launch)
- **Area:** composer / model picker / server model catalog
- **Reported:** 2026-08-06 by user

## Symptom
User: "i see no way to use openai in new session, only have model list which is
claude's models." FEAT-037 P3 put the provider selector ONLY in the project
settings drawer — on the launch surface (composer tray, where model/permission
overrides are armed pre-start) there is no provider control at all. And the
`/model` picker lists a single global catalog that is in practice Claude's:
worse, a Codex session's `model/list` result OVERWRITES the global
`models.json`, so the two engines poison each other's catalog.

## Repro
1. Open a project (default provider anthropic), look at the composer tray →
   no way to pick OpenAI for the next session without opening the drawer.
2. Start a Codex session (project provider openai) → open `/model` → the list
   shows the Claude aliases (Opus/Sonnet/Haiku), not the real Codex catalog
   the runtime's `model/list` reported live in P2c (gpt-5.6-sol/terra/luna…).
3. GET /api/models after a codex session ran → the CLAUDE picker now shows
   gpt-* rows (single shared `lastModels`).

## Expected
1. A provider control (anthropic | openai) on the launch surface, using the
   existing per-launch override field (`SESSION_OVERRIDE_FIELDS` already
   validates `provider` — P3 built the server side). It shows the live
   `detectCodex()` state (GET /api/providers) like the drawer does; picking
   openai while not connected keeps the honest warn+hint behaviour. Default =
   the project's setting.
2. `/model` is provider-aware: an OpenAI session (live or armed) lists the
   REAL Codex catalog; Claude sessions byte-identical (BUG-021/BUG-026). A
   live `/model` switch on a codex session works via the existing set-model
   path — model rides `turn/start` (P2c), so it applies from the next turn,
   and the picker copy says so honestly.
3. FEAT-042 chip + FEAT-040 crown conventions kept; no new colors.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `public/app.js` — `SESSION_OVERRIDABLE` (:33 — note it LACKED 'provider',
    so a drawer-armed session-scope provider never rode `start.overrides`!),
    composer tray buttons (`node.planBtn/skipBtn/modelBtn`), model picker
    (`MODEL_OPTS`, `adoptModelList`, `resolveCurrentModelOpt`,
    `resolveInheritedModelLabel`, `paintModelBtn`, `paintModelPop`,
    `setModelLive`/`finishModel` — BUG-026), crown chip `paintModelChip`
    (FEAT-042, provider prefix from P3).
  - `public/index.html` — tray + `#modelPop` popover chrome.
  - `public/lib/drawer.js` — `providerGroup()` (P3): the detection-verdict
    rendering to mirror (`.prov-state`, `.grp-note[data-warn]`).
  - `src/server/agent-bridge.ts` — `knownModels`/`rememberModels` (single
    global `lastModels` + `models.json`; the fire-and-forget
    `supportedModels()` refresh at start), `setModel`/`#applyModel` (BUG-026).
  - `src/server/index.ts` — GET /api/models (:702), GET /api/providers (:706+),
    `set-model` WS command.
  - `src/server/runtime/codex-runtime.ts` — `supportedModels()` (model/list,
    schema-validated P2c), `setModel()` (stashes; applies on next turn/start).
  - `scripts/fixtures/codex-fake-app-server.mjs` — model/list fixture
    (gpt-5.2-codex / gpt-5.2) + `ASSERT_MODEL:<id>;` wire assertion.
- Related tickets: FEAT-037 (P3 provider picker, P2c live model/list),
  BUG-021 (picker resolved-name), BUG-026 (live set-model), FEAT-042 (chip),
  BUG-031 (honest provider errors).
- Repro test: `npx playwright test scripts/qa/FEAT-045-provider-at-launch.spec.ts`
  (proposed package.json entry: `"verify:provider-launch"` — orchestrator applies).
- Known dependencies / blockers: none; serialize with other app.js tickets.

## Verification (REQUIRED, §C, non-vacuous — must FAIL pre-change)
Playwright: launch surface shows the provider control with detection state;
arming openai + launching (fake app-server seam CLAUDE_STATION_CODEX_BIN)
yields a codex session; `/model` on that session lists the codex catalog
(the fake's model/list) and NOT the claude list; a live switch applies (the
fake asserts the model on the next turn/start via ASSERT_MODEL); a
not-connected server (scrubbed HOME/PATH) renders the warn+hint. Claude
sessions unchanged: verify:model-picker 14/14 + verify:model-switch.
Anti-regression: verify:provider-picker 17/17, verify:codex-runtime 54/54,
verify:ui --offline, typecheck. Screenshots docs/bugs/assets/FEAT-045-*.png.
Constraints: never touch :4317; scratch ports; kill by pid; fake preferred
over live usage.

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
