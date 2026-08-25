# BUG-108 — Playwright's MCP server was refetched from a mutable `@latest` at every session start

- **Status:** IN VERIFICATION — clean-room verdict was BROKEN (two findings); both are now fixed (see 2026-08-18 second-pass log). Independent re-verify still required before this leaves VERIFIED (regression-prone supply-chain + session-lifecycle lane; two loosenings have been caught here by outside review, so self-verify is explicitly NOT the last word).
- **Severity:** high — a live supply-chain exposure on the hot path (network fetch + version resolution at the moment every opted-in session starts), and an offline session-start failure.
- **Area:** server — MCP provisioning (`tools.ts`) + the pinned-tooling manifest/provisioning added by BUG-107.
- **Reported:** 2026-08-18, from BUG-107's own handoff (item 2: "the only remaining auto-fetch on the hot path").
- **Verification-class:** fix ⟶ independent verification REQUIRED before this moves past VERIFIED (regression-prone lane: it edits BUG-107's provisioning module + two of BUG-107's suites, and folds in two clean-room findings against BUG-107).

## In plain terms

BUG-107 stopped Serena from being downloaded fresh from a moving GitHub branch at every
session start. It left one instance of the same pattern behind: Playwright's browser-automation
MCP server was still launched as `npx -y @playwright/mcp@latest`. `@latest` re-resolves a **mutable
registry tag** over the network every time a session begins, `-y` suppresses the install prompt, and
the whole package is fetched at that moment — the exact "auto-fetching files is too much supply-chain
risk" pattern the user ruled out, still live for the one remaining tool.

**What changed.** Playwright's MCP server is now a **fixed version** (`@playwright/mcp==0.0.79`)
installed **once** into a durable place — baked into the container image, or installed into a Claude
Station folder for direct sessions — exactly like Serena. Starting a session runs a program already
on disk; it downloads nothing and resolves no version.

**The browser wrinkle (determined, and handled where unambiguous).** Playwright drives a real
browser, which is large and fetched separately — "a pinned server that downloads a browser on first
use has only moved the fetch." Its MCP server lists its ~24 tools with **no browser and no network**;
a browser is launched **lazily**, only on the first `browser_navigate`, and its default is the system
`chrome` channel. With no browser present it returns an **actionable error** ("install a browser"),
which is honest and, crucially, **not an auto-fetch at session start**. To make a real navigate work
offline, `tools.ts` points Playwright at a browser that **already exists** (`--executable-path` /
`--cdp-endpoint`): for direct isolation it auto-detects the host's `brave`/`chrome`/`chromium` (this
repo already ships and uses brave for its own checks), so a real navigate works fully offline and
nothing is fetched. **Open decision for the user:** whether to *bake* a browser into the container
image (image size / which browser) or require a container session to be pointed at one via
`CLAUDE_STATION_PLAYWRIGHT_BROWSER` / `CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT`. Until decided, a
container Playwright session must be pointed at a browser via those env vars; it still never
auto-fetches one at session start.

