```orchard-ticket
{
  "id": "BUG-112",
  "type": "bug",
  "title": "A verification sandbox could write into the live repository",
  "summary": "A sandbox built to inspect a fixed commit shared its dependency folder with the live checkout, so ordinary tooling inside it wrote to the real tree. One run rewrote the project's dependency files and triggered a mistaken revert in another lane. Dependencies are now copied instead of shared, and outward-pointing links are stripped after the sandbox is assembled.",
  "impact_if_we_wait": "A reviewer could silently alter the very code it was judging, or another lane's work. Bounded: this is a write path in a throwaway sandbox, not stored project data, and the one real incident was caught and repaired the same day.",
  "current_need": "Nothing is outstanding. Each of the three escape routes was first shown to succeed against the old shape, then shown blocked against the sandbox the current code builds.",
  "severity": "high",
  "area": "Verification tooling",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-19",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "Should a clean room have network access?",
      "mode": "single",
      "options_keys": [
        "keep",
        "remove"
      ],
      "chosen": "keep",
      "chosen_on": "2026-08-19",
      "chosen_by": "agent",
      "note": "Fetching a reference implementation is evidence a verifier is asked to gather; the fault was the write into the live tree, now closed at the filesystem. The residual risk of third-party code running as our user is the same risk any install here already carries, and it now runs against a throwaway copy."
    }
  ],
  "success_criteria": [
    "Nothing done inside a clean room modifies any file in the live repository",
    "A package manager run from inside the room's dependencies cannot reach the live project root",
    "A relative path climbing out of the dependency folder stays inside the room",
    "Every symlink resolving outside the assembled room is removed before the verifier starts",
    "Relative in-room links such as the dependency bin directory keep working"
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "provisionModules",
      "note": "copies with `cp -a --reflink=auto`, falls back to fs.cpSync with verbatimSymlinks, and leaves the room without dependencies rather than with a link; prints mode and elapsed ms on stderr"
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "auditSymlinks",
      "note": "runs after assembly; removes every symlink whose target resolves outside the room, judging dangling links textually, and reports removals on stderr"
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "buildCleanroom",
      "note": "whole build now 0.49 s wall, 425 ms of it the copy"
    },
    {
      "path": "scripts/verify-independent-verification.mjs",
      "symbol": "section (F) containment",
      "note": "ten checks against a realistic fixture live repo, each escape proven to work against the old shape before being proven contained"
    },
    {
      "path": "scripts/verify-independent-verification.mjs",
      "symbol": "ambient/methodology strip check",
      "note": "regressed-from: commit 1f21c35 — boot-stub seeding re-created the placeholder doc, so an absence assertion went vacuous; now asserts gone, or provably inert and carrying no methodology marker"
    },
    {
      "path": "scripts/dispatch.mjs",
      "symbol": null,
      "note": "documents that `--sandbox workspace-write` is kernel-enforced on the openai/codex path but only an application-level permission gate on the anthropic path"
    }
  ],
  "related": [
    {
      "id": "BUG-104",
      "relation": "see_also"
    },
    {
      "id": "BUG-092",
      "relation": "see_also"
    },
    {
      "id": "BUG-106",
      "relation": "see_also"
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
    "archived_path": "docs/bugs/archive/BUG-112-clean-room-node-modules-symlink-is-a-write-path-into-the-live-repo.md",
    "sha256": "3fcec3b6e2391be9875b521b3dbe476d728d8057f90a1bbeeaa4a2211c8f90c9",
    "bytes": 15059,
    "original_title": "the clean room's `node_modules` was a symlink into the live repo, so a verifier could write to the code it was judging",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the symlink mechanism, the three probes, the network answer, the cost table and all three residuals are present.",
    "dropped": [
      "the context pack's restatement of files already in code_refs",
      "the verification-class annotation, carried by the schema field"
    ]
  }
}
```

# BUG-112 — A verification sandbox could write into the live repository

## Diagnosis

### The shape of the leak

The clean room's `node_modules` was a symlink into the live repository. A symlink is a two-way door: every relative path, every package manager, and every tool that resolves real paths was operating on the live tree, not on the room.

The direction of the leak is the point, not the tidy-up. A verifier that can write into the live repository can modify the code it is judging, or the tree another lane is working in, as an ordinary side effect of ordinary tooling — no malice and no unusual command required. Verifiers are now actively encouraged to install reference implementations to check our behaviour against, so this was scheduled to recur.

