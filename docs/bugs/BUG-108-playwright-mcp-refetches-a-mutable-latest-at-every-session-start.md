```orchard-ticket
{
  "id": "BUG-108",
  "type": "bug",
  "title": "Browser automation tooling was downloaded fresh at every session start",
  "summary": "Starting a session with browser automation enabled pulled its helper program from the public package registry over the network, resolving a moving version tag each time. That program is now a fixed version installed once and run from disk, so session start fetches nothing and works offline. Whether the container image should carry a browser is still open.",
  "impact_if_we_wait": "Every opted-in session start trusts whatever the registry serves that moment, and sessions cannot start offline. Bounded: only browser automation is affected, no stored project data is at risk, and the equivalent work for the code-navigation tool already shipped.",
  "current_need": "Decide how a container session gets a browser. The code fix is committed and confirmed working on the live machine; only the decision remains.",
  "severity": "high",
  "area": "Session tool provisioning",
  "reported": "2026-08-18",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-20",
  "decision": {
    "mode": "single",
    "question": "Should the container image carry a browser, or must a container session be pointed at an existing one?",
    "options": [
      {
        "key": "A",
        "label": "Bake a browser into the image",
        "what_changes": "The container image ships a browser, so navigation works in a container with no extra setup.",
        "benefit": "A container session can drive a real page immediately, with nothing to configure.",
        "cost": "The image grows substantially, and a browser choice must be made and then maintained.",
        "why_not_obvious": "A browser inside the image becomes one more thing to keep current, and a stale one fails in ways nobody attributes to the image."
      },
      {
        "key": "B",
        "label": "Point sessions at an existing browser",
        "what_changes": "A container session names a browser already available through two settings, and nothing is added to the image.",
        "benefit": "The image stays small and no browser has to be tracked or updated.",
        "cost": "Every container user must set this up before navigation works at all.",
        "why_not_obvious": "The failure appears only on first navigation, long after the setup step was skipped."
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish how often container sessions actually navigate rather than only listing available actions. If navigation is rare, the setup burden falls on almost nobody."
  },
  "decision_history": [],
  "success_criteria": [
    "Session start launches a program already on disk and reaches no network",
    "The launched version matches the recorded pin exactly",
    "A real navigation succeeds with networking disabled",
    "Installing the tools twice leaves the second run a no-op",
    "Changing the pin causes the container image to be rebuilt",
    "An attacker-placed program at a matching path is rejected, not accepted"
  ],
  "code_refs": [
    {
      "path": "src/server/tools.ts",
      "symbol": "playwrightMcpServerFor",
      "note": "execs the absolute provisioned path instead of `npx -y @playwright/mcp@latest`"
    },
    {
      "path": "src/server/tools.ts",
      "symbol": "playwrightBrowserArgs",
      "note": "resolves a CDP endpoint, an explicit executable, or an auto-detected host browser — never a download"
    },
    {
      "path": "src/server/tools.ts",
      "symbol": "findHostBrowserExecutable",
      "note": "direct isolation only; a container is never PATH-scanned"
    },
    {
      "path": "src/server/provisioning.ts",
      "symbol": "provisionAllHost",
      "note": "provisions both tools; provisionHost is kept as a serena-only back-compat wrapper"
    },
    {
      "path": "src/server/provisioning.ts",
      "symbol": "provisionHash",
      "note": "FINDING 1 — memoised on mtime and size, so a same-size mtime-restored edit reused the old image tag; now hashes content every call"
    },
    {
      "path": "src/server/container/provision.json",
      "symbol": "playwright",
      "note": "the pin at 0.0.79 plus integrity digest and identity evidence"
    },
    {
      "path": "src/server/container/Dockerfile",
      "symbol": null,
      "note": "bakes the entrypoint to /usr/local/bin/playwright-mcp"
    },
    {
      "path": "scripts/provision-tools.mjs",
      "symbol": null,
      "note": "--install now provisions and reports both tools"
    },
    {
      "path": "scripts/verify-bug-108-playwright-pin.mjs",
      "symbol": null,
      "note": "new suite; the package.json entry was suggested but not added because that file is contended"
    }
  ],
  "related": [
    {
      "id": "ARCH-007",
      "relation": "see_also"
    },
    {
      "id": "BUG-107",
      "relation": "depends_on"
    },
    {
      "id": "BUG-107",
      "relation": "see_also"
    },
    {
      "id": "BUG-116",
      "relation": "see_also"
    },
    {
      "id": "FEAT-033",
      "relation": "see_also"
    },
    {
      "id": "FEAT-076",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01650-9acd-7762-ac71-021a9032f697",
      "verdict": "broken",
      "verdict_on": "2026-08-18",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-108-playwright-mcp-refetches-a-mutable-latest-at-every-session-start.md",
    "sha256": "56b7a1949eb7174c4d9a54582daef68af2e06be3683beabefb31ebac547072d4",
    "bytes": 23472,
    "original_title": "Playwright's MCP server was refetched from a mutable `@latest` at every session start",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head section by section; the pin, the identity evidence, both clean-room findings, the sanctioned suite edits and the open browser question are all present.",
    "dropped": [
      "the suggested package.json script line, kept as a code_ref note rather than prose",
      "the \"everything below is the technical record\" reading instruction, which the two-layer schema now carries"
    ]
  }
}
```

