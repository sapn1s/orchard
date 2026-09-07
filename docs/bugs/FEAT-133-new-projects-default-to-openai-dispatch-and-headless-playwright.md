# FEAT-133 — new projects default to OpenAI dispatch + headless Playwright, safely

- **Status:** IN VERIFICATION — implemented, awaiting independent verify
- **Severity:** medium
- **Area:** server (registry / tools / provisioning / agent-bridge)
- **Reported:** 2026-09-07 by orchestrator dispatch
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
A newly-created project launched with OpenAI dispatch OFF and the headless
Playwright MCP OFF, so a session got neither unless the user hand-flipped each
toggle. The owner decided both should be ON by default for NEW projects. (The
headful stealth browser, `settings.browser.enabled`, is a separate decision and
stays OFF — out of scope here.)

Separately, a correctness gap: `plannedMcpServers` attached the Playwright MCP
whenever `tools.playwright` was on, with NO check that the binary exists. On a
`direct` host that never provisioned Playwright, that spawns an MCP server that
immediately dies. Making Playwright default-ON would have turned that dead-server
case from a rare hand-opted-in edge into the common path.

## Expected
- NEW projects: `openaiDispatch` ON; `playwright` ON **iff** a creation-time
  preflight says its binary will actually resolve (else OFF, with a recorded
  reason). New-projects-only; existing projects keep their stored values, no
  backfill/migration (BUG-144 precedent).
- `plannedMcpServers` never attaches a Playwright MCP whose binary is absent —
  it reports "unavailable + reason" (mirroring `browserUnavailableReason`)
  instead of spawning a failing server. This half is a correctness fix and holds
  even for a project that opted Playwright in BY HAND.

## Decisions taken (owner's call is authoritative; recorded here, not re-litigated)
- Default OFF rationale (FEAT-102 "a non-entitled session must be TOLD"; FEAT-034
  tool-gating) is overridden BY THE OWNER for these two toggles on new projects.
- **Split the "default" into two facts (ARCH-010).** `defaultToolSettings()` is
  the READ-TIME backfill for a stored-earlier/partial `tools` object; it stays
  conservative (`false`/`false`) precisely so an EXISTING project's effective
  launch config never changes. The NEW-project default lives in a separate
  `resolveNewProjectToolSettings()`, is server-only, and is stored CONCRETELY at
  creation — so there is no client copy of the creation default to drift. The
  drawer's `TOOL_DEFAULTS` mirror (public/lib/drawer.js:862) mirrors the BACKFILL
  and is therefore left UNCHANGED and still consistent: a new project's concrete
  stored `openaiDispatch:true` is read directly, not via the mirror. This is why
  part 1 did not edit two constants — flipping `defaultToolSettings()` would have
  silently backfilled every legacy project that lacks the key (openaiDispatch was
  added in FEAT-102, so many rows have no such key), which part 3 forbids.

## What changed (all UNSTAGED — no git writes)
- `src/server/provisioning.ts` — `hostPlaywrightBinExists()`: the single owner of
  "is the host Playwright MCP binary present?" (ARCH-010), read by both callers
  below. (provisioning does NOT import registry, so this stays acyclic.)
- `src/server/registry.ts`
  - `ToolSettings` doc split into read-time-backfill vs new-project-default.
  - `NEW_PROJECT_DEFAULT_OPENAI_DISPATCH`, `NEW_PROJECT_DEFAULT_PLAYWRIGHT`,
    `ToolPreflight`, `resolveNewProjectToolSettings(hostPath, isolation)`:
    dispatch ON (degrades safe at runtime, no host preflight needed); Playwright
    ON iff `container` (baked image, trusted like Serena) OR the host binary
    exists; else OFF with a reason.
  - `createProject`: when the request names no `settings.tools`, applies the
    new-project defaults + writes `Project.toolPreflight`. An EXPLICIT
    `settings.tools` is the escape hatch — honoured as-is, no preflight (mirrors
    how an explicit `isolation` is honoured, FEAT-131).
  - `Project.toolPreflight?` audit record ({playwright:{wanted,applied,reason},at}),
    written only on preflight-resolved creations. Never read to drive behaviour.
