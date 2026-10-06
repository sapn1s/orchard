```orchard-ticket
{
  "id": "ARCH-022",
  "type": "architecture",
  "title": "Container lifecycle has no single owner",
  "summary": "Every path that can stop, remove or recreate a container carries its own live-session check, and separately every path deciding which base/CLI image a project should run (desired pin vs observed artifact) decides it alone. BUG-214 broke in 8 clean-room rounds and FEAT-157 in 3, each through a different such path; BUG-219 to BUG-222 are the same class.",
  "impact_if_we_wait": "Each new or overlooked path is a latent kill of a live session's container and its running work, found only when a clean room or the user hits it. Four known siblings are open now.",
  "current_need": "FEAT-157's redesign is folded in (FEAT-157 BLOCKED; WIP at scratch/feat157/wip). Plan+review build of ONE per-project authority owning BOTH destructive lifecycle ops AND image selection (desired pin vs observed artifact), liveness re-checked under its lock.",
  "severity": "high",
  "area": "container lifecycle",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "only the lifecycle authority can reach a destructive Docker primitive, proven by its export surface and a Docker shim that fails stray calls",
    "no authority operation, interleaved with a concurrent launch, removes, recreates or stops a live session's container; must-FAIL on the pre-authority tree",
    "a newly written route calling the most destructive authority operation during a live session is refused",
    "BUG-219, BUG-220, BUG-221 and BUG-222 scenarios pass under the authority, and verify-bug-214-218-base-lifecycle stays green",
    "an independent cross-provider clean room finds no destructive path outside the authority",
    "which base/CLI image a project should run (desired pin vs observed artifact) is decided in ONE authority; no other path picks or applies an image"
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "src/server/service-manager.ts"
    },
    {
      "path": "src/server/instance-owner.ts"
    },
    {
      "path": "scripts/verify-bug-214-218-base-lifecycle.mjs"
    }
  ],
  "related": [
    {
      "id": "FEAT-157",
      "relation": "depends_on"
    },
    {
      "id": "BUG-214",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-219",
      "relation": "supersedes"
    },
    {
      "id": "BUG-220",
      "relation": "supersedes"
    },
    {
      "id": "BUG-221",
      "relation": "supersedes"
    },
    {
      "id": "BUG-222",
      "relation": "supersedes"
    }
  ],
  "recurrence_evidence": [
    "BUG-214",
    "BUG-219",
    "BUG-220",
    "BUG-221",
    "BUG-222"
  ],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "22e3b551-5765-457a-8f61-afbf3665c840",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T23:32:49.058Z",
      "author": "verify lane (attacker a)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "property (a) no live container touched: ONE break - the in-container probe fails open when the image lacks sed (END still printed); a draining lease released under a running tagged tool, Remove deleted the container."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "f9638776-1b33-42cd-8076-b877d91469aa",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T23:32:50.771Z",
      "author": "verify lane (attacker c)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "property (c) one server per data dir: TWO breaks (two-break STOP) - same data-dir path in another mount namespace = same owner key + own lock; declared live with an XDG-moved data dir still live."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "48e7fff7-fcfd-46a5-bc47-eb3010eb87f7",
      "verdict": "invalid",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T00:33:37.927Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "attacker a2 (re-attack of a after fix): no verdict - headless run ended while waiting on the sandbox lock held by another suite; property (a) on the fixed tree is UNTESTED by an attacker in round 2."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "56e2e32d-8883-4920-8d42-95f7c5913fd2",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T00:33:43.886Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "c2 (one server per data dir): 2 breaks, different paths -> STOP. (1) path-only transitional rule: undeclared account-default dir in another namespace adopts unlabelled objects after live is declared; (2) identity forgeable via a writable copy of the data dir."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "e6b092db-9f23-47a8-b26b-eeb167cd2440",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T02:10:43.612Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "b r3 (one place): 2 breaks, STOP. (1) server runs docker-sandbox.mjs up via lane-docker ensureSandboxUp: ungranted create/start/volume on host daemon; scan skips scripts/lib. (2) CLI-in-image decided twice: status/keep-set trust label, launch uses bytes."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "3c22d6c3-ae06-4755-8369-bc7e822fec94",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T02:11:42.775Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "d r3 (FEAT-157): 2 breaks, STOP. (1) legacy pin + CLI layer: plan uses the legacy tag's current bytes; a moved tag recreates unadopted. (2) refused Start on undeclared server writes a newest pin (migrateBasePin before refuseForeign); after declare, moved to v1."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "3eb967b0-1b84-4fea-b5d6-906df845f97f",
      "verdict": "holds",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T02:14:35.193Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "a3 r3 (no live container touched): HOLDS. cp into session container, op exec w/o lease, rename/kill under lease, cp double-colon all refused; non-vacuity: raw docker cp bypassing docker-exec wrote into the container. Untested: real session, I10 server leg (room seed doc)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "927afc0e-8a40-4f77-b405-0af2bfeca07e",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T02:49:30.709Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "c3 r3 (one server per data dir, design B): ONE break - a copy of the data dir inherits lease files; its force-stop reaped the original's live tool via an unowned authority exec. Fixed (ownership on every authority exec), must-failed (I17/I18)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "07be0e78-c495-4e38-bbb3-5ff485e78a8b",
      "verdict": "holds",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T02:54:19.857Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "c4 r4 (c, re-attack of c3 fix + r2 framing): HOLDS, partial. Undeclared default-path server via real routes refused all; declared control acted. SAFE-FAIL by reading: st_dev drift after reboot would make the live dir a copy (fresh id). Copy framing only via I17."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "d76fb3a7-fe86-4479-a220-2423f64acacf",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T04:59:14.189Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "d5 FINAL (FEAT-157): HOSTILE HARM - a session user symlinks the CLI via /proc/self/root so docker cp -L cannot read it; unreadable = keep AND admit, so new sessions start on a foreign CLI. (A)/(B) re-attacks held by reading."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "8a96b1b7-955f-485a-a6e5-a25e3bc1529d",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T04:59:15.770Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "c5 FINAL (place): ACCIDENTAL HARM - a block clone of an ext4 data dir (dd/LVM snapshot) has the same fs UUID + inode, so it binds as the same declared-live instance; regressed-from the reboot fix (dev key refused it). btrfs snapshot/overlay refused."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "31c56ac5-3a75-486c-b6fd-5ebb057b3b55",
      "verdict": "broken",
      "verdict_on": "2026-10-02",
      "recorded_at": "2026-10-02T05:02:47.571Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "b5 FINAL (one place): ACCIDENTAL HARM - in one launch the shared release tag is re-read (pin id, CLI check, layer build); another instance's Rebuild between reads makes the pin name other bytes than the container; next idle launch recreates. COSMETIC: 11 scan-evasion forms."
    }
  ],
  "verification_class": "plan+review",
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

# ARCH-022 — Container lifecycle has no single owner

## Violated invariant
No container holding a live session is recreated, removed or stopped by any path unless that path
goes through ONE lifecycle authority that serialises operations per project and re-checks liveness
under its lock, immediately before the destructive Docker call.

And its twin, folded in from FEAT-157 (2026-09-30): which base/CLI image a project's container
SHOULD run — the desired pin, the security target, and what the container is observed to be running
— is decided in ONE authority. No other path re-derives the target, re-picks a base or runtime
image, or applies one; readers read the authority's answer (ARCH-010). "What should run" and "what
is allowed to change it, when" are one owner, because applying a new image IS a lifecycle operation.

## The design that produces this class
Container lifecycle has no single owner. The destructive Docker primitives (remove, recreate, stop,
swap-rename, service teardown, orphan sweep, base prune) are callable from many places: launch
admission (`agent-bridge.ts` -> `ensureContainer`), `doEnsure` drift handling, the
`/container/start|stop|remove|rebuild` routes, project DELETE, the orphan sweep, the base prune,
and `ensureServices`. Each entry point carries its OWN "is a session live?" guard, sampled at its
own moment, with its own idea of what "forced" means. The property "never destroy a live session's
container" therefore holds only if every entry point's guard is present, correct, and sampled after
the last await before the Docker call. That is enumeration over code paths (WA §N "structural
before enumerated"): it must name every door; the next door (or the next feature) needs only one
it missed. There is no per-project serialisation both admission and destruction must pass through,
so a launch can register on a container another operation is already removing.

Across processes the same shape repeats: which server is the live authority is inferred rather
than declared (BUG-219), and nothing stops two servers owning one data directory (BUG-220), so even
a perfect in-process authority is not the only authority.

## Second face of the class: "which image should run" (FEAT-157, folded in 2026-09-30)
FEAT-157 (pin a versioned base + hear about releases) was built and self-verified, then broke in
THREE consecutive independent clean-room rounds — every one of five properties broke every round,
each through a DIFFERENT entry point — and the rounds were STOPPED under the two-break rule and
routed here. The build's own diagnosis: "the observed artifact and the target are each decided in
several places (`baseTarget`, migration, `ensureRuntimeImage`, `doEnsure`'s recovery / running /
stopped branches)." That is the SAME defect as the lifecycle class — a fact with no single owner,
re-derived at each door — applied to image identity rather than to destruction. So the authority
this ticket builds owns both. The full WIP (all suites green, 3 rounds of fixes) is preserved at
`~/.local/state/claude-station/scratch/feat157/wip/` and is the design input, not a base to patch.

The doors, per property (from the FEAT-157 Activity log; r1–r3 = clean-room round):
- **(a) a pinned base never changes silently** — release tag keyed by version number only (r1);
  an unreadable catalog skipping the snapshot-hash check (r1); a re-cut or rolled-back catalog
  moving pinned projects (r2, r3); a legacy tag moved in place (r3); migration trusting image
  labels (r2).
- **(b) the security floor cannot be evaded** — recovery pins ignoring a due release (r1); a trusted
  existing floor tag used without its package proof (r1); unreadable catalog + a legacy pin (r2); an
  adopted floor with a Dockerfile last-good fallback (r3); an unknown pin above the floor (r3).
- **(c) only the server binds a notice; an agent acts on its own project** — recovery downgrade by
  an agent (r1); an agent dismissing a security notice (r2); `rev` not covering the release content
  the answer consented to (r3).
- **(d) the CLI stays matched to the host under a pin** — image-label trust (r1); an in-container CLI
  replacement (r1); a planted runtime-layer tag (r1); a stopped container never re-checked (r2);
  in-container / in-image `sha256sum` tools lying about the CLI (r2); the recovery launch path (r3);
  a parent-dir symlink / repo-bind symlink / `VOLUME` / a mount at `/home` (r3).
- **(e) migration recreates nothing and loses no history** — the wrong daemon at boot making every
  legacy project "newest" (r1); an interrupted Dockerfile swap pinned to newest (r1); a base-ref
  label spoof (r1, r2); a torn journal rewritten and re-guessed (r1); a read-only data dir (r2, r3);
  a size-capped `docker diff` recreating a correct container (r3).

Code entry points the authority must subsume for the image-identity half:
`base-releases.ts` `baseTarget`/`noticeFor`/`applyAction`; the boot migration; `ensureRuntimeImage`
(the CLI layer); and `doEnsure`'s recovery / running / stopped branches — plus the image-selection
reads on the launch, rail, agent-route and guide paths. The single authority answers "what image
should this project run right now, and may it be applied" once; every one of those reads it.

## Why the prior local patches did not hold
BUG-214 was a `fix`-class lane (no plan review). Its fix was correct for the door it named, and
then broke in 8 consecutive clean-room rounds, every break a DIFFERENT entry point with its own
liveness check (rounds and run ids are in the BUG-214 Activity log):
- r1: Rebuild removed a container that gained a session during the build; `/container/start` used a
  1.5 s cached guard then ensured without the defer.
- r2: `/start` treated a stale-cache request as forced; Rebuild used a stale project snapshot;
  `/start` with non-image drift recreated.
- r3: Rebuild's `docker rm` ran outside the per-project in-flight ensure (launch-during-rm race).
- r4: forced Rebuild passed no probe; Stop/Remove had the same launch-during-rm race.
- r5: Stop/Remove/DELETE that waited for a launch did not re-check liveness.
- r6: `<X>-next` name collided with X's swap name; a queued op re-checked one microtask early.
- r7: DELETE waiting on a build lock deleted a project that gained a session; the orphan sweep then
  removed its container.
- r8 (hostile): an image label `claude-station.role=service` inherited by the session container made
  `ensureServices` remove it.
- r9 HOLDS — for the doors named so far. Its own residual list is BUG-220, BUG-221, BUG-222.

Every patch added or moved a guard at a call site; none gave the property one owner. BUG-219..222
are the same class found at the edges of that fix: a second authority process (219, 220), a teardown
path outside the admission lock (221), a Rebuild that joins rather than serialises behind a launch
(222). FEAT-157's plan review (disposition item 3) already ADOPTED "one project lifecycle lock over
session admission and every destructive container op, with liveness re-checked immediately before
replacement" — this ticket makes that lock the single owner, not one more guard.

## Options, priced
- **A — keep patching per entry point.** Cost now: nothing new. Price: measured at 8 clean-room
  rounds (~most of a session's lane-hours) for one ticket, 4 open siblings, and every future route
  or feature that touches a container is a latent live-work kill until a clean room finds it. The
  property is never provable, because proving it needs the list of doors to be complete.
- **B — one lifecycle authority (recommended; the known-correct redesign).** A single module owns a
  per-project serialised operation queue. Every lifecycle operation — admit a session, ensure,
  start, stop, remove, rebuild, project delete, service teardown, orphan sweep, base prune — is an
  operation submitted to it; none is a function other modules can call around it. The authority
  re-reads liveness under the lock immediately before each destructive primitive, with no await in
  between, and the destructive primitives are private to the module. Cross-process: one server per
  data directory (exclusive lock at boot, BUG-220) and a declared live-instance marker (BUG-219), so
  the in-process authority is the only authority. Price: a real refactor of container-manager.ts and
  the index.ts container routes, sequenced behind FEAT-157 (same files); the existing
  `verify-bug-214-218-base-lifecycle.mjs` suite is reusable as the regression floor.
- **C — enforce at the Docker boundary** (a wrapper/shim that refuses rm/stop of a container whose
  session lease is live). Price: adds a second store of liveness that must agree with the first,
  serialises nothing (the launch-during-rm races survive), and still leaves "which process is the
  authority" open. It is a guard, not an owner — rejected, though a lease label may be a useful
  belt under B.

There is no genuine fork: B is the one design under which the invariant holds by construction, so
this is a `plan+review` build, not a human decision.

## Migration path (each step lands and is verifiable alone)
1. **After FEAT-157 lands** (it owns container-manager.ts and index.ts now): introduce the authority
   module with the per-project queue and route every existing caller through it, behaviour-
   preserving. BUG-214's per-route guards stay in place as a belt for this step.
   Verify: `verify-bug-214-218-base-lifecycle.mjs` 37/37 unchanged.
2. Move liveness re-check into the authority (one function, called under the lock right before each
   destructive primitive) and make the primitives module-private. A test asserts the module's export
   surface contains no destructive primitive.
3. Fold BUG-221 (service teardown becomes an authority operation, scoped by owner label, never by
   role class) and BUG-222 (a Rebuild submitted during a launch queues its recreate behind it rather
   than joining it). Session containers' identity comes from the authority's own declaration, never
   from an inheritable image label (the r8 lesson).
4. Fold BUG-220 (exclusive data-dir lock at boot; second server refuses and names the holder) and
   BUG-219 (declared live-instance marker, read rather than inferred).
5. Delete the per-route guards now subsumed by the authority, once step 2's tests cover every
   operation.
Rollback: steps 1-4 each revert alone; step 1 changes no behaviour; step 5 is the only removal and
is last.

## Proof bar
- **Structural:** no module other than the authority can reach a destructive Docker primitive —
  asserted on the export surface, and at runtime by a Docker shim that logs the calling operation for
  every rm/stop/rename/create and fails the suite on any call not issued inside an authority
  operation holding that project's lock.
- **Behavioural:** for every authority operation x every interleaving with a concurrent launch
  (submitted before, during each await of, and after the operation), no container with a live
  session is removed, recreated or stopped — run in the FEAT-158 sandbox, must-FAIL against the
  pre-authority tree. BUG-221 and BUG-222 scenarios included; two servers on one data dir (BUG-220)
  and a moved data dir (BUG-219) included.
- **New-door test:** a freshly written route that calls the authority's most destructive operation
  while a session is live is refused — proving a door nobody enumerated is still covered.
- **Independent clean room**, cross-provider, charter carrying the §N two-break STOP.
- **Falsifier:** a clean-room attacker finds any destructive Docker call not issued through the
  authority, or any liveness decision taken outside the lock or before an await — then the design
  is not done, and the answer is to move that path into the authority, never to guard it locally.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — worker (process-lessons lane)
- **Filed (file-only, queued behind FEAT-157):** from the BUG-214 8-round record and BUG-219..222,
  per the amended WA §N "structural before enumerated" (a guard per entry point is enumeration; two
  breaks of one property through different doors routes to a single-authority redesign).
  BUG-219..222 fold into this ticket (supersedes); BUG-214 linked as the recurrence evidence.
  Class: `plan+review`, one known-correct redesign (option B); no human decision needed.
- Symptom of a deeper design flaw? yes — this ticket.

### 2026-09-30 — worker
- **Note:** Process-lessons lane report (2026-09-30). WA v4 canonical: §N 'Structural before enumerated' merged-rewritten (per-entry-point guards count as enumeration; the two-break trigger fires in any verify loop and routes to a single-authority redesign); §I gained 'Every verify charter carries the two-break STOP'; methodology CHANGELOG entry added; sync:methodology mirror in sync. CONVENTIONS.md: 'Restart checkpoint protocol' stub (injected) plus a detail section below the inject end marker. Checks: verify-bug-146 18/18 (injected 25841 of 26000 chars); verify-wa-selfmaintain 43/43; verify-independent-verification 152/152 (1 skipped); verify-bug-099-attach-wa-coherent 12 FAIL, identical with the HEAD WA mirror swapped in (pre-existing, not this change); board:check OK; npm run gate exit 0. Back-edges written on FEAT-157 (blocks), BUG-214 (recurrence_of), BUG-219..222 (superseded_by). Docs-only, no src/ touched, no git writes.

### 2026-09-30 — worker (FEAT-157 strip lane)
- **Scope extended to fold in FEAT-157's redesign.** FEAT-157 was built and self-verified, then
  broke in 3 consecutive independent clean-room rounds (all 5 properties every round, each through a
  different entry point) and was STOPPED under the two-break rule. Its own diagnosis names the same
  no-single-owner defect as this ticket, applied to image identity: the observed artifact and the
  target are each decided in `baseTarget`, the boot migration, `ensureRuntimeImage`, and `doEnsure`'s
  recovery/running/stopped branches. This ticket's authority now owns BOTH destructive lifecycle ops
  AND "which image a project should run" (desired pin vs security target vs observed artifact).
- **Edited (scope, sanctioned):** summary (both faces of the class); a new `## Second face of the
  class` section listing the per-property entry points (a–e, r1–r3) and the code doors from the
  FEAT-157 log; a twin invariant under `## Violated invariant`; a 6th success criterion (one image
  authority); `current_need` (FEAT-157 folded in, no longer merely queued behind it). No prior log
  entry or body prose was deleted.