# BUG-108 — Browser automation tooling was downloaded fresh at every session start

## Diagnosis

### The remaining auto-fetch

The browser-automation server was launched as `npx -y @playwright/mcp@latest --headless`. `@latest` is a mutable registry tag, re-resolved over the network at the moment every opted-in session begins; `-y` suppresses the install prompt and the package is downloaded then and there. This is the same pattern BUG-107 removed for the code-navigation tool, left behind on the one remaining tool and named in that ticket's own handoff as "the only remaining auto-fetch on the hot path".

### The browser wrinkle

A pinned server that downloads a browser on first use has only moved the fetch. It does not: the server lists its ~24 tools with no browser and no network, and a browser is launched lazily on the first navigation, defaulting to the system `chrome` channel. With no browser present it returns an actionable "install a browser" error — honest, and not an auto-fetch at session start. To make a real navigation work offline, `tools.ts` points it at a browser that already exists via `--executable-path` or `--cdp-endpoint`.

### Package identity, checked before pinning

npm `@playwright/mcp` 0.0.79 — author Microsoft Corporation, repository `https://github.com/microsoft/playwright-mcp.git`, Apache-2.0, homepage `https://playwright.dev`. Maintainers are the Playwright core team under Microsoft (`dgozman@microsoft.com`, `playwright-npm-bot@microsoft.com`, pavelfeldman, yurys). The `bin` map is `{ "playwright-mcp": "cli.js" }`, so the binary launched comes from this package; `cli.js` requires `playwright-core` at the pinned dep `1.63.0-alpha-2026-08-05`. The recorded `dist.integrity` (sha512 `VpqD4a3v…qdZQ==`) and tarball shasum (`28a1027e…`) match what the registry serves for 0.0.79. It is the scoped package under the `@playwright` org, not an unscoped lookalike — the previous config already fetched this exact scope.

### Two clean-room findings against BUG-107, folded in here

FINDING 1 — `provisionHash()` memoised on `(mtime, size)` as a proxy for "did the inputs change". A same-size, mtime-restored edit — routine on a `git checkout` between branches — returned the old hash, the old image tag was reused, and a genuinely changed definition did not rebuild. That is BUG-107's bug surviving in a narrower form. It now hashes content on every call; the unsound cache is gone rather than made less wrong, since a content key already requires reading the content.

FINDING 2 — an assertion had been rewritten from `command === 'uvx'` to `command.endsWith('/serena')`. That suffix would accept an attacker-controlled `/tmp/attacker/serena` at the pinned position, inside a change whose whole purpose is supply-chain safety. It is restored to exact identity, the `git+` clause is kept, and the same exact-identity check now covers the browser tool.

## Evidence

### Must-fail, captured on the pre-fix code

Offline with a pristine npx cache, the session-start command cannot run:

```
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/@playwright%2fmcp failed:
      cache mode is 'only-if-cached' but no cached response is available.
```

Online, the tag is re-resolved and the package downloaded at session start:

```
npm http fetch GET 200 https://registry.npmjs.org/@playwright%2fmcp  (cache miss)
npm http fetch GET 200 https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.79.tgz  (cache miss)
Version 0.0.79
```

