```orchard-ticket
{
  "id": "BUG-035",
  "type": "bug",
  "title": "Serena was missing from onboarded project sessions",
  "summary": "Serena now attaches to onboarded projects, and failed or pending tool servers are shown instead of silently omitted. The failures came from a missing launcher inside the container and a host project path that the container could not use. Browser and Playwright attachment remained unaffected.",
  "impact_if_we_wait": "A regression could leave Serena unavailable without explaining why, delaying project work and diagnosis. Bounded: this affects tool availability and status correctness, not project data, browser tools, or Playwright.",
  "current_need": "Close the ticket: targeted attachment and toggle tests passed, and standing type checks stayed clean.",
  "severity": "not_recorded",
  "area": "Project tool attachment",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-18",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Serena tools are available in an onboarded project session",
    "A failed Serena launch is reported instead of silently omitted",
    "Browser and Playwright tools remain unaffected",
    "Existing tool-toggle behavior remains intact"
  ],
  "code_refs": [
    {
      "path": "src/server/tools.ts",
      "symbol": "plannedMcpServers",
      "note": "Builds the Serena launch configuration and passes the project path to the runtime"
    }
  ],
  "related": [
    {
      "id": "ARCH-007",
      "relation": "see_also"
    },
    {
      "id": "BUG-024",
      "relation": "see_also"
    },
    {
      "id": "BUG-027",
      "relation": "see_also"
    },
    {
      "id": "BUG-030",
      "relation": "see_also"
    },
    {
      "id": "BUG-031",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-107",
      "relation": "see_also"
    },
    {
      "id": "BUG-116",
      "relation": "blocks"
    },
    {
      "id": "FEAT-025",
      "relation": "see_also"
    },
    {
      "id": "FEAT-055",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/BUG-035-serena-not-attaching.md",
    "sha256": "9158a48069b2e1d9e4047acbff077ec0ea5da613c182277a3eb99f28283b14e5",
    "bytes": 15501,
    "original_title": "Serena MCP not detected/enabled on an onboarded project (browser + Playwright work)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the supplied ticket; both causes, visible failure reporting, unaffected tools, requested checks, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-035 — Serena was missing from onboarded project sessions

## Diagnosis

Two Serena-specific failures caused the missing tools. The container image did not contain `uvx`, although the host service path did. The generated Serena command also supplied a host project path to the containerised process, where that path was invalid. The generic attachment path remained functional for browser and Playwright tools.

A separate honesty defect silently omitted failed or pending MCP servers. The corrected behavior reports those states.

## Evidence

The host systemd user path included `~/.local/bin`, and `uvx` existed there, ruling out a missing host service path. Browser and Playwright tools worked for the same project.

`verify:tool-toggle` passed 13/13, and `verify:mcp-attach` passed 20/20. The standing `typecheck` check was clean. `verify:provider-errors`, `verify:browser`, and `verify:ui` were mentioned without recorded results.

## Implementation notes

Keep Serena enabled by default when its setting is absent. Build its launch command for the execution environment, including a project path the container can resolve. Surface failed and pending MCP attachment states rather than dropping unavailable servers from session reporting.

## Verification plan

Exercise tool toggling and MCP attachment behavior. Confirm Serena planning uses the container-appropriate launcher and project path. Induce a launch failure and confirm the session reports it while browser and Playwright attachment behavior remains unchanged.

## Risks

Container and host executable availability can diverge. Project paths valid on the host may be invalid inside the container. Changes to attachment reporting must not mislabel healthy browser or Playwright servers.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from live user report. PATH hypothesis checked and RULED OUT before filing.

### 2026-08-09 — investigate + fix + verify agent (root cause found; VERIFIED)

#### Phase 1 — INVESTIGATION (ground truth, in the ticket's order)

**1. The observed surface.** external-project-A is the ONLY container-isolation project in the
registry (`isolation: "container"`, `settings.tools = {serena:true, playwright:true}`,
`browser.enabled: true`) — which is the whole story. Reproduced on scratch projects, never on
the user's own project or its container.

**2. Is Serena in the plan?** YES. `plannedMcpServers()` returns it for that project (toggle is
on, and it is default-on anyway). So the "toggle is off" hypothesis is dead: the map handed to
the CLI contained `serena` every time.

**3. Does the CLI START it? — NO, and it never said so.** Two independent, both-real causes:

- **CAUSE A (the user's case): the container image has no `uvx`.** MCP servers are spawned by
  the CLI, and for `isolation: container` the CLI runs INSIDE the container (agent-bridge's
  `docker exec -i` spawn override). Probed the real image:
  ```
  $ docker run --rm claude-station-base:u1000-g1000 bash -lc 'command -v uvx; command -v npx'
  NO uvx
  /usr/bin/npx
  ```
  `src/server/container/Dockerfile` installs node (so `npx -y @playwright/mcp` works) and
  bind-mounts the browser's stdio shim at `/opt/sbmcp` (so the browser works) — but nothing ever
  installed `uv`. Serena's command IS `uvx`. That is precisely why Serena was the only broken
  one while "the other browser/playwright mcps work".
  **The host PATH hypothesis was correctly ruled out and stayed ruled out — the failing PATH was
  the CONTAINER's, not the service's.**

- **CAUSE B (latent, would have bitten right after A was fixed): a host path in a container.**
  `serenaMcpServerFor` passed `--project <project.hostPath>`, but the repo is bind-mounted at
  `containerWorkdir(id)` = `/workspace/<id>`; `~/projects/<repo>` does not exist in
  there. `browser.ts:mcpServerFor` has had a host/container two-shape for exactly this reason
  since day one — Serena never got one (flagged as an open item in FEAT-025's handoff, never
  built).

- **HOW IT FAILED SILENTLY (the honesty gap).** Probed the real CLI (2.1.226) with a command
  that does not exist: **the CLI does not fail, writes nothing to stderr and emits no error
  frame.** The turn runs perfectly normally with the tools simply absent. The ONLY trace
  anywhere is one field of `system:init`:
  ```
  mcp_servers: [{"name":"serena","status":"failed"}]      (healthy reads "connected")
  ```
  `#handleSystem`'s `init` case read `session_id/cwd/model/tools/slash_commands` and **dropped
  `mcp_servers` entirely** — the field was not referenced anywhere in this repo. No timeout, no
  crash, no log: a pure silent capability loss (BUG-024/027/030/033 class).

