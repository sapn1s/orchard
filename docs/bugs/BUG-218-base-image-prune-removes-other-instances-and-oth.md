```orchard-ticket
{
  "id": "BUG-218",
  "type": "bug",
  "title": "base-image prune removes other instances' and other uids' station images",
  "summary": "When a server builds a new base image, it deletes every other claude-station-base tag no container uses. That includes another Orchard instance's tags, another user's, and a tag a concurrent lane has just built. A scratch server started by a test on the host daemon can therefore delete the live instance's base images.",
  "impact_if_we_wait": "A test run or a second instance on the same host can silently delete the live instance's base images. The next start then rebuilds them, which takes minutes, or fails when offline.",
  "current_need": "Awaiting an Orchard restart to deploy the fix. The base-image ownership model (instance/data-dir owner key) was decided and applied; ARCH-022 tracks the structural single-owner redesign.",
  "severity": "medium",
  "area": "container images",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a server building a base image never removes a tag another instance or uid depends on",
    "the chosen ownership model is covered by a test that plants another instance's tag and survives a build"
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts"
    }
  ],
  "related": [
    {
      "id": "FEAT-158",
      "relation": "see_also"
    },
    {
      "id": "BUG-216",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-218 — base-image prune removes other instances' and other uids' station images

## Problem

When an Orchard server builds a new station base image, `flushPrune()` runs `pruneSupersededImages()` (`src/server/container-manager.ts`). It removes every `claude-station-base:` tag matching `^u\d+-g\d+(-hash)?$` that no container currently uses. That covers other uids' tags (`u1001-g1001-*`), the tag another Orchard instance on the same daemon uses, and a tag another lane has just built but not yet started. The owner-key rule from BUG-216 does not apply here: base images carry no owner label, and the prune does not filter by one.

## Evidence

A FEAT-158 round-3 clean-room attacker (run `f7d8d9c7-238e-429c-888a-e404b600d37f`, property d) ran `verify-container.mjs` against a decoy host daemon, before any FEAT-158 fix, and with a tree whose base-image hash had no image yet. Its scratch server logged `reclaimed superseded image(s): claude-station-base:u1000-g1000-cccccccccccc, claude-station-base:u1001-g1001-bbbbbbbbbbbb, claude-station-base:u1000-g1000-aaaaaaaaaaaa`, and all three planted tags were gone. The evidence is in the FEAT-158 attack dir, `att/d/ev-r3/`.

Any test whose scratch server builds a base image on the host daemon can trigger this: verify-container, the feat-155 station-image suites, verify-bug-157, verify-browser and others. So can a second real Orchard instance on the same host.

## Decision needed

Base images are, by design, a cache shared by every instance on the host. Scoping the prune by owner changes that design, so this is an architecture question and not a one-line fix. The options:
- (a) Label base images with the creating instance's owner key, and prune only those.
- (b) Prune only this uid/gid's tags that are older than the kept one.
- (c) Keep the shared-cache prune, and require every test that builds a base image to run in the FEAT-158 sandbox (guarded).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — worker
- **fixing, round 1 (CHECKPOINTED for restart):** - **Decision applied (orchestrator):** base images are owned by the instance (data dir) that built them; the owner key is `instance-owner.ts` `ownerKey()` (the one authority).
  - **Fix (built, verified, then REVERTED from the tree for the restart; WIP saved):** the base build stamps `claude-station.owner`; `pruneSupersededImages` removes only superseded base tags whose image carries THIS key, by the inspected image id (never by tag, never `--force`); foreign and other-uid images are kept; unlabelled (legacy) ones are kept and reported in the ensure log. Clean-room p2 found that the shared tag itself was the leak: `docker build -t <shared tag>` (a Rebuild, or two instances building the same missing base) re-pointed the tag and, on the containerd image store, deleted the other instance's (or a legacy) image even under a running container. Fixed: the base builds to a private staging tag and the shared tag is pointed at it only if it is free or own; a concurrent build that got there first wins; a Rebuild over a foreign tag (or, on an isolated instance, an unlabelled one) refuses before building. The shared (non-isolated) instance may still Rebuild over an unlabelled tag (FEAT-158 `mayActOn`) — **decision for the orchestrator**: keep that (the live server can Rebuild its own legacy base) or refuse it too (strict "unlabelled never removed").
  - **Must-FAIL:** suite `verify-bug-214-218-base-lifecycle.mjs` (FEAT-158 sandbox, scratch image repo via shim; a base build is replaced by a `FROM <seed>` build keeping the product's real `--label` argv), pinned pre-fix snapshot `scratch/bug214-218/prefix/`: B1/B3/B4/B5/B6/B9/B10/B11/B12 FAIL pre-fix (the planted foreign, other-uid and unlabelled tags all deleted); fixed tree 25/25 overall.
  - **Anti-regressions:** see BUG-214 (same run): bug-107 23/23 (its prune F1/F2 included), bug-216 23/23. `npm run gate` exit 0 on the fixed tree and on the restored tree.
  - **Clean room round 1:** property (2) run `09d23339-927e-4a86-9afc-920fbd711897` **BROKEN** on the shared-tag build path (fixed after; not yet re-attacked). Held: own reclaimed; foreign/other-uid/unlabelled kept and reported; odd labels (empty, whitespace, `<no value>`, trailing space, case); data-dir aliases; non-vacuity on the pre-fix room (17 tags deleted). No Verified-by yet.
  - **Residual (SAFE-FAIL, not fixed):** an own superseded image that carries a second tag is never reclaimed (removal by id is refused); `ownerKey()` could differ before/after the data dir exists when its parent is a symlink (the server creates the dir at boot); the absent-tag check and `docker tag` are two calls (ms window, no conditional tag in docker).
  - **WIP:** `~/.local/state/claude-station/scratch/bug214-218/wip/`. **Left:** re-apply, re-attack property (2), Verified-by.
  - regressed-from: none (the tag-shape prune predates owner labels, BUG-107).

### 2026-09-30 — worker
- **fixing, rounds 2-3 (CHECKPOINTED again for restart):** - **Decision recorded (orchestrator, accepted):** the shared (live) instance may Rebuild over its own unlabelled legacy base (`mayActOn`); isolated instances may not.
  - **Round 2 (q2, run `e35e23ae-a82c-4273-8bda-d430b3bfca14`, BROKEN), fixed:** (c) a label-less image under the tag made `docker inspect {{index .Config.Labels …}}` fail, read as "absent", and the build re-pointed over it — ownership now reads `{{json .Config}}` (absent only on "No such image"; any other failure = not ours), also in the prune, which now reports label-less images as unlabelled; (d) an image pre-planted under the staging name — staging tags carry a per-build random nonce; (e) two builds finishing together (BuildKit merges them) both tagged — the shared tag is now re-pointed under a daemon-wide mutex (a never-started container `orchard-basetag-lock-<hash>`, atomic by name, holding the built image; 2-minute staleness).
  - **Round 3 (s2, run `a745d037-5c30-4e5f-9f37-bbfd98d3df87`): HOLDS** — only SAFE-FAIL: a dead build's staging tag leaked, and stale-lock age used the client clock. Both fixed after: the prune reclaims this instance's own `build-<key>-…` tags not in flight in this process; lock age uses the daemon's `SystemTime`.
  - **Suite:** B14 (label-less), B15 (3 simultaneous-build races: exactly one tag write each, no lock left), B16 (own dead staging reclaimed, another's kept) added; fixed 33/33; pre-fix fails B1,B3-B6,B9-B15.
  - **Round 4** (t2, property 2 on the round-3 deltas) was **killed at this checkpoint**; no run id emitted.
  - **Verified-by (provisional):** round 3 `a745d037-5c30-4e5f-9f37-bbfd98d3df87` HOLDS (SAFE-FAIL only, since fixed); the small post-round-3 changes (own-staging reclaim, daemon-clock lock age) are not yet re-attacked.
  - **WIP:** see BUG-214 entry (`scratch/bug214-218/wip/`). Tree restored; gate exit 0.

### 2026-09-30 — worker
- **verifying, round 4 — VERIFIED (clean room HOLDS):** - **Round 4 (u2, run `17362c57-c2a8-40d6-99b2-d375189f3d75`): HOLDS** on the full base-ownership code (staging build + tag mutex + JSON label read + own-staging reclaim + daemon-clock lock age): no instance removed, untagged or re-pointed another instance's or an unlabelled base; non-vacuous against the pre-fix code (it removed foreign, other-uid and unlabelled tags).
  - Noted by round 4, accepted: "shared" = `CLAUDE_STATION_DATA` unset (`mayActOn`, FEAT-158), so a second server with no `CLAUDE_STATION_DATA` but a moved HOME/XDG data dir also counts as shared and may Rebuild over an unlabelled base — matches the accepted decision's wording, not its reason (the live server); flagged for the orchestrator. SAFE-FAIL: a second process on the SAME data dir may reclaim the first's in-flight staging tag (its build then fails); a hostile re-point of our staging tag fails our build.
  - **After round 4** only one base-image change landed: the prune stays armed while an own superseded image is still in use by a container (it retries later; still own-only, by id, no --force). Not re-attacked separately; property-1 round 9 (`dcfa6307-…`) exercised base prunes through its runs and held.
  - **Suite:** B0-B16 in `verify-bug-214-218-base-lifecycle.mjs`, all PASS on the fixed tree; pre-fix fails B1, B3-B6, B9-B15. Gate exit 0.
  - **Verified-by:** dispatch anthropic claude-opus-5-5 run `17362c57-c2a8-40d6-99b2-d375189f3d75` (round 4, HOLDS); earlier rounds `09d23339-…` (r1 BROKEN), `e35e23ae-…` (r2 BROKEN), `a745d037-…` (r3 HOLDS, SAFE-FAIL fixed).
  - Needs an Orchard restart to deploy (with BUG-214).

### 2026-09-30 — worker
- **verifying, round 10 — board record set to VERIFIED:** Board round 10 (record-field fix). The base-ownership fix code is intact in the tree after the FEAT-157 strip (owner-stamped base builds, staging-tag + daemon-wide tag mutex, JSON label read, own-only prune by id in container-manager.ts). Root cause of the OPEN/Verified-by:none reading: the round-4 line wrote "dispatch anthropic claude-opus-5-5 run ..." with a SPACE, but VERIFIED_BY_RE requires "dispatch anthropic/<model> run ...", so board:status counted no Verified-by and work_state stayed open. Re-ran scripts/verify-bug-214-218-base-lifecycle.mjs in the FEAT-158 sandbox under its lock: 37/37 (B0-B16 all PASS) after re-applying the one suite adaptation FEAT-157 had made and the strip removed — seedId() seeds from a legacy hashed base (no owner label) so the planted "unlabelled" bases stay genuinely unlabelled and the unlabelled-report path (B6) is exercised. No src/ edit. Verified-by: dispatch anthropic/claude-opus-5-5 run 17362c57-c2a8-40d6-99b2-d375189f3d75 — VERDICT: HOLDS (round 4).

### 2026-09-30 — worker
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run 17362c57-c2a8-40d6-99b2-d375189f3d75 — VERDICT: HOLDS (round 4). Machine-readable form of the round-4 verdict (the earlier line used a space, not a slash, so VERIFIED_BY_RE did not match).