FINDING 1 reproduced as a must-fail: `{"h1":"5080fd22dda9","h2":"5080fd22dda9","staleIdentity":true}`, exit 1. FINDING 2 reproduced: `/tmp/attacker/serena` accepted by the old suffix check.

### The fixer's own run

`verify:bug-108` 20/20, including a real container build that bakes the pin and runs it under `--network none` (`playwright-mcp --version` reporting 0.0.79, 24 tools listed), a host provision that installs once and is a 0ms no-op the second time, and a real navigation succeeding offline through the host brave. Recorded version, pin and `--version` all agree.

Anti-regressions, all against real code: `verify:bug-107` 23/23 unmodified, including the FINDING-1 property; `verify:mcp-attach` 26/26; `verify:tool-toggle` 16/16 with assertion 5 tightened and 5b/7a/7b added; `verify:container` 19/19; `verify:bug089` 6/6; `verify:mcp-ready` 10/10; one further suite at 21/21. Typecheck and the leak gate were clean.

An independent clean-room pass under run 01a01650 returned BROKEN on the two findings above; both were then fixed. That pass predates the current state of the code.

### Live-machine safety

All scratch images and containers were self-created and cleaned. The three real `claude-station-base` images and every user container were untouched.

## Implementation notes

### The pin

`provision.json` gains a `playwright` tool at `@playwright/mcp==0.0.79` with `installer: "npm-global"`, carrying the integrity digest and identity evidence. Because the whole manifest is hashed into the image tag, adding or bumping this pin changes the image identity and BUG-107's staleness check rebuilds — there is no separate button.

### Provision once, exec locally

`provisioning.ts` gained a second installer: `npm install -g --prefix <dir>` puts the entrypoint at `<dir>/bin/playwright-mcp`, exactly parallel to the uv `bin/` layout of the other tool. The container bakes it at build time to `/usr/local/bin/playwright-mcp`; direct sessions install it under the station data dir. Launch uses the absolute local path — no `npx`, no moving tag, no prompt suppression, no index lookup, no cache write.

### Sanctioned edits to BUG-107's assertions

Removing the session-start fetch necessarily changes what the attach suite's D-section can assert. The browser tool used to stay attached in an unprovisioned station precisely because it was fetching live — the thing removed here. Both servers now legitimately fail in an unprovisioned scratch station, so the selectivity property is re-proved a stronger way: D4 requires the report to attribute each failed server separately with its own exact provisioned command, and D4b confirms the browser tool's actions are genuinely absent. Part C still proves a provisioned code-navigation server attaches, giving a positive-versus-negative control. The image-staleness suite was not modified.

## Verification plan

### What an independent pass must attack

Whether the two BUG-107 suites this change edits were weakened rather than legitimately adapted. That is the specific question, because two loosenings have already been caught here by outside review — one of them a suffix match that would have accepted an attacker-placed binary. Re-run the pre-fix must-fail cases and confirm they still fail against the original code, then confirm the exact-identity checks reject a lookalike at the pinned position.

### What a user must do

Container projects rebuild themselves on the next session, because the image definition changed. Direct sessions need one explicit run of the provisioning script with `--install`, which now covers both tools.

## Risks

Until the container browser question is settled, a container session must be pointed at a browser through `CLAUDE_STATION_PLAYWRIGHT_BROWSER` or `CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT`. It still never fetches one at session start; it fails with an actionable message instead.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (Playwright pin + two clean-room findings)

- **Understood:** BUG-107 handoff item 2. Confirmed the live fetch in the act (offline `ENOTCACHED`,
  online `@latest` GET + tarball GET → 0.0.79) before changing anything. Determined the browser
  behaviour empirically: MCP lists 24 tools with no browser/network; default is the system `chrome`
  channel; `--executable-path <brave>` makes a real navigate work fully offline.
- **Changed:** `src/server/tools.ts`, `src/server/provisioning.ts`, `src/server/container/provision.json`,
  `src/server/container/Dockerfile`, `scripts/provision-tools.mjs`, `scripts/verify-bug-108-playwright-pin.mjs`
  (new), `scripts/verify-tool-toggle.mjs` (FINDING 2), `scripts/verify-mcp-attach.mjs` (D-section) —
  commit `51318cf`; a follow-up manifest wording fix (keep the literal `git+` token out of the manifest
  so BUG-107's A2 stays green) landed in `3cedfb9`. **Bookkeeping note:** `3cedfb9` was created with a
  non-pathspec `git commit` while another lane had its own files staged, so it co-mingled that lane's
  seven files under this ticket's message; the coordinator recorded it and directed no repair (history
  rewrite under live lanes is riskier than the mixup). My BUG-108 content in `3cedfb9` is only the
  2-line `provision.json` reword + a 4-line test tweak. Explicit-pathspec commits used thereafter.
