```orchard-ticket
{
  "id": "ARCH-023",
  "type": "architecture",
  "title": "Push gate scans the working tree, not the objects git transmits",
  "summary": "The agent push gate scans the working tree and the staged index and treats that as what the push publishes. But git transmits commit objects and blobs addressed by content, including path names. Three secrets slip past: one living only in a file name, one inside a .png blob bytes, and one committed then deleted but still in history.",
  "impact_if_we_wait": "A granted agent can publish a secret to a remote while the push gate returns a clean PASS, so the gate core promise is unmet. Allowlist curation unblocks benign old hits but closes none of the three holes.",
  "current_need": "Build A: scan every object reachable from the pushed refs, with the allowlist staged in the same change so pushes are not blocked.",
  "severity": "high",
  "area": "leak-gate / git-grant / push",
  "reported": "2026-10-07",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-15",
  "decision": null,
  "decision_history": [
    {
      "id": "14209afd-4cfc-400d-817f-7e8cfb28930d",
      "asked_on": "2026-10-06",
      "question": "How should the push gate scope its scan of the objects a push transmits, given the host cannot trust its own view of the destination?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "C2"
      ],
      "chosen": "A",
      "chosen_on": "2026-10-14",
      "chosen_by": "agent",
      "note": "Decided by the agent (worker (BUG-259 fixing r1)), not by you — recommendation: Makes the push gate stricter, not looser; A is the only destination-independent option.",
      "owned": {
        "by": "worker (BUG-259 fixing r1)",
        "basis": "recommendation",
        "ref": null,
        "why": "Makes the push gate stricter, not looser; A is the only destination-independent option.",
        "on": "2026-10-14",
        "next": "Build A: scan every object reachable from the pushed refs, with the allowlist staged in the same change so pushes are not blocked.",
        "handoff": null,
        "prior": {
          "human_action": "decide",
          "work_state": "blocked",
          "current_need": "Decide how the push gate scopes a scan of the objects git actually transmits, including path names and binary bytes, given the host cannot trust its own computation of what the destination already has."
        }
      },
      "snapshot": {
        "id": "14209afd-4cfc-400d-817f-7e8cfb28930d",
        "mode": "single",
        "question": "How should the push gate scope its scan of the objects a push transmits, given the host cannot trust its own view of the destination?",
        "options": [
          {
            "key": "A",
            "label": "Scan all objects reachable from pushed refs",
            "what_changes": "Scan every commit, tree-entry name and blob reachable from the refs being pushed, plus binary bytes; do not subtract what the destination may already hold.",
            "benefit": "Destination-independent, so env/config cannot make it miss; closes all three breaks.",
            "cost": "Re-scans whole reachable history each push; benign old hits re-block until curated into the allowlist.",
            "why_not_obvious": "Less precise than a destination-aware diff, but precision there is exactly what the agent can subvert."
          },
          {
            "key": "B",
            "label": "Narrow to objects the destination lacks",
            "what_changes": "Compute the outgoing set relative to the remote via dry-run or ls-remote and scan only that.",
            "benefit": "Precise and fast; no re-block of old hits already on the remote.",
            "cost": "Round 2 proved it unsafe: env/config and multiple pushurls make the host resolve a different destination than the real push.",
            "why_not_obvious": "It looks like the right fix and the ticket first approved it, but it regresses push safety versus scanning everything."
          },
          {
            "key": "C",
            "label": "Enforce inside a forced pre-push hook",
            "what_changes": "The pre-push hook receives the real resolved refs and shas; scan those objects there, forcing the hook on.",
            "benefit": "Destination-aware and TOCTOU-free, because the hook receives the resolved destination, not the host.",
            "cost": "Agent bypasses via --no-verify or core.hooksPath; forcing it is the argv parser ARCH-021 rejects.",
            "why_not_obvious": "It is the only destination-truthful option, yet enforcing it recreates the shell/argv parser anti-pattern at a new layer."
          },
          {
            "key": "C2",
            "label": "Do nothing, keep scanning the working tree",
            "what_changes": "Leave the gate scanning working tree and staged index only.",
            "benefit": "No work; fast.",
            "cost": "All three breaks stay reachable: a secret in a path, in a .png, or in removed history still publishes.",
            "why_not_obvious": "The invariant is silently unmet; nothing fails loudly, which is how it has survived."
          }
        ],
        "recommendation": "A",
        "recommendation_reason": "A is the only destination-independent option, so it is the one the agent cannot subvert through env or config; it closes all three breaks and pairs with allowlist curation to unblock benign old hits.",
        "prerequisite": null
      }
    }
  ],
  "success_criteria": [
    "A secret present only in a file name within a pushed commit is blocked.",
    "A secret embedded in a .png blob in a pushed commit is blocked.",
    "A secret committed then deleted but still reachable from a pushed ref is blocked.",
    "Changing git env, repointing a remote, or adding a pushurl never turns a blocked push into a pass.",
    "A clean push to a repo of benign old hits is allowed once allowlisted, while reasonless entries and identity tokens stay refused."
  ],
  "code_refs": [
    {
      "path": "scripts/leak-gate.mjs",
      "note": "REPO/--changed/--staged scopes scan working-tree + index, never the pushed objects; needs a --push-objects scope over git rev-list --objects."
    },
    {
      "path": "src/server/runtime/claude-runtime.ts",
      "note": "runLeakGateForRepo push path keeps the conservative full-tree working-tree scan; it does not scan history objects, tree-entry names or binary bytes."
    },
    {
      "path": "scripts/lib/git-grant.mjs",
      "note": "selects commit vs push gate scope; the push branch is where a --push-objects scan would wire in."
    }
  ],
  "related": [
    {
      "id": "FEAT-169",
      "relation": "see_also"
    },
    {
      "id": "ARCH-021",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "FEAT-169"
  ],
  "verification": [],
  "verification_class": "arch",
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

# ARCH-023 — Push gate scans the working tree, not the objects git transmits

## Violated invariant

No secret reaches a remote through an agent push unscanned.

## The design that produces this class

The agent push gate scans the working tree and the staged index — the files on
disk right now — and treats that as a proxy for "what the push will publish." But
git does not transmit the working tree. It transmits commit objects and blobs,
addressed by content, and the tree entries that carry every path name. The
working tree is neither a subset nor a superset of that transmitted set, so a
scan of it can return a clean PASS while the push carries a secret the scan never
looked at. FEAT-169 corrected the COMMIT scope (scan the outgoing delta, not the
whole tree) and that part holds; it did not change the shape of the PUSH scan,
which is where this class lives.

## The three breaks (each a different way to publish a secret the working-tree scan never sees)

- **(a) A secret in a file NAME or path is never scanned.** The matcher reads
  blob bytes; a file whose secret lives only in its name has empty or benign
  bytes, and the tree entry that carries the name is never examined. Reproduced
  in FEAT-169 round 2 (a file named with a token has an empty blob).
- **(b) Secret bytes inside a .png (or any binary) blob are skipped.** The binary
  matcher only recognises KEY / PEM / assignment shapes, so a secret embedded in
  image bytes passes. Confirmed by the clean-room verifier (run
  01a1137f-1257-76b3-b091-9041aa52ace9) to reproduce under a full-tree scan.
- **(c) The scan covers the tree and index but NOT the git objects being pushed.**
  A secret that was committed and then removed from the working tree is gone from
  disk but still lives in the history the push transmits, so it gets published
  while the working-tree scan sees nothing.

All three pre-date FEAT-169 and each reproduces the same way under a full-tree
scan; they are not regressions of the `--changed` commit scope, which the
verifier confirmed picks the correct outgoing file set and falls back to a full
scan on every command it cannot classify.

## Design direction

Scan what git actually transmits — the outgoing commit objects and blobs,
*including the path names in tree entries*, and the raw bytes of binary blobs —
rather than the working tree. This closes (a) by scanning tree-entry names, (c)
by scanning history objects rather than disk, and (b) by byte-scanning binary
blobs.

## Known constraint (FEAT-169 round 2, run 01a11377-fee6-7a82-9ebc-4d6c3267b37a)

The appealing refinement — scan only the objects the destination does NOT already
have — requires the host to compute the destination's existing commit set, and
that computation can be subverted by the agent, which controls its own process.
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*`, `GIT_DIR`, a writable repo config,
`insteadOf`, multiple `remote.<r>.pushurl` destinations, and repointed
remote-tracking refs all let identical argv resolve to a different destination
for the agent's real push than for the host's recomputation, so the host's view
of "already has" is not trustworthy. A dry-run to learn the destination is worse:
it executes the repo's pre-push hook (an LFS hook would upload payloads during
planning). So any narrowing that depends on the destination set is destination-
blind in a way the agent can exploit to turn a wrong PASS into a published secret.

