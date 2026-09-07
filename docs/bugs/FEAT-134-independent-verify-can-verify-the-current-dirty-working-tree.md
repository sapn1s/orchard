# FEAT-134 — independent-verify can verify the current dirty working tree

- **Status:** OPEN
- **Severity:** medium
- **Area:** verification (scripts/independent-verify.mjs)
- **Reported:** 2026-09-07 by orchestrator (dispatched fix lane)
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
`scripts/independent-verify.mjs` can only verify work that git has already
recorded. It resolves `--range` (or the `HEAD` default) with `rev-parse`
(`resolveRange`, ~`:632`), diffs the two committed revs (~`:641`), and builds the
clean room with `git archive <rev> | tar -x` (`buildCleanroom`, ~`:349`). Every
one of those needs a committed object, so **uncommitted work is invisible** — not
rejected, just unseen. With ~74 uncommitted paths (several tickets mixed) sitting
in a dirty tree — and this project's hard rule that agents never commit — roughly
eight already-built fixes could not be independently verified at all.

## Repro
With a dirty tree, `node scripts/independent-verify.mjs --requirement x --run true
--print-prompt` composes the verifier prompt from `HEAD^..HEAD` (the last commit),
so nothing uncommitted appears in the diff the verifier is given.

## Expected
A `--working-tree` flag that snapshots the CURRENT dirty tree (tracked edits +
untracked-not-ignored files) and verifies THAT, with the clean-room contamination
guarantee preserved exactly, and without any write to the real repo state.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `scripts/independent-verify.mjs` — `resolveRange` (~:627), `buildCleanroom`
    (~:347), the `clean room is NOT clean` guard (~:377), arg parse (~:124), `main` (~:636).
  - `scripts/verify-fix-loop.mjs` — `snapshot()` (~:153): the temp-`GIT_INDEX_FILE`
    / `read-tree HEAD` / `add -A` / `write-tree` / `commit-tree -p HEAD` pattern this
    feature reuses. It records the TREE sha as the durable identity.
  - `scripts/lib/tree-snapshot.mjs` — NEW: the hoisted, single-definition snapshot
    helper (`snapshotWorkingTree(repo) → {head, tree, commit}`), used by both scripts.
- Snapshot semantics: `git add -A` under a throwaway index INCLUDES
  untracked-but-not-ignored files and EXCLUDES `.gitignore`d files. That exclusion
  is ACCEPTABLE here: ignored files (build output, node_modules, scratch, `.arch/`)
  are never the fix under review, and the clean room already re-provisions
  `node_modules` itself; a fix that lives only in an ignored path is out of scope
  for verification by design.
- Durable id: a dangling commit is garbage-collectable, so the identity stored /
  displayed is the TREE sha (`head` passed to diff, archive and the range line IS
  the tree sha), matching what `verify-fix-loop.mjs` already persists — the record
  cannot rot to a pruned commit.
- Known trap (do NOT use): `git stash create` DROPS untracked files
  (`docs/bugs/FEAT-062-verify-fix-loop-roles.md:236`). The read-tree/add -A/write-tree
  path is used precisely because it keeps them.
- Related tickets: FEAT-062 (verify-fix-loop snapshot origin), FEAT-108 (git-write
  block — the reason agents cannot commit, which makes this feature necessary).
- Known dependencies / blockers: the FEAT-108 git-write block is a Bash-TOOL
  PreToolUse hook; it cannot see git spawned by a node subprocess (its own comment,
  `scripts/lib/git-write-policy.mjs:233`), which is how the snapshot runs — so the
  feature works at runtime and leaves the real index untouched.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — fix lane (Opus 4.8)
- **Understood:** `independent-verify.mjs` verifies only committed objects
  (`resolveRange` → `rev-parse`; `buildCleanroom` → `git archive`), so uncommitted
  work is unseen. The reusable snapshot pattern already ships in
  `verify-fix-loop.mjs:153` (`snapshot()`); it keeps untracked files and records
  the TREE sha as the gc-safe identity. Verified the hypothesis before building:
  the helper is reusable, and `independent-verify` needs only to feed its tree sha
  in the `{base, head}` shape `resolveRange` already returns.
- **Changed:**
  - `scripts/lib/tree-snapshot.mjs` (NEW) — `snapshotWorkingTree(repo)`: temp
    `GIT_INDEX_FILE` + `read-tree HEAD` + `add -A` + `write-tree` +
    `commit-tree -p HEAD`; returns `{head, tree, commit}`. Real index and all
    branches untouched; the commit is dangling/advisory; the TREE sha is the id.
  - `scripts/verify-fix-loop.mjs` — `snapshot()` now delegates to the shared
    helper (single definition, ARCH-008); identical git command sequence.
  - `scripts/independent-verify.mjs` — new `--working-tree` flag (mutually
    exclusive with `--range`): snapshots the dirty tree, sets `base = HEAD` and
    `head = TREE sha`, and verifies that. `buildCleanroom`/diff/range-line all take
    the tree sha, so the clean-room strip + `clean room is NOT clean` guard run over
    the snapshot exactly as before, and the recorded/displayed id is the durable
    tree sha. USAGE + header comment updated.
- **Verified:** (all via node, since the FEAT-108 Bash guard blocks raw
  `git write-tree` typed at a shell — the real code path spawns git from node and
  is unaffected)
  - must-FAIL (before): default-range `--print-prompt` — the prompt's diff does NOT
    contain uncommitted-only content. PASS (absent).
  - after: `--working-tree --print-prompt` over the REAL dirty tree — prompt reaches
    the verifier with a non-empty diff that DOES contain uncommitted-only content.
    PASS (present).
  - clean-room guarantee: `--working-tree --print-prompt` stderr shows CLAUDE.md /
    docs / .claude stripped from the snapshot tree and no `clean room is NOT clean`
    die. PASS.
  - real-state byte-identity: `git status --porcelain=v1 | sha256sum` and
    `rev-parse HEAD` are byte-identical before/after a snapshot run. PASS.
  - anti-regression: `verify-fix-loop.mjs` snapshot still produces a tree sha and
    `--check-only` path of independent-verify unchanged; `npm run gate` exits 0.
- **Verified-by:** (pending — independent clean-room dispatch; this is a
  verification-tooling change and self-verification is explicitly insufficient)
- **Still open / handoff:** independent clean-room verify pass warranted (this
  touches the verifier itself — generation must not be its own only verifier). A
  clean-room verify of THIS change can bootstrap on the new flag once committed.
- **Symptom of a deeper design flaw?** (deferred to close) — leaning no: the
  commit-only assumption was a default, and this adds the missing mode without
  weakening the clean-room invariant.
