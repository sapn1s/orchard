```orchard-ticket
{
  "id": "FEAT-049",
  "type": "feature",
  "title": "Publishing the project would expose private details permanently",
  "summary": "The working files are now clean of private project names, home paths and personal context, and a security posture write-up plus rename and public-mirror scripts are written and tested. The stored history still holds everything that was scrubbed, so the public copy must start from a fresh history. Nothing has been published.",
  "impact_if_we_wait": "Nothing leaks while the project stays private, because the release steps only run when a person runs them. Bounded: this is exposure-on-publish, not a live disclosure, and no data is lost by leaving it open.",
  "current_need": "Decide whether to hold this open until you publish, or close it and treat the release steps as a separate task.",
  "severity": "medium",
  "area": "Public release readiness",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-10",
  "decision": {
    "mode": "single",
    "question": "Should this stay open until the publish is run, or close now that the preparation is done?",
    "options": [
      {
        "key": "A",
        "label": "Hold open until published",
        "what_changes": "The ticket stays open and carries the release steps until someone runs them for real.",
        "benefit": "The untested-in-anger release path stays visible instead of being assumed done.",
        "cost": "An open ticket sits on the board indefinitely with no owner acting on it.",
        "why_not_obvious": "A ticket that stays open with nobody working it teaches readers that open means nothing in particular."
      },
      {
        "key": "B",
        "label": "Close the preparation work",
        "what_changes": "This closes on the cleanup and scripts, and publishing becomes its own ticket when wanted.",
        "benefit": "The board reflects what is actually finished, which is all of the preparation.",
        "cost": "The publish steps lose their home unless a replacement ticket is filed at the same time.",
        "why_not_obvious": "The scripts have only ever been run in rehearsal, so closing records confidence the real run has not earned."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "The risky part is the run itself, and keeping one ticket attached to it costs nothing and reverses in a line.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "A leak check over the tree finds no private project name, home path or email",
    "The board index check and the interface and type checks stay clean after the scrub",
    "The rename script's dry run prints correct paths for this machine without executing",
    "The mirror script builds a scratch tree that passes the leak check with no push"
  ],
  "code_refs": [
    {
      "path": "scripts/rename-to-orchard.sh",
      "symbol": null,
      "note": "Run by the user from a plain terminal, never from inside a session: stops the service, moves the directory, rewrites the unit and desktop entry paths, migrates the per-project memory and transcript directory to the new key, optionally renames the remote, then restarts and checks health. Dry run by default."
    },
    {
      "path": "scripts/publish-public-mirror.sh",
      "symbol": null,
      "note": "Builds the scrubbed tree as a fresh history, runs the leak gate, and pushes only with an explicit flag and a repo name the user supplies."
    },
    {
      "path": "docs/bugs/",
      "symbol": null,
      "note": "Append-only by convention; the privacy scrub is the sanctioned exception and each touched ticket records it in its log."
    }
  ],
  "related": [
    {
      "id": "FEAT-036",
      "relation": "supersedes"
    },
    {
      "id": "FEAT-044",
      "relation": "see_also"
    },
    {
      "id": "FEAT-052",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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
    "archived_path": "docs/bugs/archive/FEAT-049-public-release-prep.md",
    "sha256": "0b28f36b314aa3c3e3f1168a494a0fa61d0db9364ba8d093506c75cad522448b",
    "bytes": 12907,
    "original_title": "public-release prep: scrub, security posture, rename, fresh-history mirror",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the history constraint, all five work items, the fresh-history strategy, the recommendation and the verification bar are present.",
    "dropped": [
      "the restatement that nothing breaks if nobody acts, which the impact field now carries",
      "the parenthetical list of review findings in the reported line, which the diagnosis carries"
    ]
  }
}
```

# FEAT-049 — Publishing the project would expose private details permanently

## Diagnosis

The external review treated this as a working-tree problem: private project names, hardcoded home paths, missing security posture, unfinished rename. Scrubbing the working tree is not enough. The commit history and the ticket evolution carry the same private project references, home paths and personal context throughout, so publishing this repository as-is exposes all of it regardless of how clean the checkout looks. The strategy that follows is to keep this repository private as the working history and publish a fresh-history copy built from the scrubbed tree, with the rename applying naturally to the new public repository.