- **FEAT-157 WIP is the design input, not a base to patch:** full tree + 3 rounds of fixes at
  `~/.local/state/claude-station/scratch/feat157/wip/` (all its own suites green). The unverified
  FEAT-157 build was stripped from the working tree this lane; see FEAT-157's Activity log.
- No src/ touched here; ticket-only. No git writes.

### 2026-10-01 — worker
- **fixing, round 1 — plan written; CHECKPOINTED before review (restart):** Plan written (full text: ~/.local/state/claude-station/scratch/arch022/plan/plan.md). Hypothesis PARTLY CONFIRMED, chokepoint moved: (1) destructive docker calls live in THREE modules (container-manager, service-manager, project-builder), not only doEnsure; (2) a queue around docker ops alone does not close the class, because liveness is read from liveSessions(), which a launch joins only at sessions.set AFTER ensureContainer resolves and further awaits; that gap is what exclusiveOp's macrotask-yield re-check papers over (BUG-214 r5/r6). So ADMISSION must be an authority op and liveness a LEASE granted under the lock; (3) joining an in-flight ensure is itself a door (BUG-222). Design: docker-exec.ts = the only docker spawner (query for read-only verbs; mutate(token) for everything else, token minted only by the authority); lifecycle.ts = per-project FIFO + global queue; ops admit/release/start/stop/remove/rebuild/deleteProject/sweepOrphans/pruneImages/migrateBases/applyBaseAction; liveness = leases read in the same tick as the mutate; force = lease ids captured at request time; desiredImage(project) is the one image decision. Cross-process: authority bound to BUG-217's claimDataDir flock; live instance declared by the unit (ORCHARD_INSTANCE=live), not inferred from CLAUDE_STATION_DATA. Migration: (i) route every caller through lifecycle, no behaviour change; (ii) leases + no joins, delete per-path guards; (iii) BUG-219..222; (iv) FEAT-157 on top (reuse base-releases policy, release tooling, guide, rail/routes, suites; rewrite the WIP image-selection branches). Must-FAIL: static + runtime-shim bypass proof and BUG-219..222 scenarios vs pinned pre-lane tree. Review NOT started (restart requested before it). No source file edited; nothing to restore. RESUME: send plan.md to the cross-provider plan review (openai if npm run usage has headroom, else anthropic claude-opus-5-5 --cwd room), record verdict, then build step (i).