### The fix

`provisionModules(repo, dir)` replaces the `fs.symlinkSync`. It copies with `cp -a --reflink=auto`, falls back to `fs.cpSync(..., { verbatimSymlinks: true })`, and if both fail leaves the room without dependencies rather than with a link — fail open on capability, closed on safety.

`auditSymlinks(dir)` then runs over the assembled room and removes every symlink resolving outside it. This closes the class rather than the instance: `git archive` exports repo symlinks faithfully and a dependency can ship one, so `node_modules` was only the escape we happened to know about. Relative in-tree links such as `node_modules/.bin/*` survive.

## Evidence

### The incident

A clean-room verifier ran `npm install commonmark`. The package was written into the live repository's `package.json` and `package-lock.json`, and installed into the live `node_modules`, where it remains, untracked. A second agent reverted both files to HEAD; a third lane was concurrently editing `package.json` and had to be warned its own work might have been reverted underneath it.

### Three escapes, each proven live against the old shape

Against a synthetic-but-realistic live repo — real manifest and lock content, a populated `node_modules`, real git history:

1. Relative-path escape: `echo '{"PWNED":1}' > node_modules/../package.json` exits 0 and overwrites the live `package.json`. The kernel resolves `..` after the symlink, so the write never touches the room.
2. Direct write: `echo hi > node_modules/_cleanroom_was_here` appears at `<live-repo>/node_modules/_cleanroom_was_here`.
3. Package manager, the incident's exact mechanism: `cd node_modules && npm install commonmark` walks up from the real path, finds the live repo root, and rewrites the live tree — live `git status` shows both manifest and lockfile modified, with `commonmark` added.

With npm 12.0.1 and the cwd at the room's root, npm warns `reify Removing non-directory .../node_modules` and reinstalls locally, so the write-through depends on where the verifier happens to stand. That is exactly why containment has to be structural: the escape is one `cd` away, and other package managers need no `cd` at all.

### After the fix

`npm run verify:independent-verification` reports 152 of 152 checks passing, section (F) among them; harness run `8f3a5932`. Section F carries its own must-FAIL non-vacuity proof.

### Measured cost

| | |
|---|---|
| `node_modules` under test | 374 MB, 10,871 files, 115 top-level packages |
| `cp -a --reflink=always` (btrfs) | 0.42 s, ~0 extra disk |
| `cp -a --reflink=never` (no CoW) | 1.11 s, 374 MB |
| whole clean-room build, post-fix | 0.49 s wall, 425 ms of it the copy |
| containment audit over the assembled room | no measurable addition |

A verification dispatch takes minutes. The cost of copying is noise; the write path was not.

## Implementation notes

### Repaired in passing

The check `the clean room strips every ambient/methodology path` had been failing at HEAD since boot-stub seeding landed. The seeder re-creates `docs/prompts/WORKING_AGREEMENT.v2.md` as an inert placeholder and the check asserted mere absence. It now asserts gone, or provably inert and carrying no methodology marker — the property that was always meant, and one that stays non-vacuous, since re-seeding the real file fails it loudly.

## Verification plan

The property to hold: nothing done inside a clean room modifies any file in the live repository, through any path, by any tool, deliberately or accidentally. Each probe must first be shown to genuinely succeed against the old shape, then shown contained against a room the current code builds. `npm run verify:independent-verification` is the entry point; section (F) holds the ten containment checks.

## Risks

### Residuals, deliberately left open

The dispatch sandbox, not the clean room, is the last wall against a deliberate absolute-path write. This fix removes every path ordinary tooling traverses, but a verifier that types an absolute path into the project directly is stopped only by the dispatch layer, where the two providers are not equal. That is out of this lane and flagged here because it is now the largest remaining hole — larger than network access.

The room's dependencies are the live ones, not the lockfile's. Copying preserves the old behaviour of handing the verifier whatever is installed right now, including anything a previous verifier installed; the live `node_modules` still physically contains the `commonmark` from this incident. It is inbound contamination of a mild kind: the room's code is at a fixed commit, its dependencies are not. Installing from the exported lockfile would cost a real install per run and is not obviously worth it.

The contamination strip is still incomplete — real methodology text and full ticket snapshots remain readable via other paths. That belongs to BUG-104, which is open and was not touched here. BUG-112 overlaps it only at the boot-stub check above.

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
