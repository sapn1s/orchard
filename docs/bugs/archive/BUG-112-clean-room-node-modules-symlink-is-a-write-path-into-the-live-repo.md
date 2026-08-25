# BUG-112 — the clean room's `node_modules` was a symlink into the live repo, so a verifier could write to the code it was judging

- **Status:** VERIFIED — fixed and committed (`43e6065`); clean-room verdict HOLDS
- **Severity:** high — a verification tool that can modify the working tree it is verifying, and did: it rewrote `package.json` and `package-lock.json` under a concurrent lane, whose work was then nearly reverted to repair the damage
- **Area:** verification tooling — clean-room construction in `scripts/independent-verify.mjs`
- **Reported:** 2026-08-19, from a live incident during a clean-room verification run
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (this is the script every independent pass runs through, and the change touches how every clean room is built)

## In plain terms

A clean room exists so an independent verifier can examine a fixed commit without contaminating, or being contaminated by, our working tree. It was not a room. Its `node_modules` was a **symlink into the live repository**, and a symlink is a two-way door: everything reached through it — every relative path, every package manager, every tool that resolves real paths — was operating on the live tree.

That door was walked through. A verifier ran `npm install commonmark` inside its clean room and the dependency landed in the **live** `package.json` and `package-lock.json`. Another agent spotted it and reverted both to HEAD — while a different lane was editing `package.json`, so that lane had to be warned its own work might have been reverted underneath it. One verification run produced a repo-wide edit, a mistaken revert, and a scare in an unrelated lane.

The tidy-up is not the point. The point is the direction of the leak. A verifier that can write into the live repository can modify **the code it is judging**, or the tree other lanes are working in, as an ordinary side effect of ordinary tooling — no malice and no unusual command required. And we now actively encourage verifiers to install reference implementations to check our behaviour against, so this was scheduled to recur.

**The fix: the clean room's dependencies are COPIED, never linked**, and after the room is assembled every symlink in it that resolves outside the room is removed. The objection to copying was cost, so it was measured rather than assumed: on this project's 374 MB / 10,871-file `node_modules`, `cp -a --reflink=auto` takes **0.4 s** and costs ~0 extra disk on a copy-on-write filesystem (btrfs/XFS), and **1.1 s / 374 MB** when the copy has to be real. A whole clean-room build now takes **0.49 s**. A verification dispatch takes minutes. The cost is noise; the write path was not.