## Decision — how should the push gate scope its scan of the transmitted objects?

- **A — scan all objects reachable from the pushed refs.** Scan every commit,
  tree-entry name and blob (plus binary bytes) reachable from the refs being
  pushed, without subtracting what the destination may hold.
  Destination-independent, so env/config cannot make it miss, and it closes all
  three breaks; it re-scans the whole reachable history each push and re-blocks
  benign old hits until they are curated into `.leakgate-allow`.
- **B — narrow to the objects the destination lacks.** Compute the outgoing set
  relative to the remote (dry-run / `ls-remote`) and scan only that. Precise and
  fast, but round 2 proved it unsafe: env/config and multiple pushurls make the
  host resolve a different destination than the real push, and a dry-run runs the
  pre-push hook.
- **C — enforce inside a forced in-process pre-push hook.** Git hands a pre-push
  hook the real resolved refs and shas, so it is destination-aware and
  TOCTOU-free; but the agent bypasses it with `--no-verify` / `core.hooksPath`,
  and forcing the hook on recreates the shell/argv text-parser anti-pattern
  ARCH-021 rejects, at a new layer.
- **C2 — do nothing / keep scanning the working tree.** No work, but all three
  breaks stay reachable and the invariant is silently unmet — which is how it has
  survived this long.

Recommended: A. It is the only destination-independent option, so it is the one
the agent cannot subvert through env or config; it closes all three breaks and
pairs with allowlist curation (identity tokens staying non-waivable) to unblock
the benign old hits that motivated FEAT-169.

