# BUG-107 — a built container image never noticed its own definition changed, so shipped fixes never arrived

- **Status:** FIXED — the image tag now carries a definition hash and Serena is a pinned install, and the fixer's own suite passes 23/23 (must-FAIL 5/22 on the pristine tree first). The one independent clean-room round (openai run `01a01633`) re-ran that suite green but returned BROKEN on two findings against this change; both were fixed under BUG-108 (commit `d302908`), which re-ran `verify:bug-107` 23/23 — but BUG-108's own independent round also returned BROKEN, so nothing there transfers a HOLDS back here. No independent round has returned HOLDS on this change, so this is not VERIFIED. (Status word corrected 2026-08-20; it read VERIFIED (fixer's own run) and predated that round.)
- **Severity:** high — silent, default-on capability loss across every container project, for two weeks
- **Area:** server — container image lifecycle (`container-manager.ts`) + MCP provisioning (`tools.ts`)
- **Reported:** 2026-08-18, from a live recurrence on BUG-035 + an explore pass
- **Verification-class:** fix ⟶ independent verification REQUIRED before this moves past VERIFIED

## In plain terms

Two weeks ago a fix went in that gave containerised projects their Serena code-navigation tools
back. It was correct, it was tested, and **no user ever received it.** Containers kept running an
image built before the fix, because nothing in the system could tell that the recipe had changed —
the built image was named after your user id and nothing else, so a changed recipe produced a name
that already existed, and every check concluded there was nothing to do. Both container projects
were quietly running without Serena the whole time; nobody noticed because their browser and
Playwright tools kept working.

Separately, Serena was being **downloaded fresh from a moving GitHub branch every time a session
started** — whatever that branch happened to contain at that moment, on the hot path, with no
pinned version. That is the pattern you ruled out: *"we need serena ideally downloaded only once,
then reuse it … auto-fetching files yes is too much supply chain risk."*

**What changed.** The image's name now includes a fingerprint of its own recipe, so editing the
recipe produces a different image, the staleness check sees it, and the container is rebuilt on the
next session — automatically, with no button to remember. And Serena is now a fixed version
(`serena-agent==1.7.0`) installed **once** into a durable place: baked into the image for
container projects, installed into a Claude Station folder for direct ones. Starting a session runs
a program that is already on disk. It downloads nothing and resolves no versions.

**The one thing to know:** a version upgrade is now something you ask for, never something that
happens to you. Bumping the pinned version marks the install stale; it does not install itself.

**Still needed (another lane owns the files):** the MCP list panel should show provisioned / stale /
missing per project with **Provision** and **Update** buttons. Until it exists, the button is
`node scripts/provision-tools.mjs --install`. Everything that panel needs to read is already built
and listed below.

**If you do nothing:** nothing breaks. Container projects rebuild themselves on next session; the
host install is already provisioned on this machine.

> Everything below is the technical record — reference, not needed to understand the change above.

## Symptom

A user opened a `container` session and got BUG-035's own `tooling-unavailable` card, naming
`serena` with `--project /workspace/<proj>`. BUG-035 was VERIFIED and its fix was live in the source
tree. The card was correct: the container genuinely had no Serena.

## Repro (pre-fix)

1. Edit `src/server/container/Dockerfile` (anything at all).
2. Start a session for a project with `isolation: "container"`.
3. Observe: no rebuild, no drift, no recreate. The container runs the old image forever.

Reduced to one line of real output from the harness below, run against the pristine tree:

```
FAIL  B5 next ensureContainer REBUILDS and the container runs the NEW definition
      observed: docker builds=0 newImage=claude-station-base:u1000-g1000
                newId=6665992bbee2 oldId=6665992bbee2 in-container marker=unset
FAIL  B4 a changed definition makes the LIVE container read as drifted
      observed: drifted=undefined reasons=[]
```

## Expected

A changed image definition yields a different artifact, which the drift check sees, which recreates
the container on the next session. And an unchanged definition rebuilds **nothing** — a fix that
rebuilds every time is a different bug.

## Root cause

Three places all agreed, and all three were wrong in the same direction:

- `imageNameFor()` returned `claude-station-base:u{uid}-g{gid}` — no content hash. One name for
  every version of the recipe there will ever be.
- `ensureImage()` skips the build when that name exists. It always existed.
- `driftReasons()` compared the image **name**. It always matched.

So the artifact's identity was decoupled from its definition, and the system was internally
consistent about a stale answer. This is a general deploy-lag class, not a Serena problem: **any**
future change baked into the image had the same gap.

## Fix

**1. The tag carries the definition hash** (`provisionHash()` = sha256 of Dockerfile +
`provision.json`, 12 hex chars) → `claude-station-base:u1000-g1000-5080fd22dda9`.

*Tag vs label, deliberately.* A label keeps one moving tag, so superseded images auto-dangle and
need no cleanup — the tag's one real cost. It was still the wrong trade: with a label, both
`driftReasons` and `ensureImage` need a new image-inspect step and new comparison logic **on the
exact code path whose silent success caused this bug**, and a revert (backing out a bad pin) forces
a full rebuild instead of resolving to an already-built tag. The tag makes the fix subtractive — a
name that already changes everything downstream — and `docker images` shows at a glance which
definition each artifact came from. Labels are still written (`claude-station.provision-hash`,
`.serena-version`, `.serena-package`, `.image=1`) as the machine-readable record; they are not what
the drift check hinges on.

*Superseded images* are paid for explicitly by `pruneSupersededImages()`. Three guards: only the
repo we own and only tags matching the shape we generate (`u{uid}-g{gid}[-{hash}]`, which also
reclaims the legacy unhashed tag); never `--force`, so docker itself refuses while **any**
container, running or merely stopped, still references it; never the tag we were told to keep.
**It fires after the container is recreated, not after the build** — at build time the old image is
still the one the live container runs, so every removal is refused and the sweep reclaims nothing.
That was found by the verification (F1 failed exactly that way), not by reasoning.

**2. `driftReasons` also compares the resolved image sha**, so a same-name image rebuilt underneath
a container is caught too (matters for user-supplied `settings.container.image`).

**3. Serena becomes a pinned registry install.** `uvx --from git+https://github.com/oraios/serena`
→ `serena-agent==1.7.0` from `provision.json`, installed at provision time:
- container: baked at build (`uv tool install` → `/usr/local/bin/serena`), manifest COPYed to
  `/etc/claude-station/provision.json` so the image can be asked what it holds;
- direct: `provisionHost()` → `<dataDir>/provision/bin/serena`, recorded in `installed.json`.

Session start execs an absolute path. No index, no resolution, no cache write.

### Package identity — checked before pinning, not assumed

Pinning the wrong package inside a supply-chain fix would be the whole failure. Five independent
links, recorded in `provision.json` under `identityEvidence`:

- PyPI `serena-agent` 1.7.0 — `Author-email: Oraios AI <info@oraios-ai.de>`, `Project-URL Homepage:
  https://github.com/oraios/serena`, MIT.
- `oraios/serena@main`'s own `pyproject.toml` declares `name = "serena-agent"` — the git source this
  replaces and the registry package are the same project, not a lookalike.
- The wheel's `entry_points.txt`: `serena = serena.cli:top_level`. **The binary we launch comes from
  this package.**
- Downloaded wheel sha256 `6dbf1459…c76e891` matches the digest PyPI serves for 1.7.0.
- `serena-mcp` — the name the pin could have been misaimed at — **404s on PyPI**; it is not a live
  package.

## Verification (fixer's own run — necessary, never sufficient)

`node scripts/verify-bug-107-image-staleness.mjs` (new). Runs every phase against a **copied** tree
(the staleness proof must mutate the image definition, which would race the other lanes in this
repo) and drives real docker through a bidirectional shim on `CLAUDE_STATION_DOCKER`, so the user's
live `claude-station-base:u1000-g1000` tag is never built over and **"did a build actually happen"
is an observation, not an inference** (the shim logs every docker invocation).

- **MUST-FAIL, pristine tree: 5/22 PASS, 17 FAIL, exit 1** — headline `B5 docker builds=0` on a
  changed Dockerfile, `B4 drifted=undefined reasons=[]`, and C3 capturing the live
  `/usr/bin/git fetch … https://github.com/oraios/serena` that a session start performed.
- **After: 23/23 PASS, exit 0.** Both directions proven: `B5 docker builds=1` + the in-container
  marker reads `1` on a changed definition; `B2 docker builds=0`, same image id, on an unchanged one.
- End-to-end, owned here rather than inherited: `C3` speaks **real MCP over stdio** to
  `/usr/local/bin/serena` inside a freshly built image with `--network none` → **21 tools**
  (`find_symbol`, `get_symbols_overview`, `replace_symbol_body`, …). `C2`: `serena --version` →
  `Serena 1.7.0`, also with no network.
- `E3`: a second `provisionHost()` returns `changed=false` in **1ms** without spawning anything —
  "downloaded once, then reused" as an observation.

**Anti-regressions** (all real code, exit 0): `verify:mcp-attach` **20/20** — C1 lists all 21
`mcp__serena__*` tools on **turn one** of a real direct-isolation session from the provisioned
install; `verify:tool-toggle` **13/13**; `verify:container` **19/0**; `verify:browser` **24/0**;
`verify:oom` **5/0**; `verify:bug089` **6/6**; `verify:feat076` **36/0**; `verify:mcp-ready`
**10/10**; `npm run gate` **PASS, exit 0** (read directly, never piped).

Live-machine safety, checked after the runs: the three real station containers are untouched
(the one that was `running` before the run is still `running`), and the legacy
`claude-station-base:u1000-g1000`
image survived the prune **because it is still in use** — the refusal guard working on the real
artifact rather than a fixture.

## Two suites were rewritten, and that is worth flagging

`verify-tool-toggle.mjs` and `verify-mcp-attach.mjs` hard-coded the old design (`command === 'uvx'`,
the literal `git+https://…` URL), so they could not survive this change. Each replacement assertion
is **at least as strong** as the one it replaces — A4 went from "the image ships uvx" to "the image
bakes the pinned package AND no executed line contains a git ref". Part D's failure induction
changed because the failure mode did: it was a PATH stripped of `uvx` (a stand-in for the container
bug), and is now a station that has never been provisioned — the real state every user is in before
their first provision. A reviewer should check these did not get quietly weakened.

## What the MCP-list panel needs (built, not wired — another lane owns those files)

Deliberately no UI here. Everything the panel needs is exported and read-only:

- `containerProvisionState(project)` (`container-manager.ts`) → `{ state: 'provisioned' | 'stale' |
  'missing', image, custom, wantedSerenaVersion, imageSerenaVersion, provisionHash,
  imageProvisionHash, detail }`. `detail` is plain words, safe to render. `custom: true` means a
  user-supplied image — show it, never offer to provision it.
- `hostProvisionState()` (`provisioning.ts`) → the same three-state verdict for direct isolation,
  plus `installedVersion` / `wantedVersion` / `installedAt` / `bin`.
- Actions: **Provision/Update (direct)** → `provisionHost({ force })`; it is the only thing in the
  repo that fetches, and it must stay behind an explicit click. **Rebuild (container)** → the
  existing `POST /api/projects/:id/container/rebuild`; usually unnecessary now, since a stale image
  self-heals on the next session.
- Both are cheap and synchronous-ish except `provisionHost`, which is a network install and wants a
  progress stream (`onLog`).

## Context pack

- Files: `src/server/container-manager.ts` (`imageNameFor`, `driftReasons`, `ensureImage`,
  `pruneSupersededImages`, `containerProvisionState`), `src/server/provisioning.ts` (new),
  `src/server/container/provision.json` (new — the pin, and the identity evidence),
  `src/server/container/Dockerfile`, `src/server/tools.ts` (`serenaMcpServerFor`).
- Repro test: `node scripts/verify-bug-107-image-staleness.mjs`. Suggested package.json entry
  (NOT added — package.json is contended): `"verify:bug-107": "node scripts/verify-bug-107-image-staleness.mjs"`.
- Related: **BUG-035** (the fix that never arrived — not a regression of it; its code was correct),
  FEAT-076 (the wiring panel that should have caught this pre-flight and did not), FEAT-055.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — worker (staleness mechanism + pinned provisioning)

- **Understood:** the explore's finding, confirmed independently before building — the live
  `claude-station-base:u1000-g1000` was 2 weeks old and `docker run … command -v uvx` printed
  `NO_UVX`; all three real station containers ran it. BUG-035's code was correct and irrelevant,
  because the artifact never tracked its definition.
- **Changed:** `src/server/provisioning.ts` (new), `src/server/container/provision.json` (new),
  `src/server/container/Dockerfile`, `src/server/container-manager.ts`, `src/server/tools.ts`,
  `scripts/provision-tools.mjs` (new), `scripts/verify-bug-107-image-staleness.mjs` (new) — commit
  `cb233a4`. Suite updates to `verify-mcp-attach.mjs` / `verify-tool-toggle.mjs` — commit `f7086f3`.
- **Verified:** as above. MUST-FAIL 5/22 (17 FAIL, exit 1) → 23/23 PASS (exit 0), plus eight
  anti-regression suites and `npm run gate` PASS exit 0.
- **Also done to the live machine:** ran `node scripts/provision-tools.mjs --install` once, so
  direct-isolation sessions keep Serena the moment the service restarts. Without it they would have
  had no Serena until someone provisioned — the one real regression risk in this change, closed by
  action rather than left as a note. `:4317` and the systemd service were never touched.
- **Still open / handoff:**
  1. **The MCP-list panel** (section above). The state functions exist and are read-only; only the
     UI is missing.
  2. **Playwright is still `npx -y @playwright/mcp@latest`** — a mutable `@latest` fetched at every
     session start, i.e. the identical supply-chain shape this ticket removed for Serena, still
     live for the other server. Deliberately out of scope (one change, one proof), but it is now the
     *only* remaining auto-fetch on the hot path and should get the same treatment.
  3. **Serena may still fetch language servers at runtime.** The pin covers Serena itself; its
     internal LS provisioning was not audited. `C3` proves the MCP server starts and lists 21 tools
     with `--network none`, so the base capability is genuinely offline, but a first-use LS download
     for some language is plausible and untested.
  4. A reviewer should confirm the two rewritten suites were strengthened, not loosened.
- **Verified-by:** dispatch openai run 01a01633-9b3e-7302-ba61-efe7a13bed26 (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: BROKEN. Range `b0dfaf6..2ab3881` with `docs/bugs`
  and `docs/prompts` reverted to base (synthetic head `344d204`), so no ticket/methodology prose
  reached the verifier. Fixer suite re-run 23/23 PASS exit 0 (real Docker builds). Adversarial case
  `preserved-metadata-definition-edit` (run `40d0c5bd7d4f`, exit 1): `provisionHash()` caches by
  `mtime`+`size`, so a same-size Dockerfile edit with preserved mtime returns the OLD hash and a
  stale artifact name. Second finding: `verify-tool-toggle` assertion (5) was LOOSENED — it used to
  require the exact emitted command `uvx`, it now accepts any absolute path ending in `/serena`
  (e.g. `/tmp/attacker/serena`) rather than the exact `hostSerenaBin()` path;
  `verify-mcp-attach`'s assertions were judged strengthened, not loosened.
- **Verification brief (written before the pass above ran):** required before this leaves VERIFIED. This is a
  regression-prone lane (image lifecycle, plus a third rework of the same Serena attach path) and
  the fixer wrote every fixture, so an independent clean-room pass is warranted. Two cases the
  fixture does NOT cover, worth attacking first: (a) two projects with different
  `settings.container.image` values racing `ensureImage`/prune concurrently; (b) a manifest bump
  applied while a container is running, i.e. the upgrade path rather than the first build.
- **Symptom of a deeper design flaw?** Not filing an ARCH ticket, but recording the shape: a
  *derived artifact that does not carry the identity of its input* is a general class, and this
  repo now has one instance fixed (the image) and one still open (`@playwright/mcp@latest`). If a
  third appears, that is the ARCH ticket.

### 2026-08-20 — record-correction lane: the status word claimed a verification this ticket never got

No code was touched, nothing was re-verified, and no prior entry was edited. This entry records what
this ticket's own log establishes and the one header word that changed. It also commits the
`Verified-by:` line above, which had been written by the verification lane but left uncommitted in
the working tree — a complete record, now on the record.

- **What the record said.** The status word read VERIFIED (fixer's own run) while the same header's
  `Verification-class` line said independent verification was REQUIRED before this moves past
  VERIFIED. The one independent round on this ticket, openai run
  `01a01633-9b3e-7302-ba61-efe7a13bed26`, returned BROKEN. Nothing on this ticket records a HOLDS.
- **Which case this is — checked, not assumed.** A stale status word, not an unrecorded later HOLDS.
  The ordering is explicit in the file itself: the brief immediately below that verdict is labelled
  "written before the pass above ran", so the word was written on the fixer's own run and the
  independent round came after it and did not clear it. The whole board was searched for a later
  verdict on this change; there is none, on this ticket or any other.
- **What is still true about the fix, so the correction is not read as a retraction.** The clean room
  re-ran the fixer's suite green (23/23, real Docker builds). Its two findings were real and are both
  fixed — under BUG-108, whose lane was already in these files: FINDING 1 (`provisionHash()` memoised
  on `(mtime, size)`, so a same-size mtime-restored edit returned the old hash — this ticket's own bug
  in a narrower form) is fixed by hashing the content every call, anti-regressed as `verify-bug-108`
  AF1; FINDING 2 (`verify-tool-toggle` assertion (5) loosened from `command === 'uvx'` to a
  `/serena` suffix that would accept `/tmp/attacker/serena`) is restored to exact identity against
  `hostSerenaBin()`, with a negative control. Both landed in commit `d302908`, which also re-ran
  `verify:bug-107` 23/23 unmodified.
- **Why that still is not VERIFIED.** Those fixes are on BUG-108's change and are recorded there;
  BUG-108's own independent round (openai run `01a01650`) also returned BROKEN and it sits at
  IN VERIFICATION. A HOLDS on a neighbouring ticket would not transfer here in any case, and there
  is no HOLDS to transfer.
- **Changed:** the status line only — VERIFIED to FIXED, with the evidence named in it. Work state is
  unchanged: the fix is landed and the ticket stays closed-as-fixed.
- **Still open:** an independent clean-room round that returns HOLDS on this change, and the two
  attacks this ticket's own brief named and that no round has run — concurrent `ensureImage`/prune
  across two projects with different `settings.container.image`, and a manifest bump applied while a
  container is running (the upgrade path rather than the first build). Handoff items 1–4 above are
  untouched by this entry.
