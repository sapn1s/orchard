---
sources:
  - docs/prompts/WORKING_AGREEMENT.v2.md
  - docs/prompts/ROUTING.md
  - docs/CONVENTIONS.md
  - src/server/templates.ts
  - src/server/index.ts
  - scripts/sync-methodology.mjs
  - scripts/wa-capture.mjs
  - scripts/wa-consolidate.mjs
  - scripts/arch-watch.mjs
---
# The Working Agreement & self-maintenance

## What the Working Agreement is

The **Working Agreement (WA)** is a *universal* methodology document — the standing
rules every session is expected to follow (verification is the deliverable, recover
by git, keep context lean, persist deliberately, and so on). It is deliberately
**project-agnostic**: it must not hard-code any one project's tools, paths, or sizes.

There are two kinds of rule doc, and the split is load-bearing:

- **Universal rules** live in the WA. The canonical source lives in a *separate
  methodology repo* (`~/projects/methodology`, overridable via `METHODOLOGY_DIR`).
  A **committed mirror** of it lives in this repo at
  `~/projects/orchard/docs/prompts/WORKING_AGREEMENT.v2.md` (plus `ROUTING.md`),
  kept current by `~/projects/orchard/scripts/sync-methodology.mjs` (`npm run
  sync:methodology`). The canonical repo is the source of truth; **edit the
  canonical copy, then sync** — never hand-edit the mirror.
- **Project-specific rules** live in each project's
  `~/projects/orchard/docs/CONVENTIONS.md` (path constant `LOCAL_CONVENTIONS_RELPATH`
  = `docs/CONVENTIONS.md`). This is the routing valve WA §L talks about: anything
  that would pollute every other project's sessions belongs here, not in the WA.

## How the WA reaches an agent (injection)

A launched session does not read these files itself — they are **injected into the
system prompt** at launch by `~/projects/orchard/src/server/templates.ts`. The
composer `composeInstructions(refs, { hostPath, routing })` layers the prompt in a
fixed order:

1. **Universal WA** — resolved from the `working-agreement*` templates. Those are
   read-through templates (`source:` frontmatter) that pull their body live from the
   `docs/prompts/WORKING_AGREEMENT*.md` mirror, so editing the mirror propagates with
   no re-seed.
2. **Project-local conventions** — `localConventionsSection(hostPath)` reads that
   project's `docs/CONVENTIONS.md` and folds it in under a "Project Conventions
   (local)" header (opt-in: absent/empty file injects nothing; capped ~4 KB).
3. **Provider routing** — `routingSection()` injects the condensed core of the
   `docs/prompts/ROUTING.md` mirror (opt-in via `routing: true`).
4. **Live board snapshot** — layered *last* by the launch call site
   (`appendToSystemPrompt(..., boardStateSection(hostPath))`), because it needs a
   live board read, not a static file.

So a session receives: universal WA → its project's local conventions → routing →
live board state, all appended onto the Claude Code preset.

## Self-maintenance: capture and consolidate

Two scripts keep the WA healthy over time. Both honor `METHODOLOGY_DIR` and both are
**failure-tolerant by contract** — a broken/missing methodology repo must never crash
a boot or a capture, only log honestly.

### Capture — `scripts/wa-capture.mjs` (`npm run wa:capture`)

The *under-persist* guard. It **appends** one qualifying rule to the canonical WA
under a chosen section, then syncs the mirror. It enforces WA §L's persistence bar:
a rule is persisted only if it is a **standing preference** (its text contains
`always` / `never` / `from now on`) or a **recurring failure** (`--kind recurring
--recurrences N`, N ≥ 2). A one-off is **REFUSED / parked** (exit 3), never written.
Capture is **append-only** (prior version always git-recoverable) and tags each
bullet with its provenance (`_(captured DATE — standing preference)_`). After a
successful append+sync it triggers an automatic consolidation mini-pass (below),
unless `--no-consolidate` / `--no-sync`.

### Consolidate — `scripts/wa-consolidate.mjs` (`npm run wa:consolidate`)

The *over-accumulate* guard: the opinionated half that classifies captured blocks,
relocates project-specific leaks, dedups near-duplicate sections, and cleans up.

**What triggers it (three ways, same code path):**