The property to hold is: **nothing done inside a clean room modifies any file in the live repository.** It is now proven three ways — through the old symlinked path, through a package manager resolving its project root from inside `node_modules` (the incident's exact mechanism), and through a relative-path escape (`node_modules/../package.json`, where the kernel resolves `..` *after* the symlink and lands on the live file). Each probe is first shown to genuinely succeed against the old shape, then shown contained against a room the current code builds.

### Should a clean room have network access? Recommendation: keep it

Network is what let the install happen, so removing it is the reflexive move. It is the wrong one.

The failure was not that the verifier could fetch a package — that is a legitimate and useful thing for a verifier to do, and we ask for it: checking our markdown handling against a reference implementation is exactly the kind of independent evidence a clean room is for. The failure was that fetching **wrote into the live tree**. That is now closed at the filesystem, where it belongs, and closing it there also closes every non-network variant of the same escape.

The honest residual of keeping network: a verifier can pull arbitrary third-party code into a context that is reading our source, and run it as our user. That risk is real but it is not created by the clean room — it is the same risk any `npm install` in this repo already carries, and after this fix the fetched code executes against a throwaway copy at a fixed commit rather than against the working tree. Given that, the cost of removing network (verifiers silently lose a whole class of evidence, and quietly go back to static review, which is the failure mode this tool was built to stop) is larger than the marginal risk of keeping it.

If that trade is ever revisited, the lever worth pulling is not the network switch but the **dispatch sandbox** — see the residual below, which is a bigger hole than the network is.

> Everything below is the technical record — reference, not needed to understand the change above.

## Symptom

A clean-room verifier ran `npm install commonmark`. The package was written into the **live** repository's `package.json` and `package-lock.json` (and installed into the live `node_modules`, where it remains, untracked). A second agent reverted both files to HEAD; a third lane was concurrently editing `package.json` and had to be warned.

## Repro (all three verified against a synthetic-but-realistic live repo — real `package.json`/lock content, a populated `node_modules`, real git history)

With the pre-fix code, from inside a clean room built by `scripts/independent-verify.mjs`:

1. **Relative-path escape.** `echo '{"PWNED":1}' > node_modules/../package.json` → exit 0; the **live** `package.json` is overwritten (`git status` in the live repo: ` M package.json`). The kernel resolves `..` after the symlink, so the write never touches the room.
2. **Direct write.** `echo hi > node_modules/_cleanroom_was_here` → the file appears at `<live-repo>/node_modules/_cleanroom_was_here`.
3. **Package manager (the incident).** `cd node_modules && npm install commonmark` → npm resolves its project root by walking up from the **real** path, finds the live repo root, and rewrites the live tree:
   ```
   -- LIVE git status --
    M package-lock.json
    M package.json
   -- LIVE package.json commonmark --
   192:    "commonmark": "^0.31.2",
   ```

Note on npm versions: with npm 12.0.1, `npm install` run with the cwd at the clean room's *root* prints `npm warn reify Removing non-directory .../node_modules` and reinstalls locally — so the write-through depends on where the verifier happens to stand. That is exactly why the containment must be structural: the escape is one `cd` away, and older/other package managers need no `cd` at all.

## Expected

Nothing done inside a clean room modifies any file in the live repository — through any path, by any tool, deliberately or accidentally.

## The fix

`scripts/independent-verify.mjs`:

- **`provisionModules(repo, dir)`** replaces the `fs.symlinkSync` of `node_modules`. It copies with `cp -a --reflink=auto` (CoW where the filesystem offers it, a real copy where it does not), falls back to `fs.cpSync(..., { verbatimSymlinks: true })`, and if both fail leaves the room **without** dependencies rather than with a link — fail open on capability, closed on safety. The mode and the elapsed milliseconds are printed on stderr, so the cost is visible per run instead of assumed.
- **`auditSymlinks(dir)`** runs after the room is fully assembled and removes every symlink whose target resolves outside the room (dangling links are judged textually — where they *would* land). This closes the class rather than the instance: `git archive` exports repo symlinks faithfully, and a dependency can ship one, so `node_modules` was only the escape we happened to know about. Relative in-tree links (`node_modules/.bin/*`) survive — containment is not a blanket delete. Removals are reported on stderr, so a verification that lost something real is visible rather than mysterious.

`scripts/verify-independent-verification.mjs` gains section **(F) containment**, ten checks against a realistic fixture live repo, each escape proven to work against the old shape before being proven contained.

Also repaired while in the file: the check `the clean room strips every ambient/methodology path` had been **failing at HEAD** since boot-stub seeding landed (commit `1f21c35`) — the seeder re-creates `docs/prompts/WORKING_AGREEMENT.v2.md` as an inert placeholder, and the check asserted mere absence. It now asserts *gone, or provably inert and carrying no methodology marker*, which is the property that was always meant and stays non-vacuous (re-seeding the real file fails it loudly). `regressed-from: commit 1f21c35`.

## Measured cost

| | |
|---|---|
| `node_modules` under test | 374 MB, 10,871 files, 115 top-level packages |
| `cp -a --reflink=always` (btrfs) | **0.42 s**, ~0 extra disk (CoW) |
| `cp -a --reflink=never` (worst case: no CoW support) | **1.11 s**, 374 MB |
| whole clean-room build, post-fix (`--print-prompt`, real CLI) | **0.49 s** wall, of which 425 ms is the copy |
| symlink containment audit over the assembled room | included in the above (no measurable addition) |

## Residuals — deliberately left open

- **The dispatch sandbox, not the clean room, is the last wall against a *deliberate* absolute-path write.** This fix removes every path ordinary tooling traverses, but a verifier that types `/home/<user>/<project>/src/...` directly is stopped only by the dispatch layer — and there the two providers are not equal: `scripts/dispatch.mjs` documents that `--sandbox workspace-write` is a **kernel-enforced** write jail on the openai/codex path but only an **application-level permission gate** on the anthropic path. Out of this lane (`dispatch.mjs`); flagged here because it is now the largest remaining hole, larger than network access.
- **The room's dependencies are the LIVE ones, not the lockfile's.** Copying preserves the old behaviour of handing the verifier whatever is installed right now — including anything a previous verifier installed (the live `node_modules` still physically contains the `commonmark` from this incident). It is inbound contamination of a mild kind: the room's code is at a fixed commit, its dependencies are not. Installing from the exported lockfile instead would cost a real install per run and is not obviously worth it; recorded rather than fixed.
- **The contamination strip is still incomplete** — real methodology text and full ticket snapshots remain readable via other paths. That is **BUG-104**, which is open and was not touched here. This ticket overlaps it only at the boot-stub check noted above; the strip's coverage gap is BUG-104's to close.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/independent-verify.mjs` → `provisionModules()`, `auditSymlinks()`, `buildCleanroom()`; `scripts/verify-independent-verification.mjs` → section (F)
- Related tickets: BUG-104 (contamination strip incomplete — the same construction, the other direction); BUG-092 / BUG-106 (earlier clean-room transport and argv defects)
- Repro test: `npm run verify:independent-verification` (section F carries its own must-FAIL non-vacuity proof)
- Known dependencies / blockers: none

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — clean-room isolation lane
- **Understood:** the clean room symlinked `node_modules` into the live repo, which made it a write path into the tree under test. The reported `npm install` incident is one instance of a class; the class is "any path that resolves through the link".
- **Changed:** `scripts/independent-verify.mjs` (copy instead of symlink + post-assembly symlink containment audit + honest stderr reporting), `scripts/verify-independent-verification.mjs` (new section (F), ten checks; plus the repair of the pre-existing red strip check).
- **Verified:**
  - MUST-FAIL first, real output, against a realistic fixture live repo with the **pre-fix** code: relative escape overwrote the live `package.json` (`write exit=0`, live file replaced); direct write planted `<live>/node_modules/_cleanroom_was_here`; `cd node_modules && npm install commonmark` produced ` M package.json` + ` M package-lock.json` in the live repo with `"commonmark": "^0.31.2"` at line 192.
  - Post-fix, same three probes, same fixture: live `package.json` md5 `fcb0717b…` and `package-lock.json` md5 `358214fb…` **unchanged**; every write landed inside the room; `git status` on the live repo shows no modified tracked file.
  - `node scripts/verify-independent-verification.mjs` → **152/152 PASS, exit 0** (1 SKIP: a restricted-sandbox capability check). Baseline at HEAD, run from a `git archive` export: **141/142, exit 1** — the one failure being the pre-existing strip check repaired here.
  - Cost measured, not assumed — see the table above.
- **Verified-by:** `dispatch anthropic run 8f3a5932-8e91-4023-8578-1fe4cb23002b (clean-room, scripts/independent-verify.mjs) — VERDICT: HOLDS` — run against commit `43e6065`, manifest-backed, three adversarial cases the fixer's fixture does not cover, all contained:
  - an **absolute-target and a dangling escaping symlink planted deep inside the copied `node_modules`** (the fixture only plants a relative in-tree link there) — both removed by `auditSymlinks`, write-through impossible;
  - an **escaping symlink committed deep in `src/`** rather than at the top level — the recursive walk reaches and removes it;
  - **mutating an existing file that was copied out of live `node_modules`** — the case that would expose a hardlink/alias copy. Live content unchanged (`live ms before/after: "LIVE_ORIGINAL"`), confirming the reflink copy is copy-on-write and not an alias. That third case is the one worth keeping: it tests a property the fixer never thought to state.
  - The verifier's own `UNTESTED` block names the gaps honestly: no real-network `npm install` (no registry access in the room), the non-CoW `fs.cpSync` and copy-failure branches of `provisionModules` were not exercised (btrfs took the reflink path), and a deliberate absolute-path write is the dispatch-sandbox residual, not defended by this diff.
- **Still open / handoff:** the three residuals above; the dispatch-sandbox asymmetry is the one worth a ticket if anyone wants the property to hold against a *deliberate* escape rather than an accidental one. Also observed while working (not caused here, not this lane's files): the live `package.json` / `package-lock.json` currently carry an uncommitted `commonmark` entry again, and the live `node_modules` still contains the package.
- **Symptom of a deeper design flaw?** no — a single construction shortcut (link where a copy was meant), not a recurring pattern. The structural suspicion worth carrying forward is recorded as a residual rather than an ARCH ticket: verifier confinement actually lives in the dispatch sandbox, and that sandbox is kernel-enforced on one provider and advisory on the other.
