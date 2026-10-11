```orchard-ticket
{
  "id": "BUG-243",
  "type": "bug",
  "title": "Pin/unpin fails for a session whose project was relocated on disk",
  "summary": "Pinning or unpinning a session whose project was relocated on disk (transcript moved into the new store dir but still recording the old cwd) is refused with a 409 encoding-mismatch, so the session can never be pinned, unpinned, renamed or deleted from the UI.",
  "impact_if_we_wait": "Every session carried over from before a project relocation is frozen: the user cannot pin, unpin, rename or delete it, and the refusal reads like a safety guard the user cannot satisfy. The sidebar accumulates un-mutable rows with no recourse short of editing the transcript by hand.",
  "current_need": "Address the SDK mutation by a path that encodes to the store dir the transcript actually lives in (the registered project hostPath), via an owner-declared store lookup, without weakening the guard for operations that truly write via the SDK-by-cwd.",
  "severity": "medium",
  "area": "server / session-mutations",
  "reported": "2026-10-08",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-08",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Pin AND unpin succeed for a session in a registered project store whose recorded cwd (a pre-move path) does not encode to that store dir.",
    "Rename and delete (the sibling mutations sharing resolveSession) also succeed for such a session.",
    "The guard still refuses a session in an UNREGISTERED store with a mismatched cwd, and any declared address that does not encode to the dir.",
    "A synthesized pre-fix must-FAIL repro reddens before the fix (409 encoding-mismatch) and passes after, on a scratch server using isolatedServerEnv/CLAUDE_STATION_DATA."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-155",
      "relation": "see_also"
    },
    {
      "id": "BUG-138",
      "relation": "see_also"
    },
    {
      "id": "ARCH-010",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "8a8a2fc6-a5f9-4779-a655-9dad1a399c02",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T23:57:13.356Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "opus",
      "run_id": "922dad6a-6618-4c57-8516-b30e897a80b8",
      "verdict": "holds",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T00:10:59.134Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-243 — Pin/unpin fails for a session whose project was relocated on disk

## Symptom
In the UI, unpinning (and pinning) a relocated session fails with a 409:

> session <id> lives in store dir "-…-projects-orchard" but its recorded cwd "…/projects/claude-station" encodes to "-…-projects-claude-station". The SDK addresses sessions by cwd, so mutating this one would target the wrong directory. Refused.

(Home-path prefix elided above to keep this ticket publishable.)

## Repro
1. A project is relocated on disk (…/projects/claude-station → …/projects/orchard). Its old transcripts are moved into the NEW store dir (`-…-projects-orchard`) but still record the OLD cwd (`…/projects/claude-station`).
2. Pin or unpin such a session in the sidebar.
3. `resolveSession` (src/server/session-mutations.ts) computes `encodeCwd(recordedCwd)` and finds it ≠ the store dir the file sits in, so the cwd/store-dir guard throws 409 `encoding-mismatch`. Pin, unpin, rename and delete are all blocked.

## Expected
Pin/unpin (and rename/delete) work for a relocated session. The guard must stay in force for operations that would truly address the wrong directory (an unknown/unregistered store with a mismatched cwd stays refused).

## Root cause
Pin genuinely writes into the SDK transcript via `tagSession(id, tag, {dir})`, which is addressed BY cwd — so the guard is correct to protect it. But for a relocated project the recorded cwd no longer encodes to the store dir the file actually lives in, and the FEAT-155 `DeclaredStoreLookup` only declared container (`-workspace-<id>`) stores, not a registered project's own relocated store. With no declaration, the guard refused every mutation.

## Fix
The registry owns the fact "store dir D belongs to project P, addressed by hostPath" (ARCH-010). Extended the server's `DeclaredStoreLookup` (src/server/index.ts, renamed `declaredContainerStore` → `declaredStore`) so that when a registered project's CURRENT hostPath encodes to the store dir, it declares `{address: hostPath, recordedCwds: [hostPath, ...pastPaths], ownsDir: true}`. New `ownsDir` flag on `DeclaredStore` (src/server/session-mutations.ts): dir membership is authoritative, so the SDK is addressed by hostPath (which encodes to exactly that dir) whatever stale cwd the moved transcript recorded — no recordedCwds enumeration needed (a relocated cwd is an arbitrary old path, as here where `pastPaths` is empty). The safety invariant is unchanged and still enforced: `encodeCwd(address) === dir` and `!resolvesElsewhere(address)`, so the SDK always targets the dir the file sits in; a wrong address or a symlinked address is still refused even with `ownsDir`. All four mutation routes (pin/unpin/rename/delete) share `resolveSession`, so the whole class is fixed at once. The fix is narrow: an unregistered store with the same mismatch is still refused.

## Context pack (grows; the where-to-look)
- Files/functions: src/server/session-mutations.ts (`resolveSession` guard, `DeclaredStore`/`DeclaredStoreLookup`, `setPinned`); src/server/index.ts (`declaredStore` lookup ~line 319, 4 `resolveSession` call sites); src/server/registry.ts (`pastPathsOf`, `Project.pastPaths`, BUG-138).
- Repro test: `npm run verify:bug-243` (scripts/verify-bug-243-relocated-pin.mjs).
- Related: FEAT-155 (container store declaration — same guard), BUG-138 (pastPaths/relocation), ARCH-010 (owner-declares-the-fact).
- Verification-class: fix.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-08 — fixing lane (fix, round 1)
- **Understood (confirmed against the live artifact):** registry project `claude-station` has `hostPath=…/projects/orchard`, `pastPaths` absent; the real session file lives in `-…-projects-orchard` and records cwd `…/projects/claude-station`. Pin writes via SDK `tagSession({dir})` keyed by cwd, so the dispatch hypothesis's "pin is pure Orchard metadata, route around the SDK" branch is REFUTED — the guard is correct and the right fix is to supply the SDK a path that targets the real store dir (hypothesis branch 2).
- **Changed (all unstaged; the user commits):**
  - src/server/session-mutations.ts — `DeclaredStore` interface + `ownsDir` flag; guard accepts the declared address when `ownsDir || recordedCwds.includes(cwd)`, keeping `encodeCwd(address)===dir && !resolvesElsewhere(address)` as the sole safety invariant; comment updated.
  - src/server/index.ts — `declaredContainerStore` → `declaredStore`, extended to declare a registered project's own store (hostPath encodes to the dir) with `ownsDir:true` and `recordedCwds=[hostPath, ...pastPaths]`.
  - scripts/verify-bug-243-relocated-pin.mjs (new) + package.json `verify:bug-243`.
- **Verified (fixer's own run, necessary not sufficient):**
  - `npm run verify:bug-243` → **11 passed, 0 failed**. §1 pure: synthesized pre-fix (no declaration) reddens with 409 `encoding-mismatch`; with `ownsDir` it resolves and `sdkDir===hostPath` (encodes to the dir); a wrong address and a symlinked address are both still refused even with `ownsDir`. §2 scratch server (real routes + real SDK, fixture cut from a real transcript with cwd rewritten to a pre-move path): PIN, UNPIN (the user symptom), RENAME and DELETE all 200; an UNREGISTERED mismatched store stays 409; no other transcript changed.
  - Anti-regression (same guard): `node scripts/verify-feat-155-workspace-root.mjs --no-live` → **60/0**; `node scripts/verify-bug-086-pin-style.mjs` → **12/12**.
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Not run:** verify-bug-138-repoint.mjs crashes on a sandbox-blocked `git init` in its own scratch setup (PART B) with 3 downstream refusal-message FAILs from `agent-bridge.startSession` (a file this change does not touch) — environmental/pre-existing, unrelated to the session-mutation guard.
- **Deploy note:** server runs TypeScript directly (`node src/server/index.ts`), no build step; a service restart picks up the change.
- **Independent clean-room verify WARRANTED** (session-lifecycle + data-loss-adjacent: delete also routes through the relaxed guard; regression-prone guard shared with FEAT-155/BUG-138). Exact command: `npm run verify:bug-243`. Attack suggestion: that the relaxed guard can never address a DIFFERENT store dir than the file sits in (wrong/symlinked address refused), and that unregistered or truly-ambiguous stores stay refused.
- **Still open / handoff:** awaits independent verify before VERIFIED.
- **Symptom of a deeper design flaw?** candidate: the cwd→store-dir encoding is lossy and several subsystems independently reconstruct "who owns this store dir" (FEAT-155 container, BUG-138 relocation, this). Not filing a new ARCH ticket from a fix lane; flagged here for the orchestrator to decide whether it joins an existing class.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/opus run 8a8a2fc6-a5f9-4779-a655-9dad1a399c02 — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — independent clean-room verify (verify lane, round 1) — BROKEN
- **How:** `scripts/independent-verify.mjs --working-tree` (cross-provider openai first REFUSED the turn on a Codex "possible cybersecurity risk" content filter — the attack framing; not quota — so fell back to **anthropic/opus**, same-provider ⇒ decorrelation reduced, flagged below). `--working-tree` was forced because `index.ts` is a shared in-flight file (also carries BUG-239/242/234 hunks, claimed by BUG-239 in the candidate store), so no clean `--candidate`/committed boundary exists for BUG-243 alone; the room therefore saw the whole dirty tree (the exact tree the fixer ran green). Requirement given in plain terms + the 4-file diff + the fixer's test code; fixer report/rationale withheld.
- **Fixer test re-run (clean room):** `npm run verify:bug-243` → **11/0** (manifest 5461b7a62c7c, exit 0). Anti-regression `verify-feat-155 --no-live` → 60/0 (run 1fda84da8c50); `verify-bug-086` → 12/12 (run 3607e824f143).
- **Adversarial (new fixture authored by the verifier, run 3ea43b75ee3c / harness id `colliding-hostpaths-pastpaths-symlink-sa`, exit 1 = 8 pass / 2 FAIL):**
  - HELD: two registered hostPaths that encode to the SAME dir + same sid in a third store (no-dir → 409 ambiguous; pin/delete act only on the addressed file; foreign copy intact); registered project with `pastPaths` after a PATCH repoint (pin works in new dir; stale pastPath dir's foreign-cwd session still refused 409); symlinked registered hostPath (pin & delete refused 409).
  - **BROKE (data-loss): case D — a registered project whose hostPath encodes to >200 chars.** `resolveSession` accepts with `ownsDir:true` because `hist.encodeCwd(address) === dir` passes, but the SDK addresses dirs with its OWN encoder (`Vl()` in the SDK) which TRUNCATES encodings over 200 chars and appends a hash. So `tagSession`/`deleteSession` target a DIFFERENT (truncated) dir than the file sits in: **D1** pin wrote the tag into a same-id FOREIGN copy in the SDK-canonical dir; **D2 DELETE removed the foreign copy** instead of the addressed one (both then surfaced 500, but the irreversible delete already hit the wrong directory). Pre-fix this exact request was refused 409 `encoding-mismatch`; the relaxed `ownsDir` branch is what lets it through.
- **Root cause (confirms the fixer's own "deeper design flaw" flag):** the guard's safety invariant `encodeCwd(address) === dir` is checked with `hist.encodeCwd`, which is NOT the SDK's actual project-dir encoding — the two agree only for paths short enough that the SDK does not truncate. `ownsDir` removed the `recordedCwds` cross-check that previously happened to backstop this, exposing the lossy-encoding mismatch for long hostPaths.
- **Two-break rule:** NOT triggered — one property ("never mutate/delete a foreign session/dir") broke once, via a single path (long-hostPath SDK truncation). Recorded BROKEN, not routed to design review; but the finding is squarely the lossy-encoding design concern already flagged.
- **Could-not-test (verifier's list):** container project (`-workspace-<id>`) also relocated so both declaredStore branches claim the dir (no Docker in the room); Windows/macOS case-insensitive SDK encoding (Linux only); the `CLAUDE_CODE_PROJECT_DIR_NAME` SDK override; a concurrent mutation racing a PATCH repoint between `resolveSession` and the SDK call.
- **Decorrelation caveat:** verifier was same-provider (anthropic) because openai's content filter refused; the break is mechanically reproduced (run 3ea43b75ee3c) so it stands on executed evidence, but a cross-provider confirm remains desirable if a non-refusing provider becomes available.
- **Handoff:** BUG-243 fix does NOT hold — reopen for the fixer. The fix must make the guard compare against the SDK's REAL dir-encoding (or otherwise refuse when `encodeCwd` and the SDK encoder disagree), so `ownsDir` can never address a truncated/hashed dir different from the one the file sits in. Verdict files: `~/.local/state/claude-station/scratch/bug243-verdict-anthropic2.txt`; run log `~/.local/state/claude-station/scratch/bug243-iv-anthropic2.log`.

### 2026-10-08 — fixing lane (fix, round 2) — closes the long-path data-loss break
- **Understood:** round-1 independent verify (run 8a8a2fc6, fixture 3ea43b75ee3c) was RIGHT. The guard's safety invariant was evaluated with `hist.encodeCwd` (plain `[^a-zA-Z0-9]→-`), but the Agent SDK resolves a `dir` with its OWN encoder `Vl()` (sdk.mjs): plain-encode, and if the result exceeds 200 chars, truncate to 200 and append `-<hash36>` where the hash is a 32-bit `(h<<5)-h+c` rolling hash of the original cwd. The two agree only below the truncation threshold, so for a >200-char hostPath `sdkEncodeDir(address) ≠ encodeCwd(address)`: the guard said "address encodes to this dir" while the SDK went to a different, truncated dir — and `deleteSession` removed a same-id FOREIGN session there (confirmed with the REAL SDK, see §3).
- **Fix (structural — one encoder, the SDK's, at the chokepoint):**
  - src/lib/session-history.ts — new `sdkEncodeDir(cwd)`: a byte-for-byte reproduction of the SDK's `Vl()` (plain, then truncate@200 + `-<Math.abs(b_(cwd)).toString(36)>`). Documented as THE authority for "which dir does the SDK resolve this cwd to"; `encodeCwd` is now documented as plain-only, tolerable for listing, WRONG for a mutation guard on long paths.
  - src/server/session-mutations.ts — `resolveSession` now computes `expected = hist.sdkEncodeDir(cwd)` and the declared-store invariant `hist.sdkEncodeDir(decl.address) === dir`. One encoder, so there is ONE answer, not two — covering the ownsDir path, the FEAT-155 container (non-ownsDir) path, AND the happy path at the same chokepoint (the coordinator's "close it there too": the container path used the same `encodeCwd` invariant and is now on `sdkEncodeDir`).
  - src/server/index.ts — the `declaredStore` owner lookup matches by `hist.sdkEncodeDir(p.hostPath) === encodedDir`, so a registered project owns the dir the SDK actually files it under. Double safety for case D: a file sitting at the PLAIN (>200-char) dir finds NO owner (owner's real store dir is the truncated one) AND the guard's sdkEncodeDir check would also refuse.
- **Pinned to the SDK's real behaviour (not my reimplementation):** §3 drives a real `renameSession({dir: a >200-char cwd})` and asserts the title lands in exactly `sdkEncodeDir(cwd)` and no other dir is created (observed: a 207-char dir, the only dir). If a future SDK changes `Vl`, this test fails loudly rather than the guard silently addressing the wrong dir.
- **Changed (all unstaged; the user commits):** src/lib/session-history.ts, src/server/session-mutations.ts, src/server/index.ts, scripts/verify-bug-243-relocated-pin.mjs (+§3).
- **Verified (fixer's own run, necessary not sufficient):**
  - `npm run verify:bug-243` → **17/0**. New §3: precondition (plain 248 vs SDK 207, divergent); PIN (real renameSession lands in sdkEncodeDir, only dir); MUST-FAIL pre-fix (old plain invariant ACCEPTS; REAL SDK `deleteSession(address)` destroyed the same-id FOREIGN session in the truncated dir while the named file survived — the exact D2 data loss); AFTER (resolveSession refuses the long-hostPath case 409; a long-path session genuinely filed in the SDK-canonical dir still resolves).
  - Anti-regression: `verify-feat-155-workspace-root --no-live` → 60/0; `verify-bug-086-pin-style` → 12/12.
  - `npm run gate` → PASS (exit 0).
- **Deploy:** no build step (`node src/server/index.ts`); a service restart picks it up.
- **Independent clean-room re-verify WARRANTED** (data-loss class; same chokepoint). Exact command: `npm run verify:bug-243`. Attack suggestion: find any (address, dir) the guard ACCEPTS where the real SDK would resolve `dir` differently — e.g. the `CLAUDE_CODE_PROJECT_DIR_NAME` override, Windows/macOS case-folding, or realpath/symlink interplay before the SDK's own encode. A non-refusing cross-provider verifier is still desirable (round-1 openai content-filtered).
- **Symptom of a deeper design flaw?** yes — this is the lossy cwd→store-dir encoding reconstructed in multiple places, now flagged twice on this ticket. Recommend the orchestrator consider an ARCH ticket for "one SDK-dir-encoding authority" (sdkEncodeDir is the start; listing paths in session-history/sessionsForProject still use plain `encodeCwd` and would mis-locate a >200-char project's dir — a separate, listing-only gap left for that class, not fixed here).

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/opus run 922dad6a-6618-4c57-8516-b30e897a80b8 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — independent clean-room verify (verify lane, round 2, post-rework) — HOLDS
- **How:** `scripts/independent-verify.mjs --working-tree` (session-history.ts is now also an in-flight shared file — carries BUG-234 hunks — so again no clean `--candidate`/committed boundary; the room saw the whole dirty tree the fixer ran green). openai (Codex) REFUSED the turn AGAIN on the same "possible cybersecurity risk" content filter (not quota) — it refuses this attack content at the dispatch layer both rounds — so fell back to **anthropic/opus** (same-provider ⇒ decorrelation reduced; caveat below). Requirement in plain terms + 4-file diff + fixer test code; no fixer prose.
- **Fixer test re-run (clean room):** `npm run verify:bug-243` → **17/0** (manifest 06dcd57ee7b0, exit 0). New §3 reproduces the round-1 break: pre-fix the PLAIN-encoding invariant ACCEPTS the long-hostPath mutation and a REAL `deleteSession` destroyed the same-id FOREIGN session in the SDK's truncated dir (`foreignGone=true`); post-fix `resolveSession` REFUSES it 409, while a long-path session actually filed in the SDK-canonical dir DOES resolve. Anti-regression: feat-155 `--no-live` 60/0 (run 0c9d3317a8a7), bug-086 12/12 (run 7cbac7f54b3f).
- **Adversarial (verifier-authored fixture, run 1ef02a82adf3 / `sdk-encoder-shapes-and-long-path-delete`, exit 0, ALL PASS):** drove the **REAL SDK `renameSession` at 12 path shapes** — plain-encoding lengths 199/200/201/250, multibyte below/above 200, astral chars (incl. one straddling the 200 boundary), mixed CJK, two paths sharing a 200-char prefix, and a hash sign-handling case — and in every case the file landed in exactly `sdkEncodeDir(cwd)`. So `sdkEncodeDir` matches the SDK's real encoder byte-for-byte across shapes, not just one sample (attack (b) satisfied). Boundary verified: 200 not truncated, 201 truncated. Same-200-prefix paths resolve to DISTINCT dirs (told apart by the hash: `ppp-5gqp4i` vs `ppp-5gqp4j`); project A cannot mutate a session in B's hashed dir, and a forced same-prefix declaration is still refused (`sdkEncodeDir(A)!==dirB`). For every long/multibyte/astral shape: a mutation addressed via the PLAIN dir is refused 409, and a real delete of the session filed in the SDK dir removes exactly that file (attack (a) satisfied — the round-1 data-loss path is closed).
- **Two-break:** not triggered — nothing broke.
- **Could-not-test (verifier's list):** a full HTTP-server run of the long-path delete through the real `declaredStore` registry lookup (the lookup was modelled in-test, not driven over HTTP); the SDK's `CLAUDE_CODE_PROJECT_DIR_NAME` override, which replaces the SDK encoder entirely and `sdkEncodeDir` does NOT model (→ if that env is ever set, the mismatch could re-open — flag for the orchestrator); macOS NFC / Windows case-folding inside the SDK encoder (Linux only); the SDK's linked-git-worktree extra search dirs (searched only after the exact dir the guard requires); a registry hostPath with a trailing slash or `.` segments (`sdkEncodeDir` does not re-resolve the path, relying on createProject's `path.resolve`); last round's held properties re-confirmed only via the fixer §1/§2 + FEAT-155/BUG-086, not new cases.
- **Decorrelation caveat:** verifier was same-provider (anthropic) because openai's filter refused BOTH rounds; the SDK-match claim stands on executed evidence against the REAL SDK (run 1ef02a82adf3), not model judgement, so the reduced decorrelation is mitigated for the load-bearing property.
- **Separate listing-only gap (NOT this fix):** session-history listing / `sessionsForProject` still use plain `encodeCwd`, which would mis-locate a >200-char project's dir for LISTING (not mutation). Left for the "one SDK-dir-encoding authority" ARCH class the fixer flagged; out of scope for BUG-243's mutation guard.
- **Handoff:** BUG-243 fix HOLDS under independent clean-room re-verification. Verdict file: `~/.local/state/claude-station/scratch/bug243-verdict-r2-anthropic.txt`; run log `~/.local/state/claude-station/scratch/bug243-iv-r2-anthropic.log`.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
