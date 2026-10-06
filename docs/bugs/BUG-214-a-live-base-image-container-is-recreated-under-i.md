```orchard-ticket
{
  "id": "BUG-214",
  "type": "bug",
  "title": "a live base-image container is recreated under its running session",
  "summary": "A project that runs Orchard’s base image directly has a live session. When the base definition changes and a second session launches, the first session’s running container is removed and recreated underneath it, killing its work — because the image-swap defer that protects Dockerfile projects is gated on `locked` and a base-direct project is not locked.",
  "impact_if_we_wait": "Every base or security rebuild can destroy live work in any of the projects that run the base directly (5 of 6 container projects on this machine) the next time a second session launches.",
  "current_need": "Awaiting an Orchard restart to deploy the fix. ARCH-022 tracks the structural single-owner redesign.",
  "severity": "high",
  "area": "container image lifecycle",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a base-direct project with a live running session keeps its container when the base changes and a second session launches",
    "the new base applies only at the next launch with no live session, never under one",
    "must-FAIL proven against the pre-fix code at a fixed commit (a977e76), not HEAD",
    "the Dockerfile-project defer (FEAT-155) and the lockdown defer still hold",
    "anti-regressions: verify-feat-155-*, verify-bug-157-*, verify-bug-107-image-staleness, npm run gate"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-022",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-157",
      "relation": "see_also"
    },
    {
      "id": "BUG-157",
      "relation": "see_also"
    },
    {
      "id": "FEAT-155",
      "relation": "see_also"
    },
    {
      "id": "ARCH-020",
      "relation": "see_also"
    },
    {
      "id": "FEAT-151",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
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

# BUG-214 — a live base-image container is recreated under its running session

## Symptom
A container project that runs Orchard's base image **directly** (no project Dockerfile) has a live session open. Orchard's base definition changes — a new base is built, or the same tag is rebuilt with fresh bytes. The moment a **second** session launches in that project, the first session's container is **removed and recreated underneath it**, killing the running work inside it. This is the BUG-157 data-loss class (never destroy live work), reached through a different door.

FEAT-151's promise that "a base bump never force-restarts a running container" holds only until the next launch in that project.

## Root cause
In `src/server/container-manager.ts`, `doEnsure` defers an image-only swap when other sessions are live — but only for a **locked** project:

```
if (locked && opts.deferImageSwap && live.running && reasons.length && reasons.every((r) => r.startsWith('image '))) { ...defer... }
```

`locked = keepsLastGood(project) = (imageSourceOf(project) === 'dockerfile')`. A base-direct project is `station`, not `dockerfile`, so `locked` is `false` and this guard is skipped. Nothing else catches an `image `-prefixed drift for a station project, so control falls through to `removeContainer(name)` + recreate — under the live session.

The launch path does pass `deferImageSwap: true` correctly (`src/server/agent-bridge.ts`: `deferImageSwap: liveSessionsForProject(opts.project.id).length > 0`); the value is simply ignored on this branch because of the extra `locked &&`.

The sibling defer branch immediately below (the one-time run-time lockdown upgrade, ~L2089) carries **no** `locked` requirement, which is exactly why a station project's lockdown drift is deferred correctly while its image drift is not. The `locked &&` on the image branch is the whole defect.

## Evidence — reproduced empirically (real container-manager + real docker)
`scripts/verify-feat-157-base-recreate-under-live.mjs` (7/7 PASS). It runs against a **copied** tree with a `CLAUDE_STATION_DOCKER` shim that rewrites `claude-station-base` to a per-run scratch repo, so the user's real base images and containers are never touched or built over; the base image is seeded by retagging an existing base id (no multi-minute build). Every container/image it makes is removed by name in cleanup.

- A base-direct (station) project is created with a live, running container (session 1).
- `provision.json` is bumped in the scratch tree — real base drift; the wanted tag moves `…-bcf637b5beca` -> `…-eaf1eefc3752`.
- A second launch runs `ensureContainer(project, { deferImageSwap: true })`.
- **Result:** the live container is recreated under the running session — docker container id `1eb279fe913e` -> `bcecd1a1a829`, while session 1 read `running=true` before the second launch. Log line: `[container] recreating … : image …bcf637b5beca != …eaf1eefc3752`.
- **Control (same project, same `deferImageSwap: true`):** with a lockdown-ONLY drift the same base-direct container is KEPT (id unchanged) — proving the defer plumbing works for station projects, and the recreate happens purely because the image branch adds `locked &&`.

## Fix design (do NOT build yet — queued behind ARCH-020, same file)
Extend the image-swap defer to station projects: the `image `-only defer must apply whenever `deferImageSwap && live.running` and every reason is an image change, regardless of `locked` — the same rule already used by the lockdown branch. A station project then keeps its running container and the new base applies at the next launch with no live session (or on Rebuild), exactly as a Dockerfile project already does. This is the same change FEAT-157's Adopt semantics call for ("extending deferImageSwap to station projects, which also closes gap (b)2 for pinned projects").

Care points carried from the FEAT-157 plan review (disposition item 3): the defer decision is sampled before an async build and concurrent launches share one ensure; the durable fix belongs under one project-lifecycle lock with liveness re-checked immediately before any destructive container op. The build lane should land this together with FEAT-157 rather than as an isolated patch, since both edit `doEnsure`.

Because a base-direct project is not `keepsLastGood`, it has no `-next` swap and no last-good fallback; a naive defer removal alone would still recreate on the FIRST launch after a base change when NO session is live — which is the intended moment — so the fix is specifically about the case where a session IS live.

## Verification plan
- Must-FAIL against the pre-fix code (anchor to a fixed commit such as a977e76, not HEAD): the probe above reproduces the recreate-under-live.
- After the fix: same scenario keeps the live container (id unchanged) and the new base applies at the next idle launch; the existing Dockerfile-project defer (FEAT-155) and lockdown defer still pass.
- Anti-regressions: `verify-feat-155-*`, `verify-bug-157-*`, `verify-bug-107-image-staleness`, FEAT-151 container-pin checks, `npm run gate`.
- High-stakes (session lifecycle / data-loss): independent cross-provider clean-room verify before VERIFIED.

## Symptom of a deeper design flaw?
Partly — it is the same "defer honoured for one image source but not another" gap FEAT-155 round 7 already patched once for lockdown drift. The durable answer is FEAT-157's single project-lifecycle lock over admission + destructive ops; tracked there, not as a new ARCH.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — worker
- **fixing, round 1 (CHECKPOINTED for restart):** - **Hypothesis confirmed first:** on the current tree (ARCH-020 + BUG-216), in the FEAT-158 sandbox, a base-direct container under a live session is recreated on a base change (my suite, pre-fix: S1/S2/S3/S5/S6 FAIL; the old probe cannot run in the sandbox: GPU auto).
  - **Fix (built, verified, then REVERTED from the tree for the restart; WIP saved):** `doEnsure` defers an image swap for EVERY image source (dropped `locked &&`); image + lockdown reasons together defer too; `deferImageSwap` may be a function, read at the decision point (no await before the removal), and the launch path passes `() => liveSessionsForProject(id).length > 0`; a throwing probe counts as live. Clean-room p1 found two older entry points (not regressions of this fix): Rebuild removed a container that gained a session during the build, and `POST /container/start` used a 1.5 s cached guard then ensured without the defer. Both fixed: `rebuildContainer` re-reads liveness after the build (route passes the probe unless `?force=1` over live sessions), `/start` passes the probe; a deferred ensure keeps the base prune armed.
  - **Must-FAIL:** new suite `verify-bug-214-218-base-lifecycle.mjs` (FEAT-158 sandbox, guard + lock, scratch image repo via shim), against a pinned pre-fix snapshot `scratch/bug214-218/prefix/` (sha256 list in `prefix.sha256`, not HEAD): **9/25 PASS, 16 FAIL**; fixed tree **25/25**.
  - **Anti-regressions (sandbox, GPU hidden via bwrap, scratch HOME):** bug-107 23/23, bug-216 23/23, feat-155-image-env-policy 15/15, bug-157-proc-classify 15/15. Environment-limited (same on the pre-fix copy or a known sandbox limit, not counted): bug-157-container-scripted-kill 4/6 (identical 4/6 on pre-fix), feat-155-dockerfile 22/43 and feat-155-prebuilt-lockdown (host /proc uid read), feat-155-workspace-root 74/80 (sandbox cannot see ~/.claude/projects). Not run: bug-157-container-close-live-work and woken-turn (exceed the 10-min foreground cap), verify-container.
  - **Clean room round 1 (anthropic claude-opus-5-5, jailed, shared sandbox only):** property (1) run `07d3ef98-86e8-4374-809d-3c380a017a76` **BROKEN** on the two older entry points above (fixed after; not yet re-attacked). No Verified-by yet.
  - **Incident (mine):** a suite killed by `timeout` left its scratch server (pid 2512719, port 43327, scratch data dir) holding the sandbox lock ~20 min; killed by pid. Also my first suite cleanup `rmi -f <id>` deleted the sandbox preloaded base; restored with `sandbox:docker up` and fixed (untag by name).
  - **Concurrent edit:** FEAT-158 changed `refuseForeign` in container-manager.ts (mayActOn) during this lane; the restore kept it.
  - **WIP:** `~/.local/state/claude-station/scratch/bug214-218/wip/` (README; `mine-*.patch` = this lane only; `full/` incl. the suite). **Left:** re-apply, re-attack property (1) on the fixed entry points, then Verified-by. Needs an independent re-attack (session-lifecycle harm class).
  - regressed-from: none (the `locked &&` gate predates this board entry; FEAT-155 round 7 fixed the lockdown half only).

### 2026-09-30 — worker
- **fixing, rounds 2-3 (CHECKPOINTED again for restart):** - **Re-applied** round-1 WIP on top of FEAT-158 round 8 / BUG-215 / BUG-217 edits (no conflicts), then fixed each clean-room break (all in `container-manager.ts` + the `/container/start|rebuild` routes in `index.ts`):
    - round 2 (q1, run `94d6d461-1efd-45ac-86f9-cc293ab7952c`, BROKEN): `/start` treated a stale-cache unforced request as forced; a Rebuild ensured with the route's stale project snapshot after a session went live; `/start` with a stale cache and NON-image drift recreated. Fixed: "forced" = `?force=1` with sessions live at request time; an unforced Start passes `deferImageSwap` + new `refuseDestroyIfLive` (image-only defers, anything else 409 `live-sessions`); Rebuild leaves a container that went live during the build untouched.
    - round 3 (s1, run `ac62779a-31c1-44ee-9e59-04c51ef1b698`, BROKEN): Rebuild's `docker rm` ran outside the per-project in-flight ensure, so a launch during the rm registered on the dying container. Fixed: Rebuild re-reads the project (`current`) and does remove+recreate INSIDE `ensureContainer({forceRecreate, deferImageSwap, refuseDestroyIfLive})`, which a concurrent launch joins; `doEnsure` honours `forceRecreate` for every kind.
  - **Suite** `verify-bug-214-218-base-lifecycle.mjs` now 33 checks: fixed tree **33/33**; pinned pre-fix snapshot **10/31 at the 31-check stage (21 FAIL)**; S11 (launch during Rebuild rm) proven non-vacuous on a constructed variant with only the round-3 change reverted (FAIL there, PASS fixed).
  - **Anti-regressions (sandbox, GPU hidden, scratch HOME):** bug-107 23/23, bug-216 23/23, feat-155-image-env-policy 15/15, bug-157-proc-classify 15/15, bug-157-container-scripted-kill 4/6 (identical on pre-fix; environmental).
  - **Round 4** (t1, property 1, re-attacking the round-3 fix) was running and was **killed at this checkpoint** (process group); no run id was emitted. Its sandbox leftovers (1 container, 1 private tag) were removed by id/name under the sandbox guard; lock confirmed free.
  - **No Verified-by yet** for property 1. **WIP:** `~/.local/state/claude-station/scratch/bug214-218/wip/` (README; `mine-*.patch` this lane only; `full/`); previous WIP kept as `wip-checkpoint1/`. Tree restored minus only this lane's hunks; `npm run gate` exit 0.
  - **Left:** re-apply, re-run round 4 for property 1 (and property 2 on the round-3 deltas), record Verified-by.

### 2026-09-30 — worker
- **fixing + verifying, rounds 4-9 — VERIFIED (clean room HOLDS):** - **Re-applied** the checkpoint-2 WIP on the current tree (other lanes' edits kept); suite 33/33, gate 0.
  - **Clean-room rounds (anthropic claude-opus-5-5, jailed, shared FEAT-158 sandbox under its lock, one per property):** r4 `869bdc30-478b-4966-a8bd-0935cff862b0` BROKEN (forced Rebuild passed no probe; Stop/Remove had the launch-during-rm race) → forced routes now exclude only request-time sessions, Stop/Remove run as an exclusive per-project op a launch waits behind; r5 `1710f4d1-a1c3-427d-8582-b2e7624a5515` BROKEN (Stop/Remove/DELETE that waited for a launch did not re-check) → liveness re-read after the wait, 409; r6 `ca4572d0-7de7-4630-b549-25661a7995d7` BROKEN (project `<X>-next` collided with X's swap name; a queued op re-checked one microtask early) → swap name `<name>.next` + project-label check on recovery, macrotask yield before the re-check; r7 `7443a0a9-b492-455c-9202-c464533b250f` BROKEN (DELETE waiting on a build lock deleted a project that gained a session; orphan sweep then removed it) → DELETE re-checks before deleting the row, the orphan sweep treats live-session projects as known, a Rebuild of a deleted project recreates nothing; r8 `a4b89782-404e-4f56-ba65-79b2dc067e59` BROKEN, HOSTILE (an image label `claude-station.role=service` inherited by the session container, removed by ensureServices) → session containers declare `claude-station.role=session`; r9 `dcfa6307-4530-4bb9-ba79-49506e239d24` **HOLDS** (re-ran a–n with non-vacuity against three reverted variants).
  - **Suite** `scripts/verify-bug-214-218-base-lifecycle.mjs`: 37 checks; fixed **37/37**; pinned pre-fix snapshot **9/37 (28 FAIL)**; each round-4..8 check (S11-S15) also FAILs on a constructed variant with only that fix reverted.
  - **Anti-regressions (sandbox):** bug-107 23/23, bug-216 23/23, feat-155-image-env-policy 15/15, bug-157-proc-classify 15/15, feat-112-services 17/17; bug-157-container-scripted-kill 4/6 identical to pre-fix (environmental). Not runnable in the sandbox: feat-155-dockerfile/prebuilt-lockdown (host /proc), workspace-root (~/.claude not visible), bug-157 close-live-work/woken (>10 min). `npm run gate` exit 0.
  - **Verified-by:** dispatch anthropic claude-opus-5-5 run `dcfa6307-4530-4bb9-ba79-49506e239d24` (round 9, HOLDS).
  - **Residual (outside the property, not fixed):** two server processes on ONE data dir each see only their own sessions (the ownership model says one server per data dir; unenforced); a Stop's / 409-DELETE's service teardown can remove sidecars/volumes of a launch that queued behind it; a Rebuild that joins a launch's in-flight ensure loses forceRecreate (SAFE-FAIL). Dockerfile-project builds could not run in the sandbox; attackers seeded df images with the product's labels.
  - **Changed (uncommitted):** `src/server/container-manager.ts`, `src/server/index.ts` (container start/stop/remove/rebuild routes, project DELETE, orphans), `src/server/agent-bridge.ts` (one line), `scripts/verify-bug-214-218-base-lifecycle.mjs` (new). Needs an Orchard restart to deploy.
  - regressed-from: none.

### 2026-09-30 — worker
- **Note:** Linked as recurrence evidence of ARCH-022 (container lifecycle has no single owner). Its 8 clean-room breaks, each through a different entry point, are the two-break trigger of the amended WA §N.

### 2026-09-30 — worker
- **verifying, round 10 — board record set to VERIFIED:** Board round 10 (record-field fix). The fix code is intact in the tree after the FEAT-157 strip (refuseDestroyIfLive + the deferImageSwap-for-station change in container-manager.ts, the start/stop/remove/rebuild routes in index.ts, and the agent-bridge probe line). Root cause of the OPEN/Verified-by:none reading: the round-9 line wrote "dispatch anthropic claude-opus-5-5 run ..." with a SPACE, but VERIFIED_BY_RE requires "dispatch anthropic/<model> run ...", so board:status counted no Verified-by and work_state was never advanced from open. Re-ran scripts/verify-bug-214-218-base-lifecycle.mjs in the FEAT-158 sandbox under its lock: 37/37 after re-applying the one suite adaptation FEAT-157 had made and the strip removed — seedId() now seeds from a legacy hashed base (no owner label) so the suite's planted "unlabelled" bases do not inherit an owner label from a v1+ seed (B6 was the only failure, 36/37, deterministic). No src/ edit. Verified-by: dispatch anthropic/claude-opus-5-5 run dcfa6307-4530-4bb9-ba79-49506e239d24 — VERDICT: HOLDS (round 9).

### 2026-09-30 — worker
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run dcfa6307-4530-4bb9-ba79-49506e239d24 — VERDICT: HOLDS (round 9). Machine-readable form of the round-9 verdict (the earlier line used a space, not a slash, so VERIFIED_BY_RE did not match).
