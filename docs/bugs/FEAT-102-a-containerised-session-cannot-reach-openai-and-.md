```orchard-ticket
{
  "id": "FEAT-102",
  "type": "feature",
  "title": "A containerised session cannot reach openai, and is told to try anyway",
  "summary": "A session Orchard launches for a containerised project cannot dispatch to openai: no dispatch script, no codex binary, no credential, no channel home. The injected routing text tells it to try anyway. Fix by brokering on the host over a per-project unix socket, entitled per project and discoverable from inside the session.",
  "impact_if_we_wait": "Every containerised project is Claude-only in practice while being instructed at launch to use a cross-provider capability it does not have, so cross-provider verification (FEAT-060/FEAT-061) is unavailable exactly where isolation matters most, and each session burns a round discovering the gap for itself.",
  "current_need": "One independent clean-room round, scoped to cross-project isolation: can one project container reach another project broker or tree, and does the protocol hold on partial frames and peer death. Everything else on this ticket is proven.",
  "severity": "high",
  "area": "container / dispatch",
  "reported": "2026-08-22",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A real Orchard session in a containerised project dispatches to openai and receives the result — proven live, not by unit test.",
    "A session that is NOT entitled is told so explicitly, naming the toggle, rather than silently failing or scanning fruitlessly.",
    "One cheap command answers whether openai dispatch is available here, and the injected routing text states the exact command to run.",
    "No OpenAI credential and no codex binary enters any project container.",
    "A down or absent broker cannot brick a project container (BUG-136 missing-source bind skip is honoured).",
    "Direct-isolation projects use the same entry point, not a second mechanism."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "arch",
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

# FEAT-102 — A containerised session cannot reach openai, and is told to try anyway

## Symptom
A session Orchard launched for the containerised project `project A (a containerised project)` was asked to use
OpenAI subagents. Its own scan, verbatim:

> "I can't run OpenAI subagents in this sandbox: no dispatch CLI, no claude-station repo,
> no OpenAI CLI/key. My subagents are Claude-only."

The user: *"it should be able to if u can, so idk whats missing, if its a bug pls fix"* and
*"if claude works, surely openai can be made to work too"*.

The report was mechanically correct on every count. Worse, the session was TOLD to try:
`routingSection()` (src/server/templates.ts:349-376) is injected unconditionally into every
launched session via `composeInstructions(..., { routing: true })` (agent-bridge.ts:741-745),
reading the ORCHARD checkout's docs/prompts/ROUTING.md regardless of which project or
isolation mode is launching. Every containerised session is currently instructed, at launch,
to use a capability its sandbox provably does not have.

## Repro
Launch a session for `project A (a containerised project)` (isolation=container). Ask it to dispatch a task to
openai. It scans, finds nothing, and correctly refuses.

## Expected
A session in another project can dispatch work to openai and get the result back — and can
cheaply tell, from inside the session, whether it is entitled to.

## Shape of the gap (established by scan, 2026-08-22)

CONTAINER-ONLY GAP, plus a lesser discovery/ergonomics gap on direct.

**Direct isolation, non-orchard project: WORKS TODAY.** Exact path:
`node <orchard>/scripts/dispatch.mjs --provider openai --cwd <project> "task"`.
dispatch.mjs derives ROOT from import.meta.url, imports .ts by absolute path (native type
stripping, needs node >= 23), needs no node_modules, no build, no CLAUDE_STATION_DATA.
`detectCodex()` returns connected from any cwd. What does NOT work from another project is
the exact incantation the injected routing text prescribes — `npm run dispatch -- ...` —
because `npm run` needs package.json in cwd.

**Container isolation: FOUR independent blockers, any one fatal.**
1. scripts/dispatch.mjs is not in the container. `desiredBinds()`
   (src/server/container-manager.ts:254-365) mounts the project dir, the Claude credentials
   file, the project's own history dir, and declared user mounts. Orchard is not among them.
2. No `codex` binary in the image (src/server/container/Dockerfile installs claude-code, uv,
   serena, playwright-mcp). agent-bridge.ts:936-937 already says it will "honestly ENOENT
   ... until an image ships it".
3. No OpenAI credentials cross the boundary: ~/.codex/auth.json is not bound, CODEX_HOME is
   not in ENV_PASSTHROUGH (container-manager.ts:1173-1189), and the auth model is
   OAuth-file-only by design (codex-runtime.ts:23-26) — there is no API-key path to forward
   even if one wanted to.
4. No channel back to the host: the API binds 127.0.0.1 (index.ts:95) while the container
   sits on the default bridge with only host.docker.internal:host-gateway. There is no
   socket and no HTTP verb for "run a dispatch".
   (The image's Node 20 would also refuse dispatch.mjs's .ts imports even if 1-3 were solved.)

## The design decision, re-derived honestly

The initial framing — "a live API key must not sit inside a project sandbox" — does not
hold here, and it was right to be challenged. **A Claude credential is ALREADY mounted into
every project container** (~/.claude/.credentials.json, container-manager.ts:266-271).
Credential-in-container is the established posture of this codebase, not a line it refuses
to cross. Refusing an OpenAI credential on security grounds would be inconsistent.

So the route is chosen on merits, not on a security asymmetry:

- **Option A — mount the credential.** Bake `codex` into the container image, bind
  ~/.codex/auth.json, upgrade the image to Node >= 23, mount or copy dispatch.mjs. Simple in
  concept, and matches what already exists. Costs: a full image rebuild affecting every
  containerised project; a SECOND rotating secret mounted as a single file (see the sibling
  ticket) — today's stale-inode failure class, doubled; Codex's own seccomp/landlock sandbox
  may not initialise inside Docker (codex-runtime.ts:203-206), so the dispatched side loses
  its wall; and cross-provider spend becomes unattributable and uncappable, since each
  container spends the user's subscription quota independently with no single view.
- **Option B (CHOSEN) — broker on the host, over a per-project unix socket.** codex, the
  OAuth file, and dispatch.mjs all stay on the host. What crosses the boundary is one 0600
  unix socket owned by the host uid, plus a read-only single-file client shim. The session
  calls the shim; the shim speaks a small JSON protocol to a host-side broker; the broker
  runs the existing dispatch and streams the result back.

**Why B, on its own merits:**
- It is not a new pattern — it is the SAME pattern this repo already ships and trusts for
  the stealth browser (container-manager.ts:282-318, src/server/sbmcp-lazy-shim.mjs,
  src/server/browser.ts): "Chrome itself stays on the host. What crosses the boundary is one
  0600 unix socket owned by the host uid plus a read-only single-file shim. There is no TCP
  listener anywhere, so a container gets exactly one browser: its own." Substitute codex for
  Chrome and the sentence is unchanged. It therefore inherits an already-reviewed trust
  boundary rather than opening a new one, and satisfies the BUG-107/BUG-108 no-auto-fetch,
  pinned-and-baked doctrine trivially: nothing new is fetched or installed.
- No second rotating secret, so no second stale-inode class.
- No new image required for the mechanism: the client shim is a plain .mjs socket client,
  which Node 20 runs fine. The .ts-import / Node>=23 requirement stays on the host side
  where it is already satisfied.
- One place where cross-provider spend is visible and cappable, and every dispatch lands in
  the Orchard transcript store as it already does.
- The SAME entry point serves direct-isolation projects, so there is one mechanism to
  document and one answer to "how do I call it", not two.
- No third-party MCP server and no npm wrapper — the FEAT-099 constraint, stated twice:
  "no npm git library and no third-party GitHub MCP server, because each would add a
  supply-chain trust boundary for something two argv calls do."

## Entitlement and discoverability (both are deliverables)

Entitlement is per project and decided at session launch, matching how tools already work
(`ToolSettings`, src/server/registry.ts:98-112 — today exactly `serena` and `playwright`).
Default OFF. A session that is NOT entitled must be TOLD SO, not fail silently.

Discoverability is half the bug. The project A (a containerised project) session had no capability AND no way to ask;
it scanned for a binary and a key and concluded correctly. A session that HAS the capability
but cannot tell is to be treated as not having it. So: the injected routing section must
become capability-aware (say the exact command THIS session can run, or say plainly that
openai dispatch is not enabled for this project and name the toggle), and there must be a
cheap in-session self-check that answers "can I use openai here?".

## Context pack (grows)
- Files/functions in play: src/server/container-manager.ts (desiredBinds :254-365,
  ENV_PASSTHROUGH :1173-1189, create args :1030-1047, validateMounts :432-464),
  src/server/browser.ts (the per-project socket derivation to copy),
  src/server/sbmcp-lazy-shim.mjs (the read-only shim precedent), src/server/agent-bridge.ts
  (:902-1003 launch switch, :741-745 instruction composition), src/server/templates.ts
  (routingSection :349-376), src/server/registry.ts (:98-112 ToolSettings),
  src/server/tools.ts (plannedMcpServers :179-187), scripts/dispatch.mjs,
  src/server/runtime/codex-runtime.ts, src/server/container/Dockerfile.
- Related tickets: FEAT-043 (built dispatch.mjs; scoped to "any orchestrator session invokes
  THIS script via Bash" and never said which projects can reach it), FEAT-037, FEAT-044
  (first non-orchard proof — but a DIRECT project on the same host), FEAT-096 (already flags
  dispatch reachability as fragile), FEAT-100 (in progress, adds --ticket/--phase/--round),
  BUG-092 (codex sandbox: AF_UNIX connect() is EPERM under seccomp — the dispatched side
  cannot bind a port or connect a socket; the container CLIENT is unaffected, no codex
  sandbox is involved on that side), FEAT-023 (parked remote control plane; its criteria
  "No container can read another project's credentials" and "Nothing binds beyond loopback"
  are honoured by the unix-socket shape), BUG-136 (bind self-heal — any new bind must adopt
  the missing-source skip so a down broker cannot brick a project).
- Known dependencies / blockers: none. Nothing on the board previously covered
  cross-provider dispatch from a non-orchard project.

## Success criterion
A real session, launched by Orchard for project A (a containerised project), dispatches work to openai and gets the
result back. Not a unit test of the plumbing. Nothing else counts.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-22 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-22 — orchestrator
- **build + live proof:** - **Understood:** A session launched for a containerised project could not dispatch to openai, and was told at launch to try — routingSection() is injected unconditionally. Scan established four independent container blockers (no dispatch script, no codex binary, no credential, no channel to the host; plus the image's node 20 vs dispatch.mjs's node>=23). Direct-isolation projects could already dispatch via the absolute path; only `npm run dispatch` (needs package.json in cwd) failed there.
  - **Decision re-derived, not inherited:** the opening framing ("a live key must not sit in a project sandbox") does NOT hold — a Claude credential is already mounted into every project container. Credential-in-container is this codebase's established posture. Option B (host broker) was chosen on merits instead: it is the SAME shape the stealth browser already ships and trusts (host keeps the engine, one 0600 per-project unix socket plus a read-only shim cross the boundary, no TCP anywhere), it adds no second rotating secret (ARCH-012), it needs no image rebuild because the shim is Node-20-safe, it gives one place where cross-provider spend is visible, and one entry point serves direct and container alike.
  - **Changed:**
    - NEW `src/server/dispatch-broker.ts` — per-project socket `<dispatchStateHome()>/<projectId>/dispatch.sock` (dir 0700, socket 0600), NDJSON protocol (`capabilities` / `dispatch`, streamed `progress` frames, exactly one guaranteed terminal `result` frame). Runs the existing scripts/dispatch.mjs on the HOST with `--cwd` FORCED to the owning project's hostPath, prompt over `--prompt-stdin` (never argv: E2BIG), closed allow-lists on every field, clamped timeout, per-project and global concurrency caps that refuse loudly rather than queue silently.
    - NEW `src/server/dispatch-client.mjs` — Node-20-safe, builtins-only shim, bind-mounted read-only at /opt/orchard-dispatch. Same CLI contract as dispatch.mjs. `--check` answers "can I use openai here?" and exits nonzero, naming the toggle, when not.
    - `registry.ts` / `validate.ts` / `wiring.ts` / `public/lib/drawer.js` — per-project `settings.tools.openaiDispatch`, default OFF, alongside serena/playwright, with its own drawer toggle row.
    - `agent-bridge.ts` — broker started at session launch for entitled projects (NON-FATAL if it cannot start: the session still starts, without the capability, and says so), launch-scoped env (ORCHARD_DISPATCH_ENTITLED / _SOCK / _CMD) via a new RuntimeStartConfig.env seam, and an injected "OpenAI dispatch availability" section that states the exact command THIS session can run or names the toggle to enable.
    - `container-manager.ts` — the per-project socket DIRECTORY bound read-only (not the socket file: a file bind holds the inode and would have re-created the ARCH-012 class on every broker restart; a directory bind sees a replacement socket inode immediately), env passthrough, validateMounts refusing user mounts that shadow the container paths or reach into broker state, and the BUG-136 missing-source skip so a down broker cannot brick a container.
  - **Verified (fixer's own, host-run):** `node scripts/verify-feat-102-static.mjs` 10 PASS / 0 FAIL; `verify-feat-102-entitlement.mjs` 3 PASS / 0 FAIL; `verify-feat-102-dispatch-broker.mjs` 25 PASS / 0 FAIL — 38/38. Covers forced-cwd and traversal, flag injection through all eight request fields, the concurrency cap, NDJSON frames split across arbitrary chunk boundaries (1/1/1, 5/7/3, 20/2/40), peer death mid-frame, terminal-frame guarantee on spawn error / nonzero exit / timeout, the BUG-136 skip, entitlement OFF, and the must-FAIL restart proof (same bound directory sees a replacement socket inode — this test fails against a socket-FILE bind and passes against the directory bind). `npm run gate`: PASS, exit 0, read directly.
    NOTE: the openai builder could not run the socket suites in its own sandbox — `listen(AF_UNIX)` is EPERM there, the same seccomp block BUG-092 documented. Every count above was produced on the host.
  - **Verified LIVE (the ticket's only success criterion):** a real session, launched by Orchard for a containerised non-orchard project, ran `$ORCHARD_DISPATCH_CMD --check` (printed "openai dispatch: available", route = host broker unix socket) and then dispatched to openai and got `broker proof ok` back into the session. Host-side confirmation: a real openai transcript was written under `<dataDir>/transcripts/openai/...`, run id `01a0287e-e069-7702-a277-b975b257b47c`, with cwd forced to the project's HOST path. Negative half also proven live: with the toggle OFF a fresh session's instructions say "OpenAI dispatch is NOT enabled for this project", ORCHARD_DISPATCH_CMD/_SOCK are unset, /opt/orchard-dispatch is not mounted, and `--check` exits 1 naming `settings.tools.openaiDispatch`. Also proven: a container created while the toggle was OFF picks the binds up automatically on the next session start via drift-recreate — no explicit rebuild needed. The live project was a synthetic realistic-state git repo created for the proof; no real user project was touched.
  - **Verified-by:** NOT YET — independent clean-room verification is REQUIRED before VERIFIED and has not been run. This is a session-lifecycle change on a new host-to-container trust boundary, so the fixer's own suite is explicitly not the last word. The attack a verifier should reframe around: can one project's container reach another project's broker or tree (the forced-cwd and per-project-directory invariants), and does the protocol hold when frames arrive partial or the peer dies at an arbitrary point.
  - **Dispatch runs (openai, gpt-5.6-sol):** round 1 build `01a02869-eb15-7851-8aa5-f75247b89b42` (101,160 tokens); round 2 corrections `01a02873-256b-7702-8480-1944b0f1d5f9` (65,954 tokens); live proof dispatch `01a0287e-e069-7702-a277-b975b257b47c` (14,613 tokens).
  - **Still open / handoff:** independent verification; and the openai builder's round-1 report claimed a UI toggle and a passing gate that its own sandbox could not actually produce — a reminder that a sandboxed builder's self-report needs host re-running, not trust.
  - **Symptom of a deeper design flaw?** yes — ARCH-012 filed (a rotating secret, or any inode-identified resource, mounted as a single FILE bind goes stale invisibly). This build avoided adding an instance by binding a directory; the stealth browser's socket file bind still has the latent property and now carries a comment pointing at ARCH-012.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user) — re-checked, NOT closed, and deliberately so. Re-ran all three suites on the host at HEAD b6c0151: `verify-feat-102-static.mjs` 10/0, `verify-feat-102-entitlement.mjs` 3/0, `verify-feat-102-dispatch-broker.mjs` 25/0 — 38/38, each exit 0 read directly. The code is committed (ae46280), not sitting in a worktree, and the ticket own and only success criterion was already proven LIVE: a real Orchard session in a containerised project dispatched to openai and got the result back, with the host-side transcript to show for it. Why this one stays in verification while nine of its neighbours closed today: rounds are now spent by HARM CLASS, and this is the highest class on the board — a new host-to-container trust boundary carrying a credential-backed capability, where the failure mode is one project reaching another project broker or tree. That is precisely the case a fixer own suite cannot settle, because the fixer chose the boundary. One round, scoped to isolation and to partial/truncated frames, and this closes. It is not waiting on the old every-change rule; it is waiting on the one round its harm class actually buys.
