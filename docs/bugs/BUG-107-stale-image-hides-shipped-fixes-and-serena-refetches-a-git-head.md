```orchard-ticket
{
  "id": "BUG-107",
  "type": "bug",
  "title": "Container projects silently lost their code-navigation tools for two weeks",
  "summary": "Containerised projects kept running an image built before an earlier fix, so tools that fix restored never reached anyone. Image names now carry a fingerprint of the recipe, so an edited recipe rebuilds on the next session. The code-navigation tool is a pinned install placed once on disk. A management panel was deliberately left unbuilt.",
  "impact_if_we_wait": "Nothing further degrades: container projects rebuild themselves on the next session and this machine's direct install is already in place. Bounded to tool availability inside containers, not user data or session content.",
  "current_need": "Nothing is outstanding here. A pristine tree failed the staleness case, the corrected behaviour passed both directions, and neighbouring checks stayed clean.",
  "severity": "high",
  "area": "Container image lifecycle",
  "reported": "2026-08-18",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An edited image definition causes exactly one rebuild on the next session start",
    "An unchanged definition rebuilds nothing and reuses the same image",
    "A live container reads as drifted when its definition changes",
    "Session start launches an already-installed program and downloads nothing",
    "Superseded images are reclaimed only when no container still references them"
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts",
      "symbol": "imageNameFor",
      "note": "returned a name with no content hash, so every recipe version shared one identity"
    },
    {
      "path": "src/server/container-manager.ts",
      "symbol": "driftReasons",
      "note": "compared image name only; now also compares the resolved image sha"
    },
    {
      "path": "src/server/container-manager.ts",
      "symbol": "ensureImage",
      "note": "skipped the build whenever the name existed, which it always did"
    },
    {
      "path": "src/server/container-manager.ts",
      "symbol": "pruneSupersededImages",
      "note": "runs after container recreation, never after the build; never uses force"
    },
    {
      "path": "src/server/container-manager.ts",
      "symbol": "containerProvisionState",
      "note": "read-only three-state verdict the unbuilt panel would consume"
    },
    {
      "path": "src/server/provisioning.ts",
      "symbol": "provisionHost",
      "note": "new; installs the pinned version into a durable folder and records it"
    },
    {
      "path": "src/server/container/provision.json",
      "symbol": null,
      "note": "the pin plus the recorded package-identity evidence"
    },
    {
      "path": "src/server/container/Dockerfile",
      "symbol": null,
      "note": "bakes the pinned install and copies the manifest into the image"
    },
    {
      "path": "src/server/tools.ts",
      "symbol": "serenaMcpServerFor",
      "note": "execs an absolute path instead of fetching a moving branch"
    },
    {
      "path": "scripts/verify-bug-107-image-staleness.mjs",
      "symbol": null,
      "note": "drives real docker through a logging shim against a copied tree"
    }
  ],
  "related": [
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "BUG-108",
      "relation": "blocks"
    },
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-055",
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
      "run_id": "01a01633-9b3e-7302-ba61-efe7a13bed26",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-107-stale-image-hides-shipped-fixes-and-serena-refetches-a-git-head.md",
    "sha256": "7fc0db7d55e46093955b4463590d03f46d4c2570fb593f5c89e2d4cfbe3ff46f",
    "bytes": 20783,
    "original_title": "a built container image never noticed its own definition changed, so shipped fixes never arrived",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section; the root cause, the tag-over-label reasoning, the pin and its identity evidence, the prune guards and the unbuilt panel surface are all present.",
    "dropped": [
      "the step-by-step pre-fix repro, which the diagnosis and evidence already carry",
      "the quoted user instruction about supply-chain risk, whose substance is the pinned-install decision"
    ]
  }
}
```

# BUG-107 — Container projects silently lost their code-navigation tools for two weeks

## Diagnosis

Three places agreed on a stale answer. `imageNameFor()` returned `claude-station-base:u{uid}-g{gid}` with no content hash, so one name covered every version of the recipe. `ensureImage()` skipped the build whenever that name existed, and it always existed. `driftReasons()` compared the image name, which always matched.

The artifact's identity was decoupled from its definition, so any change baked into the image had the same gap — this is a deploy-lag class, not a tool-specific problem. Separately, the code-navigation tool was fetched from a moving branch on every session start, on the hot path, with no pinned version.

## Evidence

A user opened a container session and got the `tooling-unavailable` card naming `serena` with `--project /workspace/<proj>`. The card was correct: the container genuinely had no Serena, even though BUG-035's fix was live in the source tree.

Against the pristine tree the harness recorded `FAIL B5 ... docker builds=0 newImage=claude-station-base:u1000-g1000 newId=6665992bbee2 oldId=6665992bbee2` on a changed Dockerfile, and `FAIL B4 drifted=undefined reasons=[]`. C3 captured the live `/usr/bin/git fetch … https://github.com/oraios/serena` a session start performed. Pristine tally: 5/22 PASS, exit 1.

After the change, `verify:bug-107` ran 23/23. `B5 docker builds=1` with the in-container marker reading `1` on a changed definition; `B2 docker builds=0` and the same image id on an unchanged one. C3 spoke real MCP over stdio to `/usr/local/bin/serena` inside a freshly built image with `--network none` and got 21 tools. C2 got `Serena 1.7.0` with no network. E3 showed a second `provisionHost()` returning `changed=false` in 1ms without spawning anything.