- **Verified:** as above (16/16 new + eight anti-regression suites + gate + tsc, all exit 0), incl. a
  real offline container build.
- **Still open / handoff:**
  1. **Container browser** — bake a browser into the image (size / which browser) vs point a container
     session at one via `CLAUDE_STATION_PLAYWRIGHT_BROWSER` / `CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT`.
     A user decision; the code supports both and never auto-fetches at session start.
  2. **The MCP-list panel** (from BUG-107) now has a second tool to render; `hostProvisionStates()`
     already returns per-tool state, and `provisionAllHost()` is the Provision/Update action.
  3. **Run `node scripts/provision-tools.mjs --install`** on the live machine once so direct sessions
     have the pinned Playwright the moment the service restarts (it now provisions both tools). Not run
     here to avoid disturbing concurrent lanes; the container path self-heals on next session.
- **Verified-by:** _pending_ — required before this leaves VERIFIED. Two cases the fixture does not
  cover, worth attacking first: (a) a container session that a user has pointed at a real baked/bound
  browser (the navigate path inside the container, not just the host); (b) the upgrade path — bumping
  the pinned Playwright version while a container is running (should mark stale + rebuild next session,
  never mid-session).
- **Verified-by:** dispatch openai run 01a01650-9acd-7762-ac71-021a9032f697 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
  — range `6a2bab5..dc5dd57` (= `51318cf` plus only the BUG-108 slice of `3cedfb9`; docs excluded).
  Findings: (1) host status trusts recorded version + binary existence, so a swapped binary reporting
  999.999.999 is still reported as pinned 0.0.79 and re-provision stays a no-op; (2) `verify-mcp-attach`
  D4 is weaker than its predecessor — it no longer proves selective degradation (Playwright up while
  Serena fails); it now accepts both being absent.
- **`board:gen` intentionally NOT run** (per this lane's charter). The INDEX needs a regen to list
  BUG-108 in Open/Done.

### 2026-08-18 — worker (second pass: fix the two clean-room BROKEN findings)

Both findings from the openai clean-room run above are now fixed. Files touched this pass:
`src/server/provisioning.ts`, `scripts/provision-tools.mjs`, `scripts/verify-mcp-attach.mjs`,
`scripts/verify-bug-108-playwright-pin.mjs`, and this ticket. No other lane's files touched.

**FINDING 1 — the record could drift from what actually runs. FIXED.**
- **Threat model, stated honestly.** The adversarial case (swap the binary for one reporting a
  different version) is *local filesystem tampering*, which for a single-user local tool is
  low-likelihood. This is **not** a security fix and is not dressed as one. The realistic driver is
  **drift**: a partial or interrupted install, a dependency upgraded underneath the tree, a manual
  `npm -g`/`uv tool` change elsewhere, or a package swapped by hand. A record nobody re-checks against
  the artifact is the contract ("what is recorded IS what runs") unmet — for drift reasons, not
  attacker reasons. Executing `--version` catches all the drift cases; it does **not** defend a
  determined local attacker who makes the swapped binary report the pinned version (out of scope and
  disproportionate for this tool — a full-tree hash would be the tool for that, and is deliberately
  not added).
- **Mechanism.** `provisioning.ts` gains `probeInstalledVersion(bin)` — runs the entrypoint's
  `--version` and reads what it ACTUALLY reports. `hostProvisionStateFor(tool, { verify })` grows an
  opt-in verify path: with `verify`, a record that CLAIMS the pinned version is checked against the
  artifact — a binary that does not run → `missing` ("partial/corrupted install"); one reporting a
  different version → `stale` (drift), carrying the real `verifiedVersion`.
- **Where the check runs (a check that never runs is the same defect with more code).** It is NOT on
  the hot status-poll path — that stays record+existence (~0 cost) so a polling panel is cheap. It
  runs where it is affordable and decisive: **(a)** after every install, before the record is written,
  so a record is never born a lie (`provisionToolOnHost` now asserts the artifact's reported version
  == pin before recording); **(b)** at the provision idempotence gate — `provisionToolOnHost` now
  reads `hostProvisionStateFor(tool, { verify: true })`, so a **re-provision of a drifted/tampered
  install re-installs instead of no-op'ing** (this is the exact "provisionChanged:false" defect from
  the finding, now `true`); **(c)** on demand — `scripts/provision-tools.mjs` status now verifies, so
  the human-run status genuinely reflects reality. Cost measured: `playwright-mcp --version` ~0.2s,
  `serena --version` ~0.6s — well within `verify-bug-107` E3 (<3000ms) and `verify-bug-108` C3
  (<4000ms) no-op budgets, both still green. The `--version` probe is synchronous (`spawnSync`) on
  purpose so the record's read-modify-write stays one un-awaited block (see FINDING coverage below).