- `src/server/tools.ts`
  - `playwrightUnavailableReason(project)`: `null` for container (baked binary,
    not host-stattable) / when the host binary exists; else a reason. The
    `browserUnavailableReason` analogue for Playwright.
  - `plannedMcpServers`: attaches Playwright only when `tools.playwright &&
    !playwrightUnavailableReason(project)` — no more dead server (part 2b).
- `src/server/agent-bridge.ts` — the system-prompt Playwright note is gated on
  the SAME `playwrightUnavailableReason(project)` (passed as `unavailableReason`),
  so the note and the tool list can never disagree: a session told "enabled but
  UNAVAILABLE" has no `mcp__playwright__*` either. NOT silent (BUG-035 principle
  upheld via the availability-note channel).

## Context pack
- Create route: index.ts POST `/api/projects` → validate.ts `validateCreateProject`
  (sends `settings.tools` ONLY when the body carries `tools`; a UI create sends
  neither isolation nor tools, so the new-project defaults govern UI-created
  projects). Verified end-to-end in the repro (case F).
- Related: FEAT-131 (isolation default, same preflight/new-projects-only pattern
  this mirrors), FEAT-102 (container↔openai), FEAT-034 (tool-gating), BUG-035 /
  BUG-108 (tooling-unavailable card), BUG-151/152 (browserUnavailableReason),
  BUG-144 (backfill-vs-offer), BUG-147 (strict MCP hides user servers).
- Repro test: `verify-feat133.mjs` (kept OUT of the repo tree at
  `~/.local/state/claude-station/scratch/feat133/`; synthetic-but-realistic —
  isolates `CLAUDE_STATION_DATA`, drives real createProject/validateCreateProject/
  plannedMcpServers, seeds a realistic pre-FEAT-133 legacy row for the
  no-backfill check). Promote under `scripts/` if the board wants `verify:feat-133`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — fixing lane (round 1)
- **Understood:** owner overrides the default-OFF rationale for openaiDispatch +
  playwright on NEW projects only. The `defaultToolSettings()` used at creation is
  ALSO the read-time backfill (`toolSettingsOf`), so flipping it would backfill
  legacy rows — forbidden by part 3. So I split creation-default from backfill,
  exactly like FEAT-131 split NEW_PROJECT_DEFAULT_ISOLATION from any read path.
- **Hypothesis verified (part 2b):** CONFIRMED. Pre-fix `plannedMcpServers` had
  `if (tools.playwright) servers[...] = playwrightMcpServerFor(project)` with NO
  existence check (read at tools.ts:212), and `playwrightMcpServerFor` uses
  `hostPlaywrightBin()` unconditionally for `direct`. Repro case D2 shows the
  pre-fix gate would attach a command whose path does not exist on disk (a dead
  server). No existing check — proceeded with parts 1 + 2 as chartered.