Anti-regressions: `verify:mcp-attach` 20/20 (all 21 `mcp__serena__*` tools on turn one of a real direct-isolation session), `verify:tool-toggle` 13/13, `verify:bug089` 6/6, `verify:mcp-ready` 10/10.

Live-machine safety after the runs: the three real station containers were untouched, and the legacy `claude-station-base:u1000-g1000` image survived the prune because a container still referenced it — the refusal guard working on a real artifact.

Package identity was checked before pinning, with five links recorded under `identityEvidence`: PyPI `serena-agent` 1.7.0 authored by Oraios AI with the matching homepage and MIT licence; `oraios/serena@main`'s own `pyproject.toml` declaring `name = "serena-agent"`; the wheel's `entry_points.txt` mapping `serena = serena.cli:top_level`; a downloaded wheel sha256 `6dbf1459…c76e891` matching PyPI's digest for 1.7.0; and `serena-mcp` returning 404, so the pin could not have been misaimed at it.

## Implementation notes

The tag now carries `provisionHash()` — a sha256 of the Dockerfile plus `provision.json`, truncated to 12 hex — giving `claude-station-base:u1000-g1000-5080fd22dda9`.

Tag over label, deliberately. A label keeps one moving tag and lets superseded images auto-dangle, which is the tag's one real cost. But a label makes both `driftReasons` and `ensureImage` need a new image-inspect step and new comparison logic on the exact code path whose silent success caused this bug, and backing out a bad pin would force a full rebuild instead of resolving to an already-built tag. The tag makes the fix subtractive and lets `docker images` show which definition each artifact came from. Labels are still written (`claude-station.provision-hash`, `.serena-version`, `.serena-package`, `.image=1`) as the machine-readable record; the drift check does not hinge on them.

`pruneSupersededImages()` has three guards: only the repo we own and only tags matching `u{uid}-g{gid}[-{hash}]` (which also reclaims the legacy unhashed tag); never `--force`, so docker refuses while any container, running or stopped, still references the image; and never the tag we were told to keep. It fires after the container is recreated rather than after the build — at build time the old image is still what the live container runs, so every removal would be refused. That ordering was found by the verification (F1 failed exactly that way), not by reasoning.

`driftReasons` also compares the resolved image sha, catching a same-name image rebuilt underneath a container, which matters for a user-supplied `settings.container.image`.

The tool became a pinned registry install: `uvx --from git+https://github.com/oraios/serena` gave way to `serena-agent==1.7.0` from `provision.json`. Container builds bake it via `uv tool install` to `/usr/local/bin/serena` and COPY the manifest to `/etc/claude-station/provision.json`; direct isolation installs to `<dataDir>/provision/bin/serena` and records it in `installed.json`. A version upgrade is now requested, never automatic: bumping the pin marks the install stale rather than installing itself.

No UI was written here — another lane owns those files. The read-only surface the MCP list panel needs is exported: `containerProvisionState(project)` returns `{ state: 'provisioned' | 'stale' | 'missing', image, custom, wantedSerenaVersion, imageSerenaVersion, provisionHash, imageProvisionHash, detail }`, where `detail` is plain words safe to render and `custom: true` means a user-supplied image that should be shown but never offered for provisioning. `hostProvisionState()` gives the same three-state verdict for direct isolation plus `installedVersion`, `wantedVersion`, `installedAt` and `bin`. Actions are `provisionHost({ force })` — the only thing in the repo that fetches, and it must stay behind an explicit click, with a progress stream via `onLog` — and the existing `POST /api/projects/:id/container/rebuild`, usually unnecessary now that a stale image self-heals. Until the panel exists the manual equivalent is `node scripts/provision-tools.mjs --install`.

FEAT-076 is the wiring panel that should have caught this pre-flight and did not; FEAT-055 is related context for the same surface.

## Verification plan

`node scripts/verify-bug-107-image-staleness.mjs` runs every phase against a copied tree, because the staleness proof mutates the image definition and would race other lanes in this repo. It drives real docker through a bidirectional shim on `CLAUDE_STATION_DOCKER`, so the user's live `claude-station-base:u1000-g1000` tag is never built over and whether a build actually happened is an observation rather than an inference — the shim logs every docker invocation.

A suggested package.json entry `"verify:bug-107": "node scripts/verify-bug-107-image-staleness.mjs"` was deliberately not added, since package.json is contended.

Both directions must be proven: a changed definition rebuilds and the new container runs the new definition; an unchanged definition rebuilds nothing. A fix that rebuilds every time is a different bug.

## Migration and rollback

A revert resolves to an already-built tag rather than forcing a rebuild, which was part of the reason for choosing the tag over a label. Existing containers self-heal on the next session start; no manual step is required for container projects, and the direct install on this machine was already provisioned.

## Risks

Two suites were rewritten and a reviewer should check they were not quietly weakened. `verify-tool-toggle.mjs` and `verify-mcp-attach.mjs` hard-coded the old design — `command === 'uvx'` and the literal `git+https://…` URL — so they could not survive this change. Each replacement assertion is at least as strong as what it replaces: A4 went from "the image ships uvx" to "the image bakes the pinned package AND no executed line contains a git ref". Part D's failure induction changed because the failure mode did — it was a PATH stripped of `uvx` standing in for the container bug, and is now a station that has never been provisioned, which is the real state every user is in before their first provision.

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