### 2026-10-01 — worker
- **fixing, round 1 — plan review r1+r2 (openai), plan v3:** Plan review, cross-provider (openai/codex, read-only room = src + plan + bug-214-218 suite + FEAT-157 WIP; no board, no methodology). r1 run 01a0f921-563b-73c0-bc8a-4ba0af14dc75: VERDICT UNSOUND, 11 findings (4 Critical/High on leases): lease released at sessions.delete while the exec still drains (verified: agent-bridge close deletes at ~L3375, reaps ~L3420); execs survive a server crash (verified: reapExec doc); mutate token without mandatory protection; exec as a read hatch; timeout releasing the lock mid-mutation; queued admit resurrecting a deleted project; step (i) not behaviour-preserving as written; project/global deadlock; boot claim not a lifetime capability; desiredImage only a name; simplify to one scheduler. All adopted -> plan v2. r2 (re-review of v2, same provider, fresh session; meta in scratch/arch022/plan/review2-meta.json): VERDICT UNSOUND; r1 #7 ADDRESSED, the other 10 PARTIAL; new: probe fails open, crash window for accepted-but-invisible execs and in-memory fences, force waiting on a reap that needs its own lock, stable inspect is not completion of a timed-out mutation, target schema missing builder/smoke/lock/disconnect/load doors, builder withProjectLock as a second scheduler, sealAuthority = first caller not authorised caller, stale generation/snapshot, test bootstrap. All adopted -> plan v3 (scratch/arch022/plan/plan-v2.md + plan-v3-delta.md): tri-state probe, DURABLE leases + boot barrier (claim->recovery->ready), reap as a lease op with a force deadline, durable fences cleared only by verb-specific terminal evidence, per-resource schema matrix, builder lock folded into the project op, generation at enqueue + re-resolve after build, test bootstrap. Boundary stated: architectural enforcement over Orchard's own code paths, not runtime access control against other docker clients or a process that clears its env tag. No third prose round (WA §N stopping rule: r2 narrowed r1's classes; the attackers test built code). Building step (i) now.