- **At server boot** — `~/projects/orchard/src/server/index.ts` spawns
  `wa-consolidate.mjs --apply` (non-blocking, unref'd). Gated by
  `CLAUDE_STATION_NO_WA_CONSOLIDATE` (set it to skip every automatic pass).
- **After every capture** — the mini-pass wa-capture fires (same env opt-out).
- **By hand** — `npm run wa:consolidate -- --apply` (or without `--apply` for a
  propose-only dry run).

**What it does.** Without `--apply` it is **propose-only**: it scans and writes a
reviewable `CONSOLIDATION-PROPOSAL.md`, asserting the WA byte length is unchanged.
With `--apply` it auto-applies only the **safe, deterministic classes**, each as one
revertable git commit in the methodology repo + a `CHANGELOG.md` entry, then syncs
the mirror:

- **(a) Relocate** a whole rule section that is *unambiguously* project-specific into
  the owning project's `docs/CONVENTIONS.md` (create/append, never overwrite; a
  pointer stub keeps the `§letter` cross-reference resolvable).
- **(b) Merge** near-duplicate sections (Jaccard ≥ 0.5 — keep the richer wording,
  move unique content over, leave a pointer).
- **(c) Mechanical cleanup** (trailing whitespace, collapsed blank runs).

Everything that is a **judgment call is NEVER auto-applied** — it surfaces as a
`needs-human` finding (persisted to `$METHODOLOGY_DIR/.station/needs-human.json`, from
which the dashboard's Needs-You rail reads): genuine contradictions, *partial* or
*ambiguous* relocations, moderate-overlap merges, rules-without-a-why, and (FEAT-043)
a **stale routing table** (`ROUTING.md` researched > 90 days ago).

**The BUG-042 caveat (why relocation is so cautious).** A pass once relocated the
universal rule *"separate process, not a subagent"* out of the WA just because the
sentence mentioned a product name — silently weakening every session's instructions.
The fix: a block is project-specific only if a **non-illustrative** marker (not in
parentheses, not after `e.g.` / `for example` / `such as` / `like`) appears in its
**first sentence** (the normative clause), *or* if ≥2 distinct such markers appear.
Per-block relocation was **demoted to needs-human** entirely; the *only* auto-applied
relocation is a whole section where ≥2 blocks are *all* specific with ≥2 markers each.
An applied relocation still lands on the rail as a `relocation-applied` finding so a
human reviews it after the fact.

**The BUG-040 caveat (boot side effects).** A boot pass used to mutate *this* repo's
real state (arch findings, CONVENTIONS.md) even for a scratch verify server, because
`--apply` defaulted its dirs module-relative. Now the boot pass acts on the **server's
own configured world**: only if this repo is the server's registered methodology-home
does it get `--conventions-dir <home>`; any other/scratch server runs `--no-arch` and
points conventions inside its own `dataDir`, so it cannot touch a repo it was never
configured with.

**How you steer / change it.** Key knobs:

- `--apply` — auto-apply the safe classes (requires the methodology dir to be a git
  repo — the recoverability contract). Omit for propose-only.
- Tag a rule ``universal:`` — a **protected marker**; that block is never relocated
  or flagged (use it when a project name is only an illustration).
- `--conventions-dir <dir>` — which project owns relocated rules.
- `--no-sync` — skip the canonical→mirror sync; `--no-arch` — skip the arch pass.
- `--no-consolidate` / `--no-sync` (on **wa-capture**) — decouple the append from the
  follow-on pass.
- `CLAUDE_STATION_NO_WA_CONSOLIDATE=1` — the harness-wide "no automatic maintenance
  passes" switch (suppresses the boot pass, the post-capture mini-pass, and the arch
  ride-along).
- Rollback is always one `git revert` in the methodology repo.

### Arch-watch ride-along — `scripts/arch-watch.mjs`

The recurrence detector rides this same consolidation loop (boot + post-capture)
rather than inventing a fourth schedule — it is the only recurring, failure-tolerant
loop in the system. It is loaded by dynamic import inside a try/catch, so any failure
degrades to one honest warning and never breaks the pass. Findings are **per-project**
(written to that project's `docs/bugs/.arch/findings.json`, surfaced on that project's
Needs-You rail). Run it standalone with `wa-consolidate --check-arch`; suppress the
ride-along with `--no-arch` or the env switch above.