## Evidence

The scrub and the surrounding checks were run and are green: the interface suite at 3/3, the fleet-sync suite at 21/21, the scope-check suite at 12/12, the working-agreement self-maintenance suite at 39/39, a further 33/33 recorded without an adjacent suite name, and the type check clean. Three further suites are named in the plan — the browser, resume-refusal and live suites — with no result recorded against them here. Neither release script has been executed; both were exercised in rehearsal only.

## Implementation notes

Five work items make up FEAT-049. First, a read-only leak audit inventorying every private artifact in the tree — private project names, home paths, email, machine details, any tokens or keys — producing a scrub list with per-file counts before anything changes. Second, the scrub pass itself, neutralising private project references in board and ticket text where the reference is not load-bearing and replacing home paths with a variable or a relative path. Third, a security posture document making the position obvious: permission modes including bypass are explicit opt-in per project and session, the container-socket toggle is arm-then-confirm with its consequences stated, sandbox tiers are described, and binding is localhost-only. Fourth and fifth, the rename and public-mirror scripts, both idempotent-ish, dry-run by default, with loud aborts, and never executed by an agent.

## Verification plan

The leak audit must be reproducible as a gate script that exits non-zero on any private token, so the same script serves as the mirror's final gate. The scrub must leave the board index check, the interface suite and the type check green. The rename script's dry run must print correct output against this machine's real paths without executing. The mirror script must build into a scratch directory and produce a tree that passes the leak gate, with no push.

## Migration and rollback

This repository stays private and keeps its full history, so nothing here is destructive and there is nothing to roll back on this side. The public copy is a new repository built from an orphan or squashed initial commit, and a bad mirror is discarded by deleting it rather than by rewriting anything. The rename is the one step that touches the machine — service unit, desktop entry, project directory, and the per-project memory and transcript directory key — and it is the step to rehearse in dry run before running for real.

## Risks

The gate is a grep, so it catches the private tokens it knows about and nothing else; a private detail phrased differently passes it. The rename touches system paths and a memory directory keyed by the old location, and a partial run leaves the service pointing at a directory that has moved. Publishing is irreversible in practice once a mirror is pushed, so the leak gate has to hold on the first attempt rather than the second.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed from the user's external-review findings + the history-exposure constraint. Rename is
  back in scope (user decision supersedes the earlier leave-it, now that public release is the
  goal). Dispatching audit+scrub and the two scripts as separate lanes.