### 2026-10-01 — worker
- **fixing — step (i) landed (executor extraction):** Step (i), no behaviour change: new src/server/docker-exec.ts is the only module that spawns the docker binary; container-manager, service-manager and project-builder call dockerSpawnSync/dockerSpawn with unchanged argv and timeouts; the base export pipeline `sh -c "$0" image save | tar` became docker save streamed into tar (no shell). Mutations outside an authority are RECORDED in compat mode (enforcement switch for step ii). Static half of the bypass proof: scripts/lib/arch-022-static.mjs (TypeScript 7 here has no JS compiler API, so node:module stripTypeScriptTypes + a small tokenizer). It finds every child_process spawner call in src/ under any import form; a docker or shell binary outside docker-exec.ts, a computed binary not on a reasoned allowlist, CLAUDE_STATION_DOCKER outside docker-exec.ts, or sealAuthority outside lifecycle.ts is a finding. MUST-FAIL: current tree 0 findings / 67 files; pinned pre-lane tree (scratch/arch022/pre-tree = current src with the 3 managers from scratch/arch022/pre/) 12 findings (8 computed DOCKER spawns, 3 CLAUDE_STATION_DOCKER, 1 sh wrapper). Executed: npm run gate exit 0. Sandbox (DOCKER_HOST at the FEAT-158 sandbox, GPU hidden by bwrap --dev /dev --tmpfs /etc/cdi): bug-214-218 37/37, bug-216 23/23, feat-112-services 17/17. Pre-existing and identical on a full pre-lane copy (scratch/arch022/pre-full): feat-155-image-env-policy 14/15 (fails 'untouched container is reused'), bug-107 22/23 (fails B3 precondition), arch-020 9/21 (builder validation cannot run in the sandbox). Next: step (ii), the behavioural landing.

### 2026-10-01 — worker
- **fixing — step (ii) landed: the authority (leases, ops, gate); BUG-221/222 fixed by construction:** Built (uncommitted). src/server/lifecycle.ts = THE authority; docker-exec.ts asks it (sealAuthority, once) before spawning ANY mutation, fail-closed (no authority loaded = no mutation). A mutation is granted only inside an operation (runOp: per-project FIFO, never joins, never nests), while this server holds its data dir (lanes.isWriter), on a target inspected and classified by role (session/service/builder/smoke/base-tag lock/image) that belongs to the op's project and this instance; destroying a session container or a service resource needs zero leases AND a probe proving no tagged process runs (probe as session uid AND root; a process neither can read = unknown = protected). Leases are durable files written at admission before the exec exists; a closed session DRAINS (released only when its processes are proven gone); boot RECOVERY turns persisted leases and tags found in running containers into draining leases before any op runs. Timed-out mutations write a durable fence (cleared only by terminal evidence or a later certain completion). Admission (agent-bridge, 4 small spots, slot granted by the coordinator) = one admit op: services + ensure + network join + lease. Routes: start/stop/rebuild/remove/DELETE/orphan sweep are ops; the per-route cached guard, exclusiveOp + macrotask yield, rebuild post-build re-check, DELETE lateLive, deferImageSwap/refuseDestroyIfLive and the ensures join map are DELETED. project-builder withProjectLock folded into the op. Force = lease ids captured at request time, reaped and waited for, deadline then 409. Every mutation carries a grant id (ORCHARD_DOCKER_GRANT) for the runtime oracle. Two product bugs found by suites while building and fixed: the post-ensure prune was scheduled nested inside the op (never ran; bug-107 F1 caught it); the probe ran only as the session uid, so a root-owned tagged process was invisible (bug-214 S5 caught it). New suite scripts/verify-arch-022-authority.mjs (sandbox): 34/34 on this tree. MUST-FAIL vs the pinned pre-lane tree (scratch/arch022/pre-full, old API through the suite's adapter): I/O sections 0/9 - BUG-221 stop/remove + queued launch lost its sidecar, BUG-222 rebuild during launch neither applied its own build nor said deferred, delete + queued launch resurrected the container, closed session's running tool killed by Stop, no fence, BUG-220 second process removed the live container, crash leftover's container removed, 59/59 mutations ungranted; static S2 12 findings. Anti-regressions (sandbox, GPU hidden): bug-214-218 38/38 (S-scenarios rewritten as lease scenarios via an adapter; same suite on its pinned prefix 9/38, on pre-full 37/38 with new S7b failing: the OLD launch path recreated a container under a live session on settings drift, a door BUG-214's 8 rounds never closed), bug-216 23/23 (helpers now act with their instance's server down: one process per data dir), feat-112 17/17, bug-107 23/23 (was 22/23), feat-155-image-env-policy 15/15 (was 14/15; one UI-timeout flake seen once), feat-145-container-account 24/29 (pre 22/29; the 5 left are real-OAuth/host-inode environmental, also failing pre), bug-157-container-scripted-kill 4/6 (= recorded baseline; real container sessions start through admission), arch-020 9/21 and feat-155-dockerfile 22/43 and prebuilt-lockdown 1/2 identical pass/fail lists to pre-full (host /proc and builder validation cannot run in the sandbox; my in-process adaptations of the dockerfile layer 3 and prebuilt layer 2 are therefore UNTESTED here). verify-feat-157-base-recreate-under-live is BUG-214's pre-fix repro probe (its P4 asserts the bug) - left untouched. Static scan 0 findings. npm run gate exit 0. Next: step (iii) BUG-219 declaration + BUG-220 server-level leg, then step (iv).

### 2026-10-01 — worker
- **fixing — step (iii): BUG-219 declared live instance; BUG-220 container leg; claim checked per mutation:** BUG-219: instance-owner.ts declareInstanceFromEnv(): the live instance is DECLARED by the systemd unit (ORCHARD_INSTANCE=live), read once at boot (index.ts, before anything is spawned) and deleted from the process env so no session/lane/scratch server inherits it; a declaration on a server with an explicit CLAUDE_STATION_DATA is not honoured. mayActOn('unlabelled') reads the declaration (it used to infer "live" from CLAUDE_STATION_DATA being unset). The boot log now says whether the instance is declared. USER ACTION before the next restart: add the unit drop-in (exact command in the lane handoff); without it the live server adopts no pre-label (unlabelled) container/network/volume - a refusal, never a removal. BUG-220: the server-level lock was already BUG-217's claimDataDir; ARCH-022 adds the library level: every mutation re-checks lanes.isWriter(), so a second PROCESS on a held data dir (I6) or a server whose dir was moved under it (I11) mutates nothing. Suite scripts/verify-arch-022-authority.mjs now 39/39: I9a undeclared moved-data-dir server adopts nothing unlabelled, I9b the declared one does and its env no longer carries the declaration, I9c a declaration with an explicit data dir is ignored, I10 second SERVER exits 78 and the first server's container keeps its id, I11 moved data dir -> remove refused no-claim. On the pinned pre-lane tree: I9a/b/c and I11 FAIL; I10 PASSES there too (honest: the server-level half was fixed by BUG-217; the new part is the per-mutation check). bug-216 shared-instance helper now declares ORCHARD_INSTANCE=live: 23/23. npm run gate exit 0. Next: step (iv) FEAT-157 on the authority.

### 2026-10-01 — worker
- **BUG-223 residual: direct-session lane Docker read by project id:** BUG-223 residual fixed inside the ARCH-022 lane (coordinator request, agent-bridge slot held by ARCH-022): src/server/agent-bridge.ts startSession, the direct-session lane Docker decision, now reads THIS project's registry row by id - laneDockerEnv({ projectPath, project: getProject(opts.project.id) ?? null }) - through the by-row reader declarationOfRow (scripts/lib/lane-docker.mjs), the same one the dispatch broker uses; it used to resolve by project PATH, so a second row on the same path could decide another project's daemon. One line. Executed: npm run gate exit 0; scripts/verify-bug-223-lane-docker.mjs 62/62. Not separately attacked: covered by the ARCH-022 attacker scope per the coordinator.

### 2026-10-01 — worker
- **fixing — self-found hole in the gate role table (inherited image label), fixed:** Found while building step (iv): the gate classified a container role by labels in a fixed order (base-tag lock, smoke, builder, service, then session), so a project image carrying claude-station.smoke=1 gave its SESSION container the smoke role, whose removal needs no lease - a Remove under a live lease succeeded (the BUG-214 round-8 class: inherited image labels). Fix (lifecycle.ts roleOf): a session container is recognised FIRST, by what Orchard declared at create (role=session; create-time labels override image labels) or, for a pre-role-label container, by its own name agreeing with its project label. New check R10 in scripts/verify-arch-022-authority.mjs (images carrying smoke / rtbuild / basetag-lock labels): current tree 3/3 PASS (R section 16/16); on a variant = current tree with only lifecycle.ts from the attacker rooms (before this fix): the smoke case FAILS (removed under a held lease). NOTE: attackers a and c run on the pre-fix copy; a break they report through this door is this finding.