**4. Diffed against claude-station's own (working) sessions — and found a SECOND, separate
finding that affects EVERY project, direct isolation included:**

In the streaming-input mode the station uses (not `-p`), **the CLI does not wait for its MCP
servers before turn one.** Live SDK probe, warm uv cache, `direct` isolation:
```
 644ms  SYSTEM init  [{"serena":"pending"}]   0 mcp tools
2049ms  RESULT success                         <- turn ONE ran with NO Serena
17.0s   SYSTEM init  [{"serena":"connected"}] 21 mcp tools   <- second init frame
21.7s   RESULT  "mcp__serena__find_symbol, …"  <- turn TWO has them
```
So even on a perfectly healthy host project, a session's FIRST turn has no Serena, and the
station said nothing about it. For a one-shot dispatched agent that is indistinguishable from
"Serena is not enabled". `pending` is NOT a failure and must not be reported as one (that would
cry wolf on every healthy session) — but it must be SAID.

**Hypotheses disproved along the way:** (a) uvx cold-fetch latency/timeout — a warm host run is
4.6s end-to-end and connects fine (`status:'connected'`, 21 tools listed), and the uv cache was
already warm; (b) a station-side startup timeout — none exists, the CLI simply never blocks;
(c) toggle/settings shape — the toggle was on and honoured; (d) service PATH — ruled out at
filing and re-confirmed irrelevant (the failing PATH is inside the container).

#### Phase 2 — FIX

- `src/server/tools.ts:32-60` — `serenaMcpServerFor` now has the SAME two-shape as
  `browser.ts:mcpServerFor`: `--project` is `containerWorkdir(project.id)` for
  `isolation: "container"`, `project.hostPath` otherwise. (CAUSE B)