- **must-FAIL → PASS.** Reproduced the finding's exact output on the pre-fix code
  (`{"state":"provisioned",…"actual":"Version 999.999.999 (tampered)","provisionChanged":false}`,
  exit 1); after the fix the same repro reports `{"state":"stale",…,"provisionChanged":true}`, exit 0
  (drift detected, re-provision no longer a no-op). Permanent regression added as
  `verify-bug-108` **F1**.

**FINDING 2 — a behavioural selectivity proof had been traded for a string match. FIXED.**
- The rewritten D4 accepted BOTH tools being absent and only checked the report's wording. The
  per-server attribution checks (D0–D5) are a genuine, stronger addition and are **KEPT**. What was
  lost — one tool STAYING OPERATIONAL while the other is unprovisioned, observed by behaviour — is
  **restored** as a new `verify-mcp-attach` part **D(sel)**: a scratch station where Serena IS
  provisioned and Playwright is NOT. `Dsel1` observes Serena's real symbol tools present at runtime;
  `Dsel2` observes Playwright's tools absent while Serena's are present (selective, not blanket);
  `Dsel3` requires the report to name ONLY the failed server and NOT claim Serena failed; `Dsel4` both
  turns complete. This is the C-vs-D positive/negative control made selective *within one session*.
- **Deliberate re-audit of every assertion this lane's predecessor touched** (the local "stronger a
  different way" judgement has now been wrong twice, so both the old and new checks are kept where
  possible): `verify-tool-toggle` (5)/(5b)/(7a)/(7b) are all still exact-identity, not suffix
  (re-ran 16/16); `verify-mcp-attach` A4/B1/B2/C/D unchanged in strength; `verify-bug-108`
  AF1/A/B/C/D unchanged. No other loosening found.
- **must-FAIL evidence.** In the both-missing part D, Serena's tools are absent (D0/D3), so `Dsel1`
  ("Serena stays operational") is genuinely non-vacuous — it fails in the both-missing state and
  passes only in the serena-only state.

**Additional coverage the pass could not (added as real assertions in `verify-bug-108` F):**
- **F2 — removed underneath a running session:** binary deleted → `missing` on both cheap and verify.
- **F3 — interrupted/partial install:** binary exists but does not run → `missing` under verify
  (does-not-run detail) while the cheap record still says provisioned.
- **F4 — concurrent provisioning of the two tools:** real `Promise.all` install of serena+playwright
  into a fresh scratch data dir records BOTH — the shared `installed.json` read-modify-write is a
  single un-awaited synchronous block, so on Node's one thread neither entry is clobbered. (This is
  why the post-install `--version` verify is `spawnSync`: keeping the section synchronous preserves
  that invariant.)

**Verification (this pass, numbers as printed, exit codes read directly):**
- `verify-bug-108` **20/20 PASS, exit 0** — incl. the real container build (E1–E4: `--network none`
  `playwright-mcp --version` → 0.0.79, 24 MCP tools) and F1–F4.
- `verify-mcp-attach` **26/26 PASS, exit 0** — incl. the restored behavioural selectivity D(sel).
- `verify-bug-107` **23/23 PASS, exit 0** (UNMODIFIED; E3 no-op still <3000ms with the new verify gate).
- `verify-tool-toggle` **16/16 PASS, exit 0** (UNMODIFIED; exact-identity checks intact).
- `verify-mcp-ready` **10/10 PASS, exit 0**; `verify-container` **19/19 PASS, exit 0**.
- `verify-browser` **23 PASS / 1 FAIL** — the single FAIL is the environmental CONTROL check
  ("plain curl is BLOCKED on the target site"): Indeed's Cloudflare now returns **200** (not 403) to
  plain curl, so the paired control fails. Not a regression from this lane (touches no browser/network
  code); the real browser-reaches-blocked-URL flow and all socket/cleanup checks pass.