## Migration path

1. Add a `--push-objects` scope to the leak gate that enumerates objects
   reachable from the local push tips (`git rev-list --objects <tips>`), scans
   each blob's bytes (binary included via the byte matcher), scans each
   tree-entry path name, and scans each commit/tag message and identity. Landable
   and testable against a scratch repo on its own.
2. Wire the agent push path (`runLeakGateForRepo` / git-grant) to run
   `--push-objects` for a push, keeping the conservative all-reachable set; the
   commit path keeps FEAT-169's `--changed` scope unchanged.
3. Ship an allowlist-curation helper that emits a reviewable draft
   `.leakgate-allow` from a repo's current benign hits for the user to approve, so
   the full-reachable scan does not strand real projects on old hits.

Throughout, the dashboard commit gate and this repo's own `npm run gate`
full-tree scan stay exactly as they are; rollback is reverting the new scope,
which leaves today's working-tree push scan in place.

## Proof bar — what would have to be true to call the new design right

- A secret present ONLY in a file name within a pushed commit is BLOCKED (break a).
- A secret embedded in a .png blob in a pushed commit is BLOCKED (break b).
- A secret committed and then deleted from the working tree, still reachable from
  a pushed ref, is BLOCKED (break c) — a working-tree scan passes this case, so a
  test that could only pass post-redesign.
- Changing `GIT_CONFIG_*` / repointing a remote / adding a second pushurl does not
  turn any of the above into a PASS (destination-independence).
- A clean push to a repo full of benign old hits is ALLOWED once they are in
  `.leakgate-allow`, and the allowlist still refuses a reasonless entry and never
  waives identity tokens (FEAT-156).

Falsifier: if a realistic repo's all-reachable scan is so slow or so noisy that
the user turns the gate off, option A is the wrong call and B/C's precision was
worth its risk.

## Decision record (filled in once an option above is chosen)

- **Chosen option:** —
- **Explicitly rejected:** —

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-06 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-06 — redesign filing (FEAT-169 handoff)
- **Decision declared:** How should the push gate scope its scan of the objects a push transmits, given the host cannot trust its own view of the destination? Options: A — Scan all objects reachable from pushed refs; B — Narrow to objects the destination lacks; C — Enforce inside a forced pre-push hook; C2 — Do nothing, keep scanning the working tree. Recommended: A — A is the only destination-independent option, so it is the one the agent cannot subvert through env or config; it closes all three breaks and pairs with allowlist curation to unblock benign old hits. Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Decided by agent (own):** Decided by the agent, not by you. Basis: recommendation. Chose: A. Why: Makes the push gate stricter, not looser; A is the only destination-independent option. Next: Build A: scan every object reachable from the pushed refs, with the allowlist staged in the same change so pushes are not blocked. You can reopen this decision from the ticket view.