- `src/server/container/Dockerfile` — installs `uv`/`uvx` (astral installer, into
  `/usr/local/bin`, asserted with `uvx --version` at build time). (CAUSE A) Proven by building
  the image and starting the REAL Serena inside it against a bind-mounted `/workspace/<id>`:
  "Starting MCP server with 21 tools", TypeScript LS auto-provisioned in-container.
  **Existing containers keep running the OLD image** (`ensureImage` skips a build when the tag
  exists) — the user's one action is the drawer's **Rebuild** button
  (`POST /api/projects/:id/container/rebuild` → `ensureImage(force)` + recreate).
- `src/server/runtime/runtime.ts` — ADDITIVE only: `ProviderErrorKind` gains
  `'tooling-unavailable'`; `ProviderError` gains optional `pending?: boolean` (the in-progress
  vs terminal split, mirroring what `retrying` already does for API errors).
- `src/server/runtime/claude-runtime.ts` — `classifyProviderError` now reads `system:init`'s
  `mcp_servers`: any server not `connected` is reported. `failed` → terminal
  `tooling-unavailable` naming the server, the tools lost (`mcp__serena__*`) and the exact
  COMMAND it was launched with (kept from `RuntimeStartConfig.mcpServers` in a new `#mcpServers`
  field), plus where that command has to be runnable; `pending` → the same kind with
  `pending:true`. **Done at the runtime seam on purpose: BUG-031's existing relay carries it to
  the UI with ZERO new plumbing — `agent-bridge.ts` was NOT touched** (it is contended by
  BUG-033's fix).
- `public/app.js` — label for the new kind + a `tooling-unavailable` branch in the
  `provider-error` handler: `pending` → one honest ticker line ("still starting … NOT available
  for this turn"); terminal → the attributed card, but deliberately NOT `state.provError` and NO
  busy watchdog, because a missing tool is a capability loss, not this turn's failure (the turn
  is alive and must not be relabelled).

#### Verification — `scripts/verify-mcp-attach.mjs` (new), **20/20 PASS**

Scratch ports + scratch data dirs, kill-by-pid, `:4317` and external-project-A untouched
(the container was only ever `docker inspect`ed; the image probe ran a throwaway tag, since
removed).
- **A. the cause (4)** — real `serenaMcpServerFor`/`plannedMcpServers`: container → `/workspace/<id>`,
  direct → hostPath (no regression); Dockerfile ships uvx.
- **B. the seam on REAL frames (3)** — `system:init` captured from live `claude` runs: the
  bogus-command frame (ground truth: no stderr, no error frame, tools absent) classifies
  `tooling-unavailable`; the real-Serena `connected` frame classifies **null** (non-vacuity).
- **C. healthy, end-to-end (4)** — a REAL two-turn station session on a real scratch project:
  Serena's tools are genuinely present at runtime — `mcp__serena__find_symbol`,
  `find_referencing_symbols`, `find_declaration`, `find_implementations`, `get_symbols_overview`,
  `get_diagnostics_for_file`, `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`,
  `rename_symbol`, `safe_delete_symbol`, `replace_content`, `replace_in_files`, `write_memory`,
  `read_memory`, `list_memories`, `delete_memory`, `rename_memory`, `edit_memory`, `onboarding`,
  `initial_instructions` (21) — no false failure alarm, and the turn-one gap is announced.
- **D. induced failure, end-to-end (6)** — the same station started with `uvx` absent from PATH
  (the host-side shape of the container bug): the user gets an attributed report naming serena
  AND the exact command; Serena's tools really are absent; **Playwright stayed attached** (24
  `mcp__playwright__*` tools) so the report is selective, not a blanket "MCP broke"; both turns
  still completed.