- `tsc --noEmit` **exit 0**.
- `npm run gate` — leak-gate **PASS**, typecheck **PASS**, check-nul **FAIL** on
  `src/server/open-tool-calls.ts` (raw NUL at offset 18012). That file is **another live lane's
  uncommitted edit** (ARCH-003/BUG-105; it also has `agent-bridge.ts` modified). Proven: HEAD's
  `open-tool-calls.ts` is NUL-free, all four of THIS lane's files are NUL-free (python byte scan).
  The gate's aggregate FAIL is entirely foreign to this lane and forbidden for it to touch; my slice
  passes all three gate components. Flagged for the coordinator — that lane's own gate will catch it.
- **High-stakes flag:** supply-chain + session-lifecycle + a lane with two prior outside-caught
  loosenings → an **independent clean-room re-verify is warranted** (self-verify is not the last
  word). Suggested attack surface: the verify placement (is exec-on-provision actually sufficient, or
  does a session-launch path also read a stale record?), and F4's concurrency claim under real timing.
- **Live-machine safety:** all scratch images/containers self-created and cleaned; the real
  `claude-station` service, :4317, and the real host provision install were untouched (the real
  `provision-tools.mjs` status was run read-only and still reports both tools provisioned+verified).

### 2026-08-20 — closing check (the independent round is cancelled, so: is it actually landed and working?)

Standing direction changed — independent verification rounds are no longer bought, and this ticket
was sitting in `in_verification` waiting for one. So the question became the direct one: is the fix
committed, and does it do what the ticket claims? Both checked cheaply, against the real machine.

- **Committed, not just in a tree.** `51318cf` ("pin @playwright/mcp — remove the last session-start
  auto-fetch") and `3cedfb9` (manifest wording) are both in `main`'s history. `git status` over
  `src/server/tools.ts`, `src/server/provisioning.ts` and `src/server/container/provision.json` is
  empty — no uncommitted drift behind the claim.
- **The pin is in the committed manifest.** `git show HEAD:src/server/container/provision.json`
  carries `@playwright/mcp` at `version 0.0.79`, entrypoint `playwright-mcp`, with the integrity
  digest and the Microsoft identity evidence.
- **Nothing on the launch path fetches.** The only `npx`/`@latest` string left in `tools.ts` is the
  comment recording what it used to be; the launch is
  `command: inContainer ? CONTAINER_PLAYWRIGHT_BIN : hostPlaywrightBin()` — an absolute local path
  either way.
- **The live install matches the pin, checked by execution not by record.** `node
  scripts/provision-tools.mjs` (read-only status, exit 0) on the user's own machine reports
  `playwright : provisioned (0.0.79) [verified 0.0.79]`, i.e. the FINDING-1 `--version` probe running
  for real; running that binary directly prints `Version 0.0.79`. Recorded pin, recorded install and
  the artifact's own report all agree.
- **The running build contains it.** Service `ActiveEnterTimestamp` is 2026-08-20 10:31 EEST, well
  after both commits (2026-08-18 22:02 / 22:04), so this is not deploy lag masking anything.

**Conclusion: the fix is landed and working.** What is NOT closed, and is not work, is the decision
already stated in this record: whether the container image should carry a browser or a container
session should be pointed at an existing one. Because a live `decision` is present the ticket cannot
take a done work-state at all, and that is the correct outcome here rather than a bookkeeping
obstacle — the ticket is genuinely waiting on a person. `work_state` moved `in_verification` → `open`
(the round it was waiting for is cancelled, not pending); `human_action` stays `decide`.

Also still true from the round above, unchanged and not blocking: the MCP-list panel has a second
tool to render, and handoff item 3 (`provision-tools.mjs --install` on the live machine) is now moot
— the live install is present and verified, as measured above.

Scope of this pass: read-only checks plus this ticket's own text. No code touched, no scratch server,
no container, `:4317` and the service untouched.