### 2026-10-01 — verify lane (attacker a)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 22e3b551-5765-457a-8f61-afbf3665c840 — VERDICT: BROKEN — property (a) no live container touched: ONE break - the in-container probe fails open when the image lacks sed (END still printed); a draining lease released under a running tagged tool, Remove deleted the container.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — verify lane (attacker c)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run f9638776-1b33-42cd-8076-b877d91469aa — VERDICT: BROKEN — property (c) one server per data dir: TWO breaks (two-break STOP) - same data-dir path in another mount namespace = same owner key + own lock; declared live with an XDG-moved data dir still live.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — worker
- **verifying round 1 (attackers a, c) — a: one break, fixed; c: TWO breaks, STOPPED (redesign routed):** Independent clean-room attack, round 1: two concurrent attackers, anthropic claude-opus-5-5, each in a bwrap jail (sandbox daemon only, loopback + allowlisted model proxy, repo read-only, docs/CLAUDE.md masked; room = exported tree + private node_modules; input = requirement, fix.diff, fixer suites). Charters carried the two-break STOP. Recorded with board-tool verified.
  (a) no live session's container touched - run 22e3b551-5765-457a-8f61-afbf3665c840 BROKEN, ONE path: the in-container probe parsed environ with tr/sed/head and still printed END when the image had no sed, so a draining lease was released under a running tagged tool and Remove deleted the container (also reached recovery). Fixed: the probe needs only sh+cat inside (cat proven first, else unknown); the stream is parsed HOST-side, tags taken from anywhere in it (a hostile environment can only add tags), and a live non-zombie pid unreadable as BOTH the session uid and root is unknown (protected). Its two could-not-test gaps fixed too: lease files are now NAMED <project>--<tag>.json so a torn file still protects its project (quarantine lease at recovery), and a running container that cannot be inspected at recovery gets a quarantine lease; a failed container listing fails recovery loudly instead of reading as none. Must-FAIL: new R11 (images without sed / without cat) and I12 (torn lease file across a restart): current tree PASS; on the attacked variant (only lifecycle.ts from the attack room) R11-no-sed FAILS. Suite now 45 checks: S 11, R 18, I+O 16, all PASS. Not yet re-attacked.
  (c) one server per data dir - run f9638776-1b33-42cd-8076-b877d91469aa BROKEN, TWO different paths -> TWO-BREAK STOP, no guard added: (1) the same data-dir PATH in another mount namespace (another container/VM/host on the same daemon) gets the same owner key (hash of the path) but its own inode lock, sees none of the first server's leases, and removed its session container, sidecar and network; (2) a server declared live (ORCHARD_INSTANCE=live) whose data dir moved via XDG_DATA_HOME counts as live (my rule only required CLAUDE_STATION_DATA unset) and removed the real live server's unlabelled legacy container. Shared root (attacker's words: enumerated property): instance IDENTITY is inferred from a path/env while EXCLUSIVITY is an inode lock. Proposed single-authority redesign (not built, routed to the orchestrator): identity and liveness DECLARED INSIDE the data dir, bound to the locked inode - a random instance id written once into the data dir at first claim becomes the owner key (identity follows the directory, not its path), and the live declaration is a marker in the live data dir itself rather than an env var, so a moved/copied/namespaced path cannot inherit it. Also SAFE-FAIL noted: the unit drop-in is a user action (in the handoff). Self-found earlier (role table) and attacker-found (probe) holes are both in (a) and fixed. npm run gate exit 0; static scan 0.

### 2026-10-01 — orchestrator
- **Decision:** Decision: build declared-identity redesign in ARCH-022 (orchestrator, 2026-10-02). Instance identity and liveness are declared INSIDE the data dir and bound to the locked inode: a random instance id written once at first claim is the owner key; the live declaration is a user-declared marker in the live data dir (replaces the systemd ORCHARD_INSTANCE=live step, which is dropped). Requirements: migration with no live recreate (today's path-keyed objects stay owned; adoption only when the marker is present, the lock is held, and the object carries this data dir's previous key) with must-fail + a live-like fixture (real registry copy, labelled objects in the sandbox survive the first boot untouched); until the marker exists the live server behaves exactly as today; re-attack (c) with both breaks' framings plus (a)'s fix, concurrently, two-break STOP kept; keep the BUG-223 one-liner.

### 2026-10-02 — worker
- **fixing — declared-identity redesign built (property c); round-2 attack launched:** Built per the decision. src/server/instance-owner.ts: the owner key is the identity DECLARED in the data dir (orchard-instance.json: a random 16-hex id written once with exclusive create, recording the directory's dev/ino; a copy or a different directory at the same path is another inode -> another instance, fresh id, no legacy ownership), bound under the data-dir lock at boot recovery (bindInstance; process-global so re-imported modules agree). The LIVE instance is a USER-declared marker in the data dir (orchard-live-instance.json, inode-bound; scripts/orchard-live-instance.mjs declare|status|revoke); the ORCHARD_INSTANCE env declaration and its systemd step are DROPPED. Migration: a data dir that had state when its identity was first written records its old path key (legacyKey) and keeps owning objects labelled with it when declared live or, transitionally until declared, when it is this account's default data dir (password database, not env) - which then behaves exactly as the live server did before; nothing is recreated or relabelled. Stated residual (decided): pre-identity objects of two pre-existing installs at one path on one daemon carry identical labels and cannot be told apart. Tooling: owned-docker ownerKeyFor declares/reads the dir's identity; bug-214/216 key helpers likewise; bug-216's shared-instance helper declares its dir live; feat-155-image-env-policy mkdir made recursive. Must-FAIL vs the attacked tree (attacker c's room = pre-redesign): I13 (another directory at the SAME path, another mount namespace via bwrap tmpfs) - attacked tree: the other server REMOVED the container and its sidecar; fixed: foreign-owner, all kept. I9a (XDG-moved, env-declared: not live) and I14 (a copied declared dir: fresh id, not live) fail there, pass here. I15 live-like migration: a copy of the user's REAL registry (5 container projects) + their containers and a network planted under the old path key + one unlabelled container, dir declared live: first boot keeps owning them (legacy key), adopts the unlabelled one, registry byte-identical, every container id unchanged. I16 transitional (a scratch dir bind-mounted AT the account-default path in a mount namespace; the real data dir verified untouched afterwards): undeclared default dir owns its pre-identity objects and adopts unlabelled ones, as before. Executed: verify-arch-022-authority S+R 29/29, I+O 19/19; bug-214-218 38/38; bug-216 23/23; feat-112 17/17; bug-107 23/23; feat-155-image-env-policy 15/15; feat-145 24/29 (same 5 environmental); bug-157-scripted-kill 4/6 (baseline); npm run gate exit 0; static scan 0. Round-2 attack launched concurrently (anthropic claude-opus-5-5, same jail; rooms now carry placeholder docs/prompts stubs so a server boots): (a) re-attack of the probe/recovery/role fixes, (c) re-attack of both round-1 framings and the migration/transitional rules; two-break STOP in both charters.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 48e7fff7-fcfd-46a5-bc47-eb3010eb87f7 — VERDICT: INVALID — attacker a2 (re-attack of a after fix): no verdict - headless run ended while waiting on the sandbox lock held by another suite; property (a) on the fixed tree is UNTESTED by an attacker in round 2.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 56e2e32d-8883-4920-8d42-95f7c5913fd2 — VERDICT: BROKEN — c2 (one server per data dir): 2 breaks, different paths -> STOP. (1) path-only transitional rule: undeclared account-default dir in another namespace adopts unlabelled objects after live is declared; (2) identity forgeable via a writable copy of the data dir.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — worker
- **verifying round 2 — c2 TWO breaks, STOPPED; a2 INVALID; step (iv) staged not merged:** Round-2 result: c2 (run 56e2e32d-8883-4920-8d42-95f7c5913fd2) BROKEN by TWO different paths -> two-break STOP honoured, no guard layered. (1) [accidental, harm] the transitional rule is path-only (instance-owner.ts: transitional = !liveDeclared && isAccountDefaultDataDir): a fresh undeclared dir at the account-default PATH in another mount namespace (own lock, fresh id, legacyKey null) still adopts UNLABELLED objects even after the user declared the real instance live; it removed the live server's leased (attached, no tagged process yet) unlabelled session container + network. The orchestrator requirement "until declared, behave exactly as today" and "a namespaced default path is not the live one" cannot both hold from inside one namespace: the declaration is invisible across namespaces. (2) [hostile, harm] the identity file is self-attesting: anyone able to write a copy of the data dir can rewrite orchard-instance.json to the original id with the copy's dev/ino and boot as the original owner (removed its owner-labelled session container). Same uid already has raw docker access, so this is a threat-model call. Cosmetic: foreign-owner refusal still says "isolated instance (CLAUDE_STATION_DATA)". Held: fresh boot gets no legacy key; non-default path in another namespace refused foreign-owner; tagged running process refused live-sessions; moved+copied dir refused no-claim / foreign-owner; marker copy ignored; bindInstance path race resolved via /proc/self/fd. a2 (run 48e7fff7-fcfd-46a5-bc47-eb3010eb87f7) INVALID: the headless run ended while waiting on the sandbox lock - property (a) re-attack NOT done. Options for the orchestrator (not built): (A) make liveness/adoption a DAEMON-side fact, e.g. the live declaration also stamps an owner-claim object on the daemon (a labelled volume carrying the live id), so an undeclared default dir adopts unlabelled objects only when no live claim exists on that daemon - closes (1) without per-path guards; (B) drop the transitional rule (unlabelled adoption only after the declare command) - closes (1), changes today's behaviour until the user runs declare; for (2) either accept (same-uid writer = docker access anyway) or bind identity to something the copy cannot forge. State at STOP: real tree = steps i-iii + declared-identity redesign, npm run gate exit 0 (2026-10-02). Step (iv) FEAT-157-on-authority is built and green in staging (~/.local/state/claude-station/scratch/arch022/iv-tree: feat-157 lifecycle L0-L17, policy 36/36, server 37/37 incl. UI; bug-214 38/38) but NOT merged into the real tree; attackers (b) and (d) not launched; package.json base:release line not added. Gateway stopped.

### 2026-10-02 — orchestrator
- **Decision:** Decisions (orchestrator, 2026-10-02): Break (1) -> option B: drop the transitional (account-default path) rule; unlabelled and pre-identity objects are adopted ONLY by a DECLARED live instance; nothing is inferred from the path. Deploy order: the user runs declare BEFORE the restart that ships this; declare must be safe on the current old server (writes only the marker, old code ignores it). Prove an undeclared new server leaves legacy objects untouched (refuse + report) and never recreates them. Break (2) (identity forgery by a same-user writer of the data dir) ACCEPTED as out of threat model (that writer can already drive docker); documented as a known limit. Then: merge step (iv), base:release line when package.json lock is free, concurrent jailed attackers (b), (d), (a) re-attack, (c) on design B excluding the accepted forgery; two-break STOP kept; attackers wait for the sandbox lock, longer lock wait.

### 2026-10-02 — worker
- **fixing — decision B built, step (iv) merged, round 3 launched:** Decision B built + step (iv) merged; round-3 attack launched. (1) instance-owner.ts: the transitional (account-default PATH) rule is deleted - unlabelled and old path-keyed objects are adopted/owned ONLY by a DECLARED live instance (marker); nothing is inferred from a path. Refusals now say why and name the declare command (container-manager refuseForeign / refuseForeignBase; the boot log says "NOT declared live ... declare, then restart"). Known limit documented in the module header: identity/marker files are trusted when their dev/ino match, so a same-user writer of the data dir can forge them - accepted, out of threat model (that writer already drives docker). The declare script writes ONLY orchard-live-instance.json (identityOf without create never writes; status reads only) - an old server never reads that file, so declaring before the restart is a no-op for it. Must-FAIL: new I16 (an UNDECLARED server on this account's DEFAULT data dir, a scratch dir bind-mounted at the default path in a mount namespace, with an existing install's registry; one old-key and one unlabelled session container, the latter leased by the live server = c2 break 1): current tree - launch AND remove of both REFUSED foreign-owner with the declare report, both containers kept with the same ids, no recreate (no second container, no .next); on the variant (current tree + only the pre-B instance-owner.ts) - ensure/remove DONE on both, containers GONE/recreated (FAIL). I16b after declare: owns + adopts them, first boot touches nothing. (2) Step (iv) FEAT-157 merged from the staging tree by 3-way diff3 against the 03:01 base (0 conflicts; the only real-tree changes since the base were my B edits; agent-bridge/index/templates unchanged by others since the base), plus new files base-releases.ts, base-updates.ts, container/base-releases.json, container/releases/v1/*, scripts/base-release.mjs, verify-feat-157-{policy,lifecycle,server}.mjs. package.json: the BUG-223 file lock had released; added only "base:release". The authority suite adapted to FEAT-157 (projects pinned dev, base seeded via baseRefFor, CLI-layer repo per run, cp passthrough in its shim). Executed on the merged tree: npm run gate exit 0; static scan 0 findings; verify-arch-022-authority S+R 29/29, I+O 20/20; feat-157-policy 36/36; feat-157-lifecycle all sections pass, run in groups (L0-L4e, L5-L6, L7-L9, L10, L11-L13b, L14-L16, L17; a single full run exceeds the 10-min tool limit); feat-157-server 38/38 incl. UI + P1; bug-214-218 38/38; bug-107 23/23; feat-112 17/17; feat-155-image-env-policy 15/15; feat-151-container 6/6; feat-151-runtime-update 76/76; feat-145 24/29 (same 5 environmental: a real session cannot authenticate in the sandbox). bug-216 NOT re-run yet: it refuses while the sandbox holds another tester's container (claude-station-f90, not mine). (3) Round 3 attack launched concurrently (anthropic claude-opus-5-5, bwrap jail, sandbox only, ORCHARD_DOCKER_LOCK_TIMEOUT=7200, charter now forbids background commands - a2's failure): a3 (a re-attack incl. the new rtbuild/cp/validation doors), b (one place: authority + one image plan), c3 (design B; same-user forgery excluded), d (FEAT-157 a-e on the authority). Two-break STOP in every charter.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run e6b092db-9f23-47a8-b26b-eeb167cd2440 — VERDICT: BROKEN — b r3 (one place): 2 breaks, STOP. (1) server runs docker-sandbox.mjs up via lane-docker ensureSandboxUp: ungranted create/start/volume on host daemon; scan skips scripts/lib. (2) CLI-in-image decided twice: status/keep-set trust label, launch uses bytes.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 3c22d6c3-ae06-4755-8369-bc7e822fec94 — VERDICT: BROKEN — d r3 (FEAT-157): 2 breaks, STOP. (1) legacy pin + CLI layer: plan uses the legacy tag's current bytes; a moved tag recreates unadopted. (2) refused Start on undeclared server writes a newest pin (migrateBasePin before refuseForeign); after declare, moved to v1.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 3eb967b0-1b84-4fea-b5d6-906df845f97f — VERDICT: HOLDS — a3 r3 (no live container touched): HOLDS. cp into session container, op exec w/o lease, rename/kill under lease, cp double-colon all refused; non-vacuity: raw docker cp bypassing docker-exec wrote into the container. Untested: real session, I10 server leg (room seed doc).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — worker
- **verifying round 3 — a HOLDS; b, d TWO breaks STOPPED; c one break fixed; c4 launched:** Round 3 results (anthropic claude-opus-5-5, jailed, concurrent; recorded with board-tool verified):
  (a) a3 run 3eb967b0-1b84-4fea-b5d6-906df845f97f HOLDS - cp into a session container, op exec without a lease, rename/kill under a lease, cp container-to-container all refused; non-vacuity: a raw docker cp bypassing docker-exec did write into the container. Could not test: a real authenticated session; the I10 two-server leg (room seed doc).
  (b) b run e6b092db-9f23-47a8-b26b-eeb167cd2440 BROKEN, TWO paths -> two-break STOP, no guard added: (1) the server itself spawns scripts/docker-sandbox.mjs up through scripts/lib/lane-docker.mjs ensureSandboxUp (agent-bridge.ts startSession and dispatch-broker.ts, BUG-223 code): docker volume create / create --privileged / start on the HOST daemon with no grant and no operation; the static scan only walks src/ (src imports scripts/lib/*) and the runtime oracle only sees CLAUDE_STATION_DOCKER. Objects touched: the FEAT-158 sandbox's, not a project's. (2) "does this image already carry the host's CLI" is decided twice: status / provision state / the PRUNE KEEP-SET go through imageOfPlan -> runtimeImageNameFor, which trusts the image LABEL when no byte proof is cached, while the launch (resolveImage) decides by the CLI's BYTES; on a legacy pin whose base label claims the host's CLI version with different bytes, status and keep-set name the base while the launch runs a claude-station-rt layer (divergence observed; keep-set lacks the launch image).
  (c) c3 run 927afc0e-8a40-4f77-b405-0af2bfeca07e BROKEN, ONE path (fixed, below): a COPY of a live data dir inherits its lease files; recover() loads them as orphan leases, and a ?force=1 Stop on the copy's server ran forceDrain -> reapTags, a raw authority exec kill -TERM inside the ORIGINAL's container (no ownership question), killing the live session's tool before the stop was refused as foreign. Also SAFE-FAIL: an unreadable (EACCES) identity file was treated as corrupt and replaced by a fresh id (fixed); COSMETIC: a btrfs restore after the original is deleted can reuse its (dev, ino) and so be the same declared instance; a revoke takes effect only at restart (documented). Could not test: round 2's framing (its experiment was stopped by a safety classifier; the fixer's I16 did not run in its room).
  (d) d run 3c22d6c3-ae06-4755-8369-bc7e822fec94 BROKEN, TWO paths -> two-break STOP, no guard added: (1) a legacy pin whose container runs the CLI layer: basePlanOf treats a legacy base as "the bytes the container runs" only when the container runs the legacy tag itself; with the CLI layer on top the plan uses whatever the legacy TAG points at now, so an old in-place rebuild moving the tag recreates the container on new bytes at the next idle launch, unadopted, with no notice (L15 covers only the no-layer case). (2) regressed-from: this lane's decision-B change combined with FEAT-157's launch-time migration - on an UNDECLARED server, migrationPinFor sets aside the container it may not act on and reasons "no container -> newest"; migrateBasePin inside doEnsure writes {pinned: newest} to the registry BEFORE refuseForeign refuses the launch; after the user declares and restarts, the next idle launch recreates the legacy container on v1 though nobody adopted v1 (the deploy-order slip the design warns about).
  FIX for c3 (one rule in the authority, not per-path guards): every exec the authority issues or grants - the liveness probe, the force reap, a lease's exec, a probe exec - and forceDrain itself require a container this instance may act on (mayActOn of its owner label); unreadable identity files fail binding loudly instead of being replaced. Must-FAIL: new I17 (copy of the data dir with inherited lease files force-stops the project): fixed - stop refused foreign-owner in 30 ms, no exec/probe/reap grants, live tool alive; variant (current tree + pre-fix lifecycle.ts + instance-owner.ts) - the live tool is KILLED (after=false) and the copy's server exits 13 (unsettled). New I18 (identity file chmod 000): fixed - binding fails, same id afterwards, nothing set aside; variant - replaced by a fresh id with legacyKey null, original set aside. Executed after the fix: npm run gate exit 0; authority S+R 29/29, I+O 22/22; bug-214-218 38/38; feat-112 17/17; feat-157-server 26/26 (no --shots); feat-157-lifecycle L13,L13b-d,L16,L17,L17b 7/7. Round 4 launched: c4 re-attacks the c3 fix and round 2's untested framing (two-break STOP).

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 927afc0e-8a40-4f77-b405-0af2bfeca07e — VERDICT: BROKEN — c3 r3 (one server per data dir, design B): ONE break - a copy of the data dir inherits lease files; its force-stop reaped the original's live tool via an unowned authority exec. Fixed (ownership on every authority exec), must-failed (I17/I18).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 07be0e78-c495-4e38-bbb3-5ff485e78a8b — VERDICT: HOLDS — c4 r4 (c, re-attack of c3 fix + r2 framing): HOLDS, partial. Undeclared default-path server via real routes refused all; declared control acted. SAFE-FAIL by reading: st_dev drift after reboot would make the live dir a copy (fresh id). Copy framing only via I17.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — worker
- **verifying round 4 — c4 HOLDS (partial); lane stopped on b/d two-break STOP:** c4 run 07be0e78-c495-4e38-bbb3-5ff485e78a8b HOLDS (partial): round 2's untested framing run end to end through a REAL server's routes - an undeclared data dir at the default path in another mount namespace, same legacy key and project ids, facing an old-key session container + sidecar + network with a tagged process and unlabelled session/sidecar/network/volume: start, stop, stop?force=1, rebuild?force=1, remove?force=1, orphan sweep, DELETE?force=1 all refused foreign-owner, before/after snapshots identical; non-vacuity: after declare the same server removed them. Fixer I13/I14/I16/I16b/I17/I18 passed in its room. SAFE-FAIL found by reading (not run): identity and marker bind to (st_dev, ino); on this host the data dir is btrfs with an anonymous st_dev (30) assigned at mount time, so a reboot that changes it would make the LIVE data dir read as a copy - identity set aside, a fresh id without legacy key, the marker no longer matching - and the live server would refuse all its own containers until repaired by hand. Not fixed (needs a decision: e.g. bind to inode + a filesystem-stable id, or fail loudly instead of re-identifying on a dev-only mismatch). COSMETIC: routes return 500 for foreign-owner, not 409. Off-property: session-host records are inherited by a copy (survival.ts ownerEntitlesAdoption), direct sessions only. Lane state: STOPPED on the two-break rule for (b) and (d) (round 3); (a) HOLDS (a3), (c) HOLDS after the c3 fix (c4, partial). bug-216 suite not re-run after the merge: it refuses while the sandbox holds another tester's container (claude-station-f90, not mine); last run 23/23 before the merge. Attack gateway stopped; no attacker processes or sandbox objects of this lane remain.

### 2026-10-02 — orchestrator
- **Decision:** Decisions (orchestrator, 2026-10-02), each a single-authority answer, not a guard: (b-i) the SERVER never starts the sandbox: remove ensureSandboxUp from server paths; sandbox down -> server-side lane spawns fail loudly ('run npm run sandbox:docker -- up'), never fall back to the host; the sandbox CLI stays a separate user/lane tool outside the server's claim; the static scan extends to scripts/lib modules the server imports. (b-ii) 'does this image carry the host CLI' is ONE function: bytes checked once per immutable image ID, cached by ID; status, prune keep-set and launch all call it; labels never trusted for it. (d-i) a pin resolves to an immutable image ID/digest at adoption, never a tag; legacy pins recorded by ID at migration. (d-ii) a refused operation writes no state: pin and migration writes are committed by the authority only inside the admitted operation, after the ownership check. (reboot) identity binds to inode + a stable filesystem id (filesystem UUID, not the device number); any mismatch fails loudly with a repair command, never mints a new identity silently; proof: a device-number change with the same UUID still claims, a different UUID refuses loudly. Then ONE final concurrent jailed round on (b), (d), (c reboot case); re-run bug-216 when the sandbox is free; don't touch claude-station-f90. Final round: any new break -> STOP and report the class, no more patches.

### 2026-10-02 — worker
- **fixing — final-round decisions built (b-i, b-ii, d-i, d-ii, reboot); final round launched:** Final-round fixes built per the orchestrator's decisions (each in the one place, no per-path guard):
  (b-i) scripts/lib/lane-docker.mjs: ensureSandboxUp and its generic runner REMOVED; sandboxAnswers/sandboxAnswersSync spawn a literal read-only `docker info`; requireSandboxUp throws SANDBOX_DOWN_MESSAGE (code sandbox-down). agent-bridge.ts startSessionAdmitting: a new direct session on a sandbox-declared project with the sandbox down fails loudly (fatal error event); the constructor no longer starts anything. dispatch-broker.ts: a lane on a sandbox-declared project with the sandbox down is refused (finish 'sandbox-down'). Static scan (scripts/lib/arch-022-static.mjs) now follows every import of the server out of src/ (scripts/lib), allows only literal docker READS there, and no longer allows node children (process.execPath) everywhere: each is listed with what it runs. New S4: three synthetic server-imported lib bypasses caught (node child running the sandbox CLI, docker create, a computed-binary runner), a literal read and an un-imported lib pass; S4c MUST-FAIL anchor: the tree with the pre-(b-i) lane-docker.mjs is caught (the old scanner reported 0). Unit: a dead sandbox socket -> sandboxAnswersSync false, requireSandboxUp throws sandbox-down; ensureSandboxUp no longer exported. Not run end to end: a direct session start against a down sandbox through a real server.
  (b-ii) container-manager.ts carriesHostCli(ref): THE one answer, bytes proven once per image id, cached by id, 'unknown' until proven (proof needs an operation); runtimeImageNameFor (status, imageNameFor), resolveImage (launch) and the prune keep-set all ask it; on 'unknown' status names the CLI layer and the keep-set keeps parent AND layer. Must-FAIL: attacker b's own repro (b-exp2): pre-final tree divergence=true, keep-set lacks the launch image; fixed tree divergence=false, keep-set has it.
  (d-i) base-releases.ts: BasePin/ParsedPin/Target carry imageId (sha256). Migration records the immutable base id (the container's own image when it runs the base tag; else the label-claimed base proven by layer ancestry). basePlanOf: an id-bound pin names the id for station projects; a Dockerfile build must find its base tag still naming the pinned id (else base-image-moved); a legacy id that is gone refuses (base-image-missing), never substituted; a release id that is gone is rebuilt from its frozen recipe and the new id recorded; a legacy pin WITHOUT an id whose container runs a layer is never followed (recovery: kept). The authority records the resolved id on the stored pin only inside the admitted operation after success (recordPinImage). Prune keeps every tag of a kept image id. Layers built over an id stamp the pin's base-ref. Must-FAIL: attacker d's repro exp1 (legacy pin + CLI layer + moved tag): pre-final HARM (recreated onto other bytes), fixed held (same container id).
  (d-ii) doEnsure: ownership is the operation's FIRST question (refuseForeign on the container and its swap names before anything is decided); migration is planned in memory (planBaseMigration) and committed only after the operation succeeds; a container this instance may not act on makes migration undecidable (never "no container -> newest"). Must-FAIL: attacker d's repro exp2 (undeclared Start, then declare): pre-final stored pin={"pinned":1,...} and the container moved to v1; fixed: stored pin=null after the refused Start, both containers kept after declare (legacy pin then bound with its image id).
  (reboot) instance-owner.ts: identity schema 2 binds to inode + a stable filesystem id (findmnt UUID; btrfs adds the subvolume via statfs f_fsid; no UUID -> f_fsid -> st_dev), never the device number. ANY mismatch (place, unreadable, unparseable) throws IdentityMismatchError naming the repair; nothing is set aside or minted silently. scripts/orchard-live-instance.mjs gains rebind (same instance at a new place: identity + marker rebound, id and legacy key kept) and reidentify (a copy: fresh id, no legacy, marker set aside). The marker binds to the same place; a mismatching marker is not live and the boot says so loudly. Schema-1 files whose dev+ino match are upgraded. Must-FAIL: new I19 - same UUID with the device number changed still claims as the same declared instance; another filesystem id refuses loudly naming rebind, rewrites nothing; after rebind the same id is live again; pre-final: the device change minted a NEW id and lost the live declaration (dev-changed=new id/live=false). I14 now: a copy refuses loudly; after reidentify it is separate (pre-final: silently re-identified). I17 adapted (reidentified copy with inherited leases: nothing reaped).
  Suites on the final tree: npm run gate exit 0; static scan 0 findings over 152 files; authority S+R 34/34, I+O 23/23; feat-157-policy 36/36; feat-157-lifecycle every section passes (L0-L4e 10, L5 9, L6 2, L7-L9 6, L10 1, L11-L13d 7, L14-L17b 5 - run in groups); feat-157-server 38/38 with UI; bug-214-218 38/38 (S2's drift-REASON text check widened: before a launch proves the rebuilt image's CLI, status reports the CLI layer instead of "was rebuilt" - the KEPT property is unchanged); bug-107 23/23; feat-112 17/17; feat-155-image-env-policy 15/15; feat-151-container 6/6; feat-151-runtime-update 76/76. bug-216 not runnable: the sandbox still holds another tester's container (claude-station-f90, not touched). bug-223 suite not run (it reads/acts on the host daemon; out of this lane's sandbox-only rule). Final round launched: b5, d5, c5 (reboot/place), jailed, concurrent, two-break STOP.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run d76fb3a7-fe86-4479-a220-2423f64acacf — VERDICT: BROKEN — d5 FINAL (FEAT-157): HOSTILE HARM - a session user symlinks the CLI via /proc/self/root so docker cp -L cannot read it; unreadable = keep AND admit, so new sessions start on a foreign CLI. (A)/(B) re-attacks held by reading.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 8a96b1b7-955f-485a-a6e5-a25e3bc1529d — VERDICT: BROKEN — c5 FINAL (place): ACCIDENTAL HARM - a block clone of an ext4 data dir (dd/LVM snapshot) has the same fs UUID + inode, so it binds as the same declared-live instance; regressed-from the reboot fix (dev key refused it). btrfs snapshot/overlay refused.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 31c56ac5-3a75-486c-b6fd-5ebb057b3b55 — VERDICT: BROKEN — b5 FINAL (one place): ACCIDENTAL HARM - in one launch the shared release tag is re-read (pin id, CLI check, layer build); another instance's Rebuild between reads makes the pin name other bytes than the container; next idle launch recreates. COSMETIC: 11 scan-evasion forms.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-02 — worker
- **verifying FINAL round — b, c, d BROKEN once each; STOPPED (no patches):** FINAL ROUND RESULT — STOPPED (orchestrator rule: any new break in the final round = stop and report the class; no patches applied after it). All three properties BROKEN once each, by new paths:
  (b) b5 run 31c56ac5-3a75-486c-b6fd-5ebb057b3b55, ACCIDENTAL HARM. Class: a SHARED MUTABLE NAME read more than once inside one operation (cross-instance TOCTOU). The release base tag (claude-station-base:v<N>-u-g-<hash>) carries no owner key, so every instance on the daemon shares it; resolveImage reads it for the pin's image id, then again in carriesHostCli and ensureRuntimeImage. Another instance's Rebuild between those reads leaves the pin naming different bytes from the ones the container runs, and the next idle launch recreates the container without a notice. The per-project authority serialises one instance, not the daemon. The same attacker found the static scan misses 11 evasion forms (spawn('node', …), getBuiltinModule, createRequire, wrappers, the docker.sock API, computed import, workers, process.binding, .cjs). This is COSMETIC today because no server code uses them, but the claim was stronger than the scan.
  (c) c5 run 8a96b1b7-955f-485a-a6e5-a25e3bc1529d, ACCIDENTAL HARM, regressed-from: this lane's "reboot" fix. Class: identity by PLACE cannot tell a block-level clone from the same directory. An ext4 clone (dd, disk image, LVM snapshot) mounted beside the original has the same filesystem UUID and inode, so both bind as the same declared-live owner key (the device-number key had refused it). btrfs snapshots, overlay copies and bind mounts were refused or single-owner as designed. Inherent tension: surviving device-number drift and detecting block clones pull in opposite directions while identity is derived from where the directory is.
  (d) d5 run d76fb3a7-fe86-4479-a220-2423f64acacf, HOSTILE HARM. Class: an UNKNOWN observation treated as a pass at admission (fail-open). A session user turns the CLI path into a symlink through /proc/self/root, so `docker cp -L` cannot read it; an unreadable CLI means "keep the container" (round-3 decision: never recreate on an unreadable answer), but admission still grants the lease, so new sessions start on a foreign CLI. The (A)/(B) framings (moved tags, state from refused operations) held, by reading only.
  Earlier in this round the c3 fix held (c4, partial). (a) held in round 3 (a3) and was not re-attacked after the final-round changes.
  State: every fix described in the previous entry is in the working tree, unstaged. npm run gate exit 0. Static scan 0. All suites listed there pass. bug-216 was NOT re-run: the sandbox still holds claude-station-f90, which belongs to another tester and was not touched. The attack gateway has been stopped, and no attacker processes or sandbox objects from this lane remain.