- **E. UI (3)** — the card renders attributed ("anthropic — tools missing — an MCP server failed
  to start") with the command verbatim and no Retry; busy untouched; a clean turn afterwards
  still reads `idle`/no sessError. Screenshot: `docs/bugs/assets/BUG-035-tooling-unavailable.png`.
- **MUST-FAIL confirmed:** the same script against a pristine `git archive HEAD` copy →
  **12/20, 8 FAIL** (A2, A3, A4, B1, C3, D1, D2, E1) — i.e. every cause check AND every honesty
  check, including "(D1) NO provider-error event — the silent failure this bug is about".
- Anti-regressions: `verify:tool-toggle` **13/13** · `npm run typecheck` **PASS** ·
  `verify:provider-errors` **22/0** (BUG-031 taxonomy intact; its healthy-turn sanity still sees
  zero cards, confirming `pending` does not cry wolf) · `verify:browser` **24/0**.
- `npm run verify:ui -- --offline` **FAILS — pre-existing, not this change**: proven by
  reproducing the identical crash (`paintQueue → $() → undefined.querySelector`) on the
  untouched `git archive HEAD` copy. Belongs to whatever landed before this ticket.

**package.json NOT touched** (charter). Entry for the orchestrator to add:
`"verify:mcp-attach": "node scripts/verify-mcp-attach.mjs"`.

**Open / handoff:**
- **The turn-one gap is real and NOT fully fixed** — it is now honestly announced, not closed.
  Closing it would mean holding the first prompt until an `init` reports every server
  `connected` (a runtime/bridge change: agent-bridge is contended, so deliberately out of scope
  here). Worth its own ticket, especially for one-shot dispatched agents that only ever take
  ONE turn and therefore NEVER see Serena.
- Container Playwright has the same class of question (npx exists in the image, so it works, but
  its browser download does not) — untested here.
- `public/app.js` is shared with BUG-033's in-flight fix; the hunks are disjoint (label map +
  the `provider-error` case).

### 2026-08-18 — explore dispatch (builds nothing; findings only, status unchanged)
Triggered by a live recurrence: a user opened a `container` session and got the exact
`tooling-unavailable` card this ticket added, naming `serena` with `--project /workspace/<proj>`.
Read-only investigation; no code touched. Conclusions:
- **NOT a regression, NOT diagnosis-only.** The capability WAS delivered: `Dockerfile` installs
  `uv`/`uvx` (asserted `uvx --version` at build) and `tools.ts:serenaMcpServerFor` uses the
  container workdir — the recurrence card already shows `/workspace/<proj>` (container path), so
  CAUSE B is fixed and live. Remaining failure is a **stale image**: the live
  `claude-station-base:u1000-g1000` is ~2 weeks old (predates the uvx line) and `docker run … command -v uvx` → NO_UVX.
- **Root mechanism is image lifecycle, not MCP.** `imageNameFor` tags only by `u{uid}-g{gid}` —
  no Dockerfile-content hash. `ensureImage` skips a build when the tag exists and `driftReasons`
  compares image NAME only, so a Dockerfile change never invalidates the built artifact and the
  container is never auto-rebuilt. Fix delivered but never reaches the user without a manual
  drawer **Rebuild**. This is a general deploy-lag class (any future bake has the same gap).
- **Both container projects affected.** Registry has 2 `isolation:container` projects
  (`<projA>`, `<projB>`), both `serena:true`; both containers run the stale no-uvx image → both
  silently lack `mcp__serena__*` right now (npx-based Playwright/browser still work). Quiet default
  failure, not a one-user papercut.
- **Wiring panel (FEAT-076) does NOT surface it.** `wiring.ts` Integrations row is `state:'info'`
  and just echoes the toggle; it never probes the container for `uvx` or image staleness. The
  natural pre-flight place is silent; the only signal is BUG-035's own card at session START.
- **Supply chain:** serena publishes to PyPI as `serena-agent` (latest 1.7.0, publisher Oraios AI,
  repo URL github.com/oraios/serena). The `uvx --from git+https://github.com/oraios/serena` pull
  can be replaced with a pinned registry install (`uvx --from serena-agent==<ver> serena …`),
  satisfying the WA supply-chain rule. Observation for the user; not changed here.
