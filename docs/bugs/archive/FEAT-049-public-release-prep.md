# FEAT-049 — public-release prep: scrub, security posture, rename, fresh-history mirror

- **Status:** OPEN — cleanup complete + release scripts tested; recommend keep open until you run the publish.
- **Area:** repo hygiene / docs / release engineering
- **Reported:** 2026-08-06 by user (external review findings: board names private projects
  (external-project-A), hardcoded home paths, security posture must be prominent
  (allowDangerouslySkipPermissions / docker-socket opt-in), finish/note the Orchard rename)

## In plain terms
Getting the project ready to share publicly. The catch: even after private details (private project names,
home-folder paths, personal context) are cleaned out of the current files, the project's git HISTORY still
contains all of it — so publishing as-is would expose everything anyway. Publishing without handling this would
leak private information permanently into a public record.

**Recommendation:** keep THIS repo private as the working history, and publish a fresh, history-free public
copy instead — plus a clear security write-up and the rename to "Orchard". Most of the cleanup and the release
scripts are already written and tested (not yet run).

**Where it stands:** the cleanup is done; the rename and public-mirror scripts are written and tested without
being run. It's waiting on you to actually run the release steps when you decide to go public.

**What I need from you:** triage — keep it open until you're ready to publish?

**If you do nothing:** nothing breaks; nothing is published; this stays open.

> Everything below is the detailed constraint, work items, and the full audit/scrub record — reference.

## Key constraint the review missed
Scrubbing WORKING-TREE files is insufficient: git HISTORY contains external-project-A references,
home paths, and personal context throughout (commits + ticket evolution). Publishing this
repo as-is exposes all of it. Strategy decision (orchestrator rec): keep THIS repo private as
the working history; publish a FRESH-HISTORY public mirror (orphan/squash initial commit from
scrubbed tree). A rename to `orchard` then applies naturally to the new public repo.

## Work items
1. **Leak audit (read-only first):** inventory every private artifact in the current tree —
   external-project-A (and any other private project names), home paths, email, machine details,
   tokens/keys (should be none — verify), personal context in tickets. Produce the scrub list
   with file:line counts before changing anything.
2. **Scrub pass:** neutralize in the working tree (e.g. external-project-A → "external-project-A" in
   board/ticket text where the reference isn't load-bearing; home paths → $HOME or relative;
   FEAT-044's ticket may keep a genericized narrative). docs/bugs is append-only by convention —
   a privacy scrub is the sanctioned exception; note it in each touched ticket's log.
3. **Security posture doc:** README section (or SECURITY.md) making the posture obvious:
   permission modes incl. bypass is explicit opt-in per project/session; docker-socket toggle is
   arm-then-confirm with stated consequences; sandbox/container tiers; localhost-only binding.
4. **Rename script (FEAT-036 revived under this ticket):** `scripts/rename-to-orchard.sh` the
   USER runs from a plain terminal (never from inside an Orchard session): stop service → mv
   directory → rewrite systemd unit + .desktop paths → daemon-reload → migrate the
   ~/.claude/projects/<encoded-path> memory/transcript dir to the new key → `gh repo rename`
   (optional flag) + `git remote set-url` → restart + verify health. Idempotent-ish, dry-run
   default, loud aborts. NOT executed by any agent.
5. **Public mirror script:** `scripts/publish-public-mirror.sh` — builds the scrubbed
   fresh-history tree into a new repo (orphan branch / new git init), runs a final leak grep
   gate (fails on external-project-A|~|email hits), pushes ONLY on explicit --push with a repo
   name the user provides. NOT executed.

## Verification
Leak audit reproducible (a grep gate script that exits 1 on any private token — reusable as the
mirror's final gate); scrub leaves board:check green + verify:ui/typecheck green; rename script
dry-run output correct on this machine's real paths (no execution); mirror script produces a
tree that passes the leak gate (build to a scratch dir, no push).

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