### 2026-08-06 — scripts lane (items 4+5)
- Authored `scripts/rename-to-orchard.sh` (item 4, revives FEAT-036). Dry-run by default,
  `--apply` to mutate, `--rename-github` optional. Preflight (read-only, both modes): src/target
  dirs, unit + .desktop presence, Claude projects key `-home-<user>-projects-claude-station` free
  target, live `claude-station-host-*` scopes (hard abort), clean working tree; active service is
  INFO ("would stop"), self-guards refuse `--apply` from inside a session-host scope /
  CLAUDECODE env / cwd-inside-repo. Steps: stop svc → mv dir → rewrite machine-local unit →
  orchard.service (disable/enable/daemon-reload) → orchard.desktop (Exec/Icon paths) →
  MIGRATE `~/.claude/projects/<key>` to the new encoded key (preserves transcripts + auto-
  memory; memory/*.md absolute-path refs sed'd, transcripts untouched) → registry.json hostPath
  (with .pre-rename backup) → repo-local deploy/ copies + station-open.sh → optional gh rename +
  remote set-url → start + /api/health 200 gate → post-checklist (incl. data dir stays
  `~/.local/share/claude-station` — keyed by a constant in src/lib/paths.ts, separate change).
- Authored `scripts/publish-public-mirror.sh` (item 5). Default: copy `git ls-files` contents to
  a scratch tree, run `node scripts/leak-gate.mjs <tree>` as a HARD gate, fresh `git init -b
  main` + single commit "Orchard — initial public release"; `--push --repo <name>` (and a
  passing gate) required for `gh repo create --public` + push. Never reads/writes the private
  repo's remote. Fresh repo inherits git identity from the source repo's local config (this
  machine has no global identity — commit failed without it in testing; fixed).
- Verified (§C, no mutations executed): `bash -n` clean both (shellcheck not installed; manual
  quoting/set -e review done). Rename dry-run on real machine: full plan with resolved real
  paths; correctly FAILed preflight on the currently-live host scope + dirty tree, printed
  "would stop" for the ACTIVE service, exit 1; a real `--apply` run aborted at the self-guard
  with zero mutation (service still active, no ~/projects/orchard). Mirror build ran for real
  into /tmp: 290 tracked files copied, leak-gate.mjs (landed by the audit lane mid-flight)
  invoked and FAILed on the still-unscrubbed tree → script hard-aborted before git init, tree
  left for inspection, no network. Commit path verified standalone. Mirror is ready; it will
  pass once the item-2 scrub lands.

### 2026-08-06 — audit + scrub + security-posture agent (work items 1-3)
**1. Leak audit (read-only, pre-change).** `scripts/leak-gate.mjs` written first and run
against the untouched tree: **FAIL — 276 hits in 43 files** (across 223 tracked text
files). That failing listing IS the inventory (counts per file in the gate output).
Token classes found: project-A bot name (name + variants; heaviest: FEAT-044 46 hits,
FEAT-020 33, verify-fleet-sync 12), seven MORE private project names found en route
(aliased B-G below, plus a Windows-origin app used as the dual-boot example), absolute
home paths + their encoded store-dir forms (`-home-…`, `C--Users-…`) in deploy units,
verify scripts, dom.js, board.ts/browser.ts comments, the GitHub handle (TODO.md +
rename script), bare username in linger/systemd notes. **Zero credential-looking
strings** in tracked files (regex sweep for key/secret/token assignment shapes + known
prefixes came back empty); `.mcp.json` confirmed gitignored (`git check-ignore` +
absent from `git ls-files`); no email hits anywhere; hostname is a distro default and
appears nowhere.
**2. Scrub (working tree only; .git history untouched — mirror strategy owns that).**
- Aliases: bot project → `external-project-A` (FEAT-044 file renamed via `git mv` to
  `FEAT-044-onboard-external-project-A.md`, narrative kept as a genericized case
  study); other private names → `external-project-B…G`; the dual-boot example app →
  `Example-App` / `example-app` in code comments + fixtures; handle → `<gh-user>`;
  home paths → `~` / `$HOME` / `-home-<user>-…` in docs.
- CODE now derives every path: `dom.js` shortPath matches any `/home/<u>`,
  `/Users/<u>`, `X:\Users\<u>` prefix; `browser.ts` + `verify-browser.mjs` default
  repo dir via `os.homedir()`; deploy service uses systemd `%h`, .desktop is a
  commented `/path/to/…` reference template.
- Load-bearing name in `fleet-sync.mjs` (hands-off exclude) moved to
  `STATION_HANDS_OFF` env + gitignored `.station-hands-off` file (created locally with
  the real id — the user's project stays protected, the name stays untracked).
  `check-scope.mjs` named-project rule now matches the alias pattern + optional
  `STATION_PRIVATE_NAMES` env; `wa-consolidate.mjs` marker regex likewise generalized.
- Machine-specific verify fixtures replaced by discovery + env pins: new
  `scripts/lib/neighbor-project.mjs` (`findNeighborProject` / `homeEncoded`, pinnable
  via `STATION_VERIFY_PROJECT`) used by verify-ui/verify/verify-resume-refusal;
  verify.ts section 1a picks a real Bash-tool session dynamically
  (`STATION_VERIFY_TOOLUSE_*`), section 8 discovers a Windows-origin store dir
  (`STATION_VERIFY_WIN_*`); verify-live derives the home store dir and picks the
  largest transcript in the store instead of a hardcoded dir/id pair. verify-ui's
  session-count check made cap-aware ("N more" reconciliation) since the discovered
  neighbor can exceed the tree's row cap.
- rename-to-orchard.sh (lane 4's file, was tripping the gate): handle now resolved at
  runtime via `gh api user -q .login`; comment paths genericized.
- Touched tickets each got the sanctioned append-only privacy-scrub log line
  (BUG-004, FEAT-015/017/018/020/022/024/025/028/030/036/037/038/039/041/043/044 +
  this one); TODO.md / HANDOVER.md / INDEX.md scrubbed (INDEX row text only — statuses
  untouched).
**3. Security posture:** README gained a "## Security posture" section directly under
the intro: localhost-only + no auth tier (don't proxy it out), permission modes with
bypassPermissions as explicit per-project/session opt-in + the raised-risk wording
outside containers (calm container-default inside), isolation tiers incl. the honest
"sandbox = modelled, returns 501", container bind-mounts the REAL tree (snapshots are
the project's undo), docker-socket arm-then-confirm with the rootful-daemon = root
consequence stated, dispatch runner's read-only default sandbox + the policy-vs-kernel
enforcement caveat, no API keys anywhere.
**Verification (all run today):** gate pre-scrub FAIL 276/43 → post-scrub
**PASS — 0 hits across 228 tracked text files** (gate now also scans
untracked-unignored files so new files are gated pre-add; its own token list is
split-string encoded so it can ship in the mirror). `typecheck` green; `board:check`
"OK — no drift (6 advisory warnings, pre-existing)"; `verify:ui --offline` **3/3**;
`verify.ts --offline` **33/33**; `verify-fleet-sync` **21/21**; `verify-check-scope`
**12/12**; `verify-wa-selfmaintain` **39/39**; bash -n on both release scripts OK.
:4317 never touched; nothing committed.
**Open:** none for items 1-3. Items 4-5 (rename + mirror scripts) are other lanes;
the mirror script should call `node scripts/leak-gate.mjs` as its final gate.

### 2026-08-10 — leak REGRESSION caught by the gate (the gate is doing its job; the process isn't)
`node scripts/leak-gate.mjs` went FAIL — 8 hits in 2 files — because the BUG-036 fix agent, while
writing an accurate root-cause narrative, reintroduced two private project names and a home path
(`docs/bugs/BUG-036-*.md` ×7, `scripts/verify-ui.ts` ×1 comment). Scrubbed to the existing aliases
(`external-project-B`, `Example-App`, `~/projects/<…>`); gate back to PASS 0/275.

Pattern worth noting: the scrub is not a one-time task — every agent that writes an honest
narrative about this machine can reintroduce private identifiers. The gate catches it, but only if
someone RUNS it. Follow-up candidates (cheap): run the gate in the same place `board:check` already
runs, and/or make it part of the gatekeeper's mechanical pre-steps for any commit touching docs/.

### 2026-08-25 — publish-safety lane
- **verification:** Second-pass audit, by a different method than the first. The first pass's own stated limit was that its token list is an allowlist of names someone remembered. So this pass derived the inventory from the machine instead: every entry under ~/projects, ~/random_projects and ~ (about 190 names) was grepped against the tracked tree, and the tree was swept for SHAPES — emails, non-loopback IPs, absolute home paths, credential-shaped strings, symlinks, NUL-bearing files, off-allowlist images. FOUND, all invisible to every gate run this week: (1) src/server/browser.ts defaulted the browser adapter to a personal home directory — a BEHAVIOURAL default, not prose, which is why no text pattern covered it; (2) scripts/verify-bug-141.mjs and BUG-141's prose carried a real client's name, product line and trade term lifted verbatim out of two of the user's Codex rollouts, plus those rollouts' absolute paths and session ids, landed TODAY by another lane — proof the class is live, not historical; (3) an archived FEAT-020 breadth-sweep still named a private project (now external-project-Q); (4) scripts/verify-arch-watch.mjs contained a raw NUL, and the leak gate SKIPS any file whose bytes contain one, so that file was heading for the public tree having never been privacy-scanned by anything. FIXED: the adapter has no baked default and reports what to set; the BUG-141 verifier discovers its rollouts and derives its needles from them (15/15, was 13/13); the NUL is now a \\0 escape and check-nul's allowlist is empty; four new gate tokens. NOT FIXED, user's call: ~/projects and ~/random_projects remain the default project-scan roots in registry.ts (a real feature default, discloses only a folder name); the adapter project's own name stays, since it is the MCP server identity, and the README already says it is a separate project you supply. THE PUBLISH SCRIPT NOW SAYS NO — it never had. Driven against trees it must refuse: a text token (exit 1, no fresh history), the same under --push (never reaches gh), a non-allowlisted image, and a control clean tree that must PASS and build one commit with no remote. The missing-gate branch used to build a full fresh-history repo and only refuse the push; deleting one file silently downgraded the only check standing between the tree and a permanent disclosure. It now aborts. All of it is scripts/verify-feat-049-publish-safety.mjs, 25/25, including a must-FAIL control that loads the pre-fix browser.ts and shows it returning the home path. Anti-regressions: verify-arch-007 83/83 with the adapter env set (and a clean SKIP without it), verify-browser skips honestly, verify-arch-watch unchanged at 6 pre-existing failures both before and after. Gate PASS unpiped, board clean. Nothing pushed, no public repo created. Risk bucket: SECURITY / irreversible-disclosure — an independent clean-room verify pass is warranted before the user runs the publish.

### 2026-08-25 — publish-blockers lane
- **verification:** **Two publish blockers: the licence landed, the rename half-landed on purpose.**

  **1. Licence — PolyForm Noncommercial 1.0.0.** `LICENSE` at the root: the steward's own markdown VERBATIM (4563 bytes), preceded by one line in PolyForm's OWN attribution form — `Required Notice: Copyright 2026 <handle> <GitHub noreply>` — so the licence body itself is unmodified and the licensor is still nameable. Text verified against TWO independent sources (SPDX license-list details JSON and the polyformproject/polyform-licenses repo); they differ only in line-wrapping, identical non-whitespace content, and the shipped copy is byte-identical to the steward's. A cached copy lives at `scripts/fixtures/polyform-noncommercial-1.0.0.md` so the verifier is offline/deterministic (`--refetch` re-checks the network).

  **Corrected the ticket's own instruction on the SPDX id, with evidence.** The brief said to use a `LicenseRef-` expression because the licence is not OSI-approved. That premise is wrong: SPDX ids are not gated on OSI approval. Fetched the live SPDX license list — `PolyForm-Noncommercial-1.0.0` is a real, non-deprecated id with `isOsiApproved: false`. `LicenseRef-` is the namespace for licences NOT on the list, so it would have told tooling the opposite of the truth — the exact failure the brief warned about ("a wrong id is worse than none"). `package.json` declares `"license": "PolyForm-Noncommercial-1.0.0"`. `private: true` KEPT and is not a contradiction: it blocks accidental `npm publish` of an app that is cloned, never installed. No tracked file claims a different licence. README gained a Licence section (may / may not / open an issue for commercial terms).

  **A DELIBERATE HOLE WAS CUT IN THE LEAK GATE — this is the part to review.** The copyright line necessarily contains the GitHub handle, which `leak-gate.mjs` treats as a private token. MUST-FAIL proof first: with LICENSE present and the gate untouched, `FAIL — 1 hit`, exit 1, at `LICENSE:1`. The gate now carries ONE waiver — one file (`LICENSE`, exact name), one token (`github handle`), and only on a line matching PolyForm's `^Required Notice: Copyright <year> ` form. Waivers are printed on stdout on EVERY run, and `npm run gate` was changed to surface them (it swallowed the notice on PASS — found by the verifier, not by inspection; a waiver only visible when you run the underlying gate by hand is a waiver nobody reviews).

  **2. Rename — cosmetic done, migration deliberately NOT done.** Blast radius measured first: 582 occurrences of the old name across ~180 files, the bulk of it append-only ticket history. DONE (safe, no persisted state): package name -> `orchard` (+ package-lock, or `npm ci` refuses), the `[claude-station]` log prefix -> `[orchard]` across src/ (37 strings; verified nothing anywhere parses it), the Codex MCP `clientInfo.name`, the "denied by" refusal string, one comment. NOT DONE, because each is a data migration with a real failure mode: the `~/.local/share/claude-station` data dir (registry, templates, scratch project, deleted-sessions, host status files — hardcoded as a basename in 6 further scripts); the `CLAUDE_STATION_*` env contract (the systemd unit passes it, and BUG-117's hard-stop logic is keyed to that exact spelling); the `claude-station.service` unit and `claude-station-host-*` scopes (the live session is adopted by that prefix; also hashed by docs/guide/.doc-sources.lock.json); the Docker image repo `claude-station-base`, container prefix and `claude-station.*` label namespace (renaming orphans the user's built ~1GB image and makes RUNNING containers invisible to the reaper — leaked containers, not just a stale name); and the registry project id `claude-station`. README now states plainly which names survive and why, so a public reader is not left guessing.

  **verification.** New `scripts/verify-feat-049-licence.mjs` (`npm run verify:feat-049-licence`) — **41/41**. Built from the REAL LICENSE/README/package.json, not fixtures: 16 licence-claim checks against the real root files, 16 adversarial gate checks (each mutates ONE thing off the real artifact in a scratch TREE), 9 rename-honesty checks. The adversarial set is the point — the handle one line LOWER in LICENSE, in README, in `LICENSE.md`, in lowercase `license`, in `vendor/LICENSE`, in a `NOTICE` file with the identical line shape, a home path or the personal email ON the waived line, a `# `-prefixed near-miss, and a year-less notice ALL still FAIL exit 1. Control: real LICENSE passes and announces the waiver. Two of my own checks failed first pass (harness bugs — a stdout/stderr split and npm's unquoted single-field output); B2's failure is what exposed the silent-waiver defect in gate.mjs, so it earned its place.
  **Anti-regressions:** `npm run gate` **PASS unpiped, exit 0 read directly** (leak-gate + check-nul + typecheck); verify:feat-049 publish-safety **25/25**; verify:gatekeeper **31/0** (it depends on leak-gate's verbatim FAIL stderr — untouched, waivers went to stdout); verify:codex-runtime **54/0** (clientInfo rename); verify:docs-fresh **22/22**; board:check OK — no drift (advisory-warning count unchanged; it reads committed hashes, so uncommitted edits cannot move it).
  **Real-artifact check, not just tests:** booted the actual server on a free ephemeral port with an isolated scratch `CLAUDE_STATION_DATA` — `/api/health` 200, startup logs 6 `[orchard]` lines and ZERO `[claude-station]`, templates seeded, isolated dir correctly reported. :4317 and the user's service, unit and scopes never touched; killed only the pid I spawned.

  **Risk bucket: SECURITY / irreversible-disclosure.** An independent clean-room verify pass is warranted before the user runs the publish, specifically on the gate waiver — I both cut the hole and wrote its test, and generation must not be its own only verifier.

### 2026-08-25 — licence-contact lane
- **verification:** **The required notice pointed at an address that bounces.** The line landed in a42ff19 as `Required Notice: Copyright 2026 <handle> <GitHub noreply>`. That noreply address is deliberately undeliverable — the user sent mail to it and got "domain couldn't be found" — so a licence whose entire commercial-terms mechanism is "ask the licensor" published no way to ask. MUST-FAIL proof first: the post-fix assertion (notice carries no email) run against the pre-fix file reports FAIL, found the noreply address.

    **The fix is a channel, not a different address.** The notice now reads `Required Notice: Copyright 2026 <handle> (https://github.com/<handle>/orchard). Commercial use requires a separate licence; open an issue on that repository to ask.` — the copyright holder is still named (PolyForm's Notices clause needs that), there is NO email at all, and the contact is the repository itself, which is PolyForm's own documented form (its example is `Copyright Yoyodyne, Inc. (http://example.com)`). The personal address was deliberately NOT substituted: an address in a public LICENSE is permanent, scraped within days and unwithdrawable once mirrored; if a direct channel is ever wanted the right answer is a purpose-made alias the user creates, not their primary address chosen on their behalf.

    **The waiver STAYS, and it is still narrow — because the handle is still there.** The exemption was cut for the handle, not the email, and the handle remains the licensor's name on that line, so removing the waiver would just break the gate on a legitimate line. Two new checks make that non-inertial rather than assumed: (B2b) the real notice DOES contain the waived token, so the waiver is load-bearing; (B2c) in a tree where the notice names no handle, the gate passes AND waives NOTHING — the waiver cannot fire for a reason that has disappeared. The whole adversarial battery still refuses everything it refused before: the handle one line lower, in README, in NOTICE, in LICENSE.md, in lowercase `license`, in vendor/LICENSE, a home path on the waived line, the PERSONAL email on the waived line, a `# `-prefixed near-miss, a year-less notice — all exit 1.

    **README says the same thing.** Its licence section now routes to the same channel (open an issue, or the contact on the GitHub profile), states that this is the same channel the `Required Notice:` line points at, and says there is no licensing email address deliberately. Three new cross-document checks: the README routes to the repository the notice names, and the README's licence section publishes no email either (negative-tested — the predicate FAILS on a section carrying an address, so it is not a tautology).

    **Commit metadata untouched.** The noreply address is correct in git identity — that is exactly what it exists for — and no git config was changed. This was only the licence text.

    **verification:** verify:feat-049-licence **49/49** (was 41/41; A5 rewritten from "uses the noreply identity" to "carries NO email at all", plus A5b/A5c/A5d/A5e, A15b/A15c, B2b/B2c). Discrimination proof: restoring the old notice line in place drops it to 44/49 — exactly the five assertions that encode the fix, restored immediately after. Anti-regressions: `npm run gate` **PASS unpiped, exit 0 read directly** (waiver still surfaced on the PASS line); verify:feat-049-publish-safety **25/25**; verify:gatekeeper **31 PASS / 0 FAIL** (it depends on leak-gate's verbatim FAIL stderr, untouched); board:check OK — no drift. Risk bucket: SECURITY / irreversible-disclosure — the change REMOVES a published identifier rather than adding one, and the gate waiver is unchanged in scope, so it is lower risk than the original, but an independent clean-room pass on the waiver is still warranted before any publish.

### 2026-08-25 — publish-readiness lane
- **verification:** **Everything committed, both destinations prepared, nothing pushed.**

  **Working tree cleared — three decisions.** (1) `README.md`, rewritten days ago and never committed, is now in (d3d391d). Re-checked against the tree rather than committed as written, because three commits landed after it was drafted: every screenshot path, doc link, Layout-table path, env var and the sandbox-501 claim was resolved against the real files, `engines` really is `>=23`, the licence section is byte-identical to the one 450f0e6 committed (so it carries the no-email channel, not the bounced noreply), and the browser-adapter paragraph matches 71153f9's removal of the baked home-directory default. The one unsourced number was measured instead of trusted: running the REAL `composeInstructions` against the REAL registry entry and template store returns **36,345** characters for this repository — "roughly 36,000" stands. No stale claim found, so nothing was rewritten. Known omission left deliberately: the README does not mention BUG-149's one-tab-drives-a-live-session restriction; the app now says that itself, and the README is an overview, not a manual. (2) `public/app.js` — the one-line hunk six lanes stepped around was a `’` escape replaced by a literal curly quote inside a template literal. Byte-for-byte identical output, no ticket, no author, and it only half-normalises (two more `\uXXXX` escapes remain in the file), so it was **reverted**, patch preserved at `~/scratch/feat049-tree-clear/app.js.curly-quote.patch`. (3) `docs/analysis/pipeline-cost-visual.html` — **committed with the superseded banner** (ae46ed6), not deleted and not gitignored, because COST-METHOD.md already sets the policy for this exact artifact: dated analyses keep their wrong numbers as a record and carry a pointer to the correction. Deleting destroys a record that policy preserves; gitignoring publishes the source (`pipeline-cost-2026-08-19.md` is tracked) while hiding its rendering for no visible reason. It had no banner at all — it opened with `$1,234.85 spent.` as an h1 and no caveat in 11KB. Verified by rendering, not by reading the diff: headless screenshot at 1280x1000 shows the banner above the headline and the charts still draw.

  **Delta sweep found a real leak the gate cannot see — and it was in the tree about to publish.** Sweeping only `0909e2c..HEAD` by the second audit's METHODS (machine-derived name inventory of 147 real directory names, shape sweeps for paths / session ids / emails / IPs / credentials / behavioural defaults, and a byte scan for NUL-bearing files the gate skips), the find was `scripts/verify-feat-049-licence.mjs:245` reconstructing the user's **real primary email address in full** via a split string. Must-fail proof taken against the REAL built mirror tree: a grep for the real mail domain over the built tree returns the line, exit 0, while `leak-gate.mjs` over that same tree reports `PASS — 0 hits across 860 files`. the same grep at `0909e2c` is empty — no precedent; a42ff19 introduced it. The lane's own argument for keeping the address out of LICENSE ("permanent, scraped within days, unwithdrawable once mirrored") applies verbatim to a published `scripts/*.mjs`. Fixed in 244e564: the gate's `email` token is the LOCAL PART only, so the domain was never load-bearing; B10 now uses `@example.invalid`. Discrimination proof rather than assumption — the local part at `@example.invalid` FAILS exit 1, `nobody@example.invalid` PASSES exit 0, so the check still fails, and still for the right reason. Everything else in the delta came back clean: 0 literal home paths, 0 session/rollout ids (`verify-bug-149-live-elsewhere.mjs`, the highest-risk new file at 442 lines and the same shape as the prior audit's worst find, derives its sdkId at runtime and its needles are synthetic strings it sends itself), 0 private names in plaintext, 0 emails, 0 non-loopback IPs, 0 credential shapes, 0 NUL-bearing files, 0 machine-specific behavioural defaults, no symlinks or mode changes.

  **Left for the user's call, deliberately not changed.** The split-string constants for the home path token, the email local part and the private project name in that same verifier stay. They are load-bearing — a self-test of the gate must use the gate's real tokens, and deriving them (`os.homedir()`) would make the test a silent no-op on any other machine — and `leak-gate.mjs` itself ships every one of them by construction. The rule that generalises is not another token: a verifier derives its needle from the artifact, and where it cannot, the split string must be the MINIMUM that makes the check work, never a real address with a real domain attached.

  **Third public blocker accepted, not worked around.** `docs/bugs/README.md` lines 3-9 carry the note; re-read cold it does the job — it says the assets are deliberately not published, why (pixels carry home paths, usernames and private session titles no text scan can see), why the citation lines were left rather than rewritten, and what a dead path means: "this evidence exists and was not published", not "this file is missing". No lines were stripped from the 86 append-only tickets.

  **Both destinations prepared. Nothing pushed, no public repo created, the mirror never run with --push.** Private: `npm run gate` PASS unpiped, exit 0 read directly, waiver surfaced. Public: `bash scripts/publish-public-mirror.sh --out <scratch>` built 860 files, gate PASS, one commit, no remote. The built tree was then INSPECTED rather than trusted: README byte-identical to the newly committed one; LICENSE present, 4725 bytes, notice naming the repository with zero email shapes; `docs/bugs/assets/` absent and every image in the tree under `public/` or `docs/assets/`; `.mcp.json`, `.station-hands-off`, `.env`, `.claude/settings.local.json` and `registry.json` all absent; independent greps (not the gate) found no home path, no encoded home path, no real email, no non-loopback IP and no NUL-bearing text file — the only home-path hits are `/home/claude` (the container's own user), `/home/someone` and `/home/you` (placeholders). Runnable by a stranger: two runtime deps, lockfile present, `npm start` -> `node src/server/index.ts` which exists, entry + UI assets present, and all five README links resolve inside the tree.

  **Risk bucket: SECURITY / irreversible-disclosure.** An independent clean-room pass is warranted before the push, on two things specifically: the gate waiver (generation must not be its own only verifier), and the split-string class itself — the gate's blind spot is authored deliberately, one split string at a time, and one of those authors has now shipped a real address through it.