### 2026-10-15 — worker (plan+review, dispatched from FEAT-190 r11) — NEW EVIDENCE: option A is unworkable for Orchard; decision needs reopening
- **This is the home of the FEAT-190 r11 IV finding.** FEAT-190's clean-room IV (runs cf10f5cb / 40ea8f5b / 8d65234c) re-surfaced break (c): on a push the gate scans the WORKING TREE + staged index (`runLeakGateForRepoAsync` → `leak-gate.mjs --summary` + `--staged`), never the pushed commits, so a leak only in history / on a non-checked-out branch / in a commit message / in author-committer identity publishes unscanned. This is ARCH-023, not a new bug, and it PREDATES FEAT-190: at committed HEAD (`ed92aff`, the batch that landed this ticket's filing) the push path already used the working-tree scan; `leak-gate.mjs:136` documents it ("PUSH keeps the full-tree scan"). FEAT-190's uncommitted work is grant policy/UI, orthogonal to gate scope. Recorded likewise on FEAT-190.
- **Measured on the real repo (not a fixture) — option A (chosen) is UNWORKABLE for Orchard itself:** reachable history = 66 commits / 4535 objects; it carries 210 `/home/...` occurrences in old diffs AND the owner's real private email as the author/committer IDENTITY of 2 already-published commits. Identity tokens are NON-WAIVABLE (FEAT-156) — cannot go in `.leakgate-allow`. So "scan every object reachable from the pushed refs" would hit those 2 commits and REFUSE every Orchard push forever, with no allowlist escape. The ticket's own falsifier ("if a realistic repo's all-reachable scan is so noisy the user turns the gate off, A is the wrong call") FIRES here. By contrast the current 7-commit outgoing range (origin/main..HEAD) is clean (noreply identity, no leak in diffs/messages), so an outgoing-only scan passes.
- **But the obvious outgoing scope (`--not --remotes`) is exactly the forgeable option B this ticket rejected:** remote-tracking refs are agent-writable local refs → false-empty range → leak slips. So neither the recorded A nor a naive B is shippable.
- **Independent plan review (fresh-context Anthropic, skeptic) verdict: REVISE.** A viable "outgoing set against a NON-FORGEABLE host-computed baseline" exists but needs real infrastructure, each a blocker: (1) the grant binding stores a lossy normalized `networkKey`, NOT a fetchable URL — needs a new raw-URL field recorded at grant time + migration/re-grant; (2) make-or-break: a host `ls-remote` is config-forgeable via the repo's own `.git/config` (`insteadOf`/`sshCommand`/`http.proxy`/`credential.helper`/`url.*`) even with a scrubbed ENV — it must run OUTSIDE the repo with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` + protocol allowlist, consulting zero agent-controlled config, else B's hole reopens; (3) baseline must target the SPECIFIC authorized push destination (grants can bind >1), not "the" remote; (4) scope must be an all-refs superset (never let argv narrow — ARCH-021) plus a gate↔push ref-repoint TOCTOU binding the existing BUG-249 fingerprint does NOT cover (it checks index+worktree, not the commit graph/ref targets); the pushed-object-reachable-from-no-ref dangling-object case stays an accepted residual only A/C see. (5) baseline-uncomputable → fail-closed REFUSE ("refuse-only-new" is incoherent without a baseline); surfaces a credential/offline caveat for private remotes (host needs creds to `ls-remote`, else pushes get brittle). `ls-remote` (unlike a push dry-run) runs NO repo pre-push hook, so the LFS objection to B does not apply to a plain ls-remote.
- **RECOMMENDATION — reopen this decision.** The recorded choice A should be revisited with the new self-block evidence. Candidate replacement: "scan the OUTGOING set (identity + message + diff/bytes) against a host-computed, config-neutralized, per-destination baseline; fail-closed refuse when the baseline can't be computed" — strictly better than A for real repos, but it reverses a recorded decision AND adds grant-binding infrastructure + a credential story, so it is a user/orchestrator-owned decision, not a round-1 build. A reviewer-proposed hybrid (scan-all per A, but apply the non-waivable identity rule only to the OUTGOING delta) was examined and does NOT escape blocker #2: its downgrade step still needs a non-forgeable "already-published" proof, so a forged-larger baseline could still hide a new identity leak.
- **NOT fixed this round.** No code changed for this ticket. Every path is disqualified for an immediate build: A self-blocks Orchard, naive B is forgeable, the viable path reverses a settled decision and needs new infrastructure. Held for the reopened decision.