**If you do nothing:** container projects rebuild themselves on next session (the image definition
changed, so BUG-107's staleness check recreates them). Direct sessions need one explicit
`node scripts/provision-tools.mjs --install`, which now provisions **both** Serena and Playwright.

> Everything below is the technical record — reference, not needed to understand the change above.

## Symptom / repro (pre-fix)

The launch command `npx -y @playwright/mcp@latest --headless` reaches the network at session start.
Captured in the act, against the pristine command:

```
# OFFLINE, pristine npx cache — the session-start command CANNOT run without the network:
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/@playwright%2fmcp failed:
      cache mode is 'only-if-cached' but no cached response is available.

# ONLINE — @latest is re-resolved and the package downloaded at session start:
npm http fetch GET 200 https://registry.npmjs.org/@playwright%2fmcp  (cache miss)
npm http fetch GET 200 https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.79.tgz  (cache miss)
Version 0.0.79
```

## Fix

**1. The pin.** `provision.json` gains a `playwright` tool: `@playwright/mcp==0.0.79`,
`installer: "npm-global"`, with the integrity digest and identity evidence recorded (below). Because
`provisionHash()` hashes the whole manifest into the image tag, adding/bumping this pin changes the
image identity and BUG-107's staleness check rebuilds — no separate button.

**2. Provision once, exec locally.** `src/server/provisioning.ts` was generalised to a second
installer: `npm install -g --prefix <dir>` puts the entrypoint at `<dir>/bin/playwright-mcp`, exactly
parallel to Serena's uv `bin/` layout. Container: baked at build to `/usr/local/bin/playwright-mcp`.
Direct: `provisionAllHost()` installs it under the station data dir. `src/server/tools.ts` execs the
absolute local path (`playwrightMcpServerFor`) — no `npx`, no `@latest`, no `-y`, no index, no cache
write at launch. `provisionHost()` is kept as an exact serena-only back-compat wrapper so BUG-107's
suites keep passing verbatim; `provisionAllHost()` is the "provision everything" path.

**3. The browser, without a fetch.** `playwrightBrowserArgs()` resolves a browser from (1) an explicit
CDP endpoint, (2) an explicit executable, or (3) for direct isolation an auto-detected host browser —
never a download. A container is never PATH-scanned (the host PATH is meaningless inside it).

### Package identity — checked before pinning, not assumed

Recorded in `provision.json` under `playwright.identityEvidence` / `.integrity`:

- npm `@playwright/mcp` 0.0.79 — author **Microsoft Corporation**, repository
  `https://github.com/microsoft/playwright-mcp.git`, license Apache-2.0, homepage
  `https://playwright.dev`.
- Maintainers are the Playwright core team **under Microsoft** (`dgozman@microsoft.com`,
  `playwright-npm-bot@microsoft.com`, pavelfeldman, yurys).
- The package's `bin` map is `{ "playwright-mcp": "cli.js" }`, so **the binary we launch comes from
  this package**; `cli.js` requires `playwright-core` (pinned dep `1.63.0-alpha-2026-08-05`).
- The recorded `dist.integrity` (sha512 `VpqD4a3v…qdZQ==`) and tarball shasum (`28a1027e…`) match
  what the registry serves for 0.0.79.
- It is the **scoped** package under the `@playwright` org, not an unscoped lookalike; the previous
  config already fetched this exact scope via `@playwright/mcp@latest`.

## Two clean-room findings against BUG-107, folded in here (I was already in these files)

**FINDING 1 — `provisionHash()` could miss a real change.** It memoised on `(mtime, size)` as a proxy
for "did the inputs change". A same-size, mtime-restored edit (routine on a `git checkout` between
branches) returned the **old** hash → the old image tag was reused → a genuinely changed definition
did **not** rebuild: the exact BUG-107 bug, surviving in a narrower form. Reproduced as a must-FAIL
(`{"h1":"5080fd22dda9","h2":"5080fd22dda9","staleIdentity":true}`, exit 1), then fixed by hashing the
**content** every call (the unsound cache is gone, not "made less wrong" — a content key already
requires reading the content). Anti-regressed in `verify-bug-108` **AF1** (same size + same mtime,
different hash).

**FINDING 2 — a rewritten assertion was genuinely loosened.** `verify-tool-toggle` (5) had gone from
`command === 'uvx'` to `command.endsWith('/serena')` — a suffix that would **accept an
attacker-controlled `/tmp/attacker/serena`** at the pinned position, in a change whose whole purpose
is supply-chain safety. Restored to **exact identity** (`command === hostSerenaBin()`), kept the
`git+` clause, and added the same exact-identity check for Playwright plus a folded-in negative
control (5b) so the loosening cannot silently return.

## Verification (fixer's own run — necessary, never sufficient)

- **MUST-FAIL, captured on current code:** the live `@latest` registry resolution + `.tgz` download at
  session start (offline `ENOTCACHED` on `registry.npmjs.org/@playwright%2fmcp`; online the `@latest`
  GET + tarball GET resolving to 0.0.79). FINDING 1 reproduced (stale identical hash, exit 1).
  FINDING 2 reproduced (`/tmp/attacker/serena` accepted by the old suffix check).
- **`verify:bug-108` 16/16 PASS, exit 0** — incl. a **real container build** that bakes the pin and
  runs it with `--network none` (`playwright-mcp --version` → 0.0.79, 24 MCP tools listed); host
  provision installs once + is a 0ms no-op the second time; a real `browser_navigate` **succeeds
  offline** via the host brave; recorded version == pin == `--version`.
- **Anti-regressions (all real code, exit 0):** `verify:bug-107` **23/23** (unmodified, incl. the
  FINDING-1 property); `verify:mcp-attach` **21/21** (D-section updated — see below);
  `verify:tool-toggle` **16/16** (5 tightened + 5b/7a/7b added); `verify:container` **19/0**;
  `verify:browser` **24/0**; `verify:oom` **5/0**; `verify:bug089` **6/6**; `verify:mcp-ready`
  **10/10**; `verify:feat076` **36/0**; `npm run gate` **PASS, exit 0** (read directly, never piped);
  `tsc --noEmit` **0**.
- **Live-machine safety:** all scratch images/containers were self-created and cleaned; the three real
  `claude-station-base` images and every user container were untouched.

## Sanctioned, flagged edits to BUG-107 assertions

Removing Playwright's session-start fetch **necessarily** changes what BUG-107's `verify-mcp-attach`
D-section can assert: Playwright USED to stay attached in an unprovisioned station **because it was
`npx @latest` fetching live** — the very thing removed here. It is now a pinned provisioned binary too,
so in an unprovisioned scratch station BOTH servers legitimately fail. The selectivity property is
re-proved a **stronger** way — **D4** now requires the report to attribute **each** failed server
**separately with its own exact provisioned command** (serena AND playwright), and **D4b** confirms
Playwright's tools are genuinely absent (no fetch resurrected it); part C still proves a provisioned
Serena attaches, so C-vs-D is the positive/negative control. `verify-tool-toggle` (5) was tightened
per FINDING 2. `verify-bug-107-image-staleness.mjs` was **not** modified. These are called out loudly
because whether those suites were weakened is exactly what the concurrent clean-room pass is checking.

## Context pack

- Files: `src/server/tools.ts` (`playwrightMcpServerFor`, `playwrightBrowserArgs`,
  `findHostBrowserExecutable`, `CONTAINER_PLAYWRIGHT_BIN`), `src/server/provisioning.ts` (generalised:
  `pinFor`/`playwrightPin`/`hostBinFor`/`hostPlaywrightBin`/`hostProvisionStateFor`/`hostProvisionStates`/
  `provisionToolOnHost`/`provisionAllHost`; content-hash fix), `src/server/container/provision.json`
  (the pin + identity evidence), `src/server/container/Dockerfile` (the bake),
  `scripts/provision-tools.mjs` (installs/reports both tools).
- Repro/verify test: `node scripts/verify-bug-108-playwright-pin.mjs` (new). Suggested package.json
  entry (NOT added — package.json is contended): `"verify:bug-108": "node scripts/verify-bug-108-playwright-pin.mjs"`.
- Related: **BUG-107** (the pattern this completes; its two clean-room findings are fixed here),
  FEAT-076 (the wiring panel that should surface provisioned/stale/missing per tool — now has a second
  tool to show), FEAT-033 (Playwright was the kept adoption).

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