- **Changed (unstaged):** provisioning.ts, registry.ts, tools.ts, agent-bridge.ts
  (see "What changed"). No user project's settings touched.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `verify-feat133.mjs` — **26/26 PASS** (printed observed values, not PASS/FAIL):
    A) new container project → tools `{serena:true,playwright:true,openaiDispatch:true}`,
    toolPreflight.applied=true; B) new direct + host bin PRESENT → same, reason null;
    C) NEGATIVE new direct, host bin ABSENT → `openaiDispatch:true, playwright:false`,
    preflight reason present, `plannedMcpServers` OMITS playwright; D) hand-opted-in
    `playwright:true` on a binary-less host → `playwrightUnavailableReason` non-null,
    plannedMcpServers omits playwright but KEEPS serena (2b applies to opt-in too);
    D2) MUST-FAIL repro of the pre-fix dead server (command path exists:false);
    E) escape hatch: explicit `settings.tools` honoured verbatim, no toolPreflight;
    F) REAL HTTP path validateCreateProject(container, no tools) → createProject →
    dispatch+playwright ON; G) seeded legacy row byte-identical after all creations,
    no toolPreflight, effective openaiDispatch/playwright stay FALSE (no backfill).
  - `npm run gate` — **typecheck PASS, check-nul PASS.** leak-gate FAIL is NOT my
    code: the only remaining hit is `docs/bugs/BUG-171-*.md` (another lane's
    untracked ticket). After relocating my scratch out of the repo tree the gate
    reports 1 hit in 1 file, all in BUG-171. My four changed files are clean.
  - Anti-regression: `verify:bug-151-playwright-first` **61/61 PASS**;
    `verify:addproject` **7/7 PASS**.
  - `verify:mcp-attach` — 19/26 both WITH my change and with it reverted to the
    pre-fix gate (IDENTICAL 7 failures: D1-D4b, Dsel2-3). So these are PRE-EXISTING
    on this machine (its live haiku-session path is not producing the expected
    provider-error events), NOT my regression. See handoff for the DESIGN CONFLICT
    they encode. `verify:mcp-ready` could not run — its harness needs
    `CLAUDE_CONFIG_DIR` isolation it does not set (unrelated to this change).
- **Could NOT test:** a genuinely healthy live-session run of verify:mcp-attach D
  (this machine's live path is already red pre-change); a real container image
  actually MISSING the baked playwright-mcp (my preflight trusts the image for
  container, as Serena does — a broken image is a separate failure surfaced at
  container start). Both noted for the clean-room.
- **Verified-by:** PENDING — high-stakes (session-lifecycle / default-on tool
  gating, regression-prone: touches tools.ts/agent-bridge.ts which BUG-035/108/151/152
  regressed before). Independent clean-room verify warranted; a case my fixture
  does NOT cover: a REAL UI POST /api/projects producing a launched session whose
  tool list + availability notes match (openai dispatch usable, playwright present
  or honestly reported unavailable) on a host in each preflight state.
- **BUG-147 (asked):** NOT materially worse. `plannedMcpServers` already returned
  `strict:true` for every session because Serena defaults ON, so the user's own
  MCP servers were already always suppressed; a default-ON Playwright adds one more
  attached server but does not change the strict decision. My 2b gate actually
  ADVANCES BUG-147's success-criterion #4 ("provisioning state checked before a
  session is handed an MCP config naming a binary that is not installed") for
  Playwright. Did NOT fix BUG-147.
- **Symptom of a deeper design flaw?** n/a (ticket not being closed).

## Decision — how should a NEW project's tool defaults compose with BUG-035/108's card?
The owner's default is set and built. One conflict for the owner/BUG-035 owner to
settle (I did NOT touch another ticket's verify script):

- **A — keep part 2b as built (omit + availability note).** A missing Playwright
  binary is OMITTED from the plan and surfaced via the system-prompt availability
  note ("enabled but UNAVAILABLE: <reason>"), the `browserUnavailableReason`
  shape the charter asked for. Cost: `verify-mcp-attach.mjs` D4/D4b/Dsel3 encode
  the OLD contract (Playwright ATTACHED-and-failed → named in the tooling-unavailable
  CARD with its `mcp__playwright__*` tools); on a healthy machine those checks
  would newly go red and BUG-035/108's script needs its Playwright expectations
  updated to the note channel. The BUG-035 PRINCIPLE ("never silently run without
  the tool") still holds — only the channel differs, and it now differs from how
  Serena (still attach-and-card) is surfaced.
- **B — attach-and-fail like Serena (revert 2b, card channel).** Playwright stays
  attached even when its binary is absent, failing into the same tooling-unavailable
  card as Serena; consistent with BUG-035/108 and verify-mcp-attach as written.
  Cost: a default-ON Playwright now makes the dead-server case the COMMON path on
  any un-provisioned `direct` host, which is exactly what part 2b was chartered to
  prevent; it also diverges from the `browserUnavailableReason` precedent.
