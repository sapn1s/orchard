```orchard-ticket
{
  "id": "FEAT-200",
  "type": "feature",
  "title": "A container session cannot ask the user for host access",
  "summary": "A container session that needs something its container lacks (a host database URL, a published dev-server port) has no way to ask. This adds a request the agent raises from inside the container, a distinct-colored approve/reject card, and on approval the setting is saved, the container rebuilt at idle, and the session resumed with the outcome.",
  "impact_if_we_wait": "Container agents cannot reach host services or expose a dev server, so they either stop or work around the sandbox.",
  "current_need": "IV r12 (anthropic 8ac3c8fc) BROKEN: same gone-incarnation property, new door. outbox.ts gates the BUG-284 incarnation guard behind if-not-running, so a granted row delivered via a running bridge skips it (r8 redux). Stopped per section N; structural choice owed.",
  "severity": "medium",
  "area": "container / server / ui",
  "reported": "2026-10-27",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An agent inside a container raises an env or 127.0.0.1 port request; nothing is written until the user approves",
    "Approve or reject is a user-only typed decision; an agent caller is refused with agent-not-user and nothing changes",
    "On approve the container is recreated at idle by the FEAT-175 reconciler with the env and a 127.0.0.1-only publish",
    "The requesting session is resumed with access granted or denied text after the decision takes effect",
    "A host port already used by another project, container or host process is refused and shown on the card",
    "The card has its own color in light and dark themes; only container sessions get the injected instructions"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-175",
      "relation": "see_also"
    },
    {
      "id": "FEAT-112",
      "relation": "see_also"
    },
    {
      "id": "FEAT-155",
      "relation": "see_also"
    },
    {
      "id": "FEAT-108",
      "relation": "see_also"
    },
    {
      "id": "BUG-284",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "4c8e506c-465e-4677-9ec9-b6de804747f3",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T11:36:38.400Z",
      "author": "worker (FEAT-200 fixing r1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "a9c3269ce2cac4131675a2e8921a4fe656b8f90fc485655398a49bfa3da37be3",
      "verify_mode": "mixed-state",
      "note": "r1: agent PATCH of container.image / container.dockerfile was not gated (200, saved), so an image baking a non-reserved ENV (MONGODB_URI) puts env in the container without an approval. openai quota hit; fell back to a fresh Claude clean room."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "1aa81581-ce3d-4c3f-8985-c382c352553e",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T11:45:40.066Z",
      "author": "worker (FEAT-200 fixing r1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "638abe522fda7654503d5984098158a3c06aff725fb62073a0bbb3342041d959",
      "verify_mode": "mixed-state",
      "note": "r2: (a) held. (c) broke twice by different doors: IPv6-only listener reads free; port taken after approval bricks the idle recreate. (e/f): inbox flood quarantines the store and loses an approved record."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a17e35-a01f-7ba1-a870-5ec25477de8e",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T16:36:02.652Z",
      "author": "worker (FEAT-200 fixing r3)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "204127a179e12eea3944b893a2c5241259524203af04ecc4b9e9ce4f29fd7bcc",
      "verify_mode": "mixed-state",
      "note": "r3 (cross-provider): collision doors not broken; the revert broke: two pending requests both set K=new (previous old) with different ports; A's port refused -> revert restored K=old over B's independent approval. Value-only CAS; the design review had specified per-key provenance."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "2aa4e78b-39fe-44e8-b8fc-717277c79a22",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T17:21:15.038Z",
      "author": "worker (FEAT-200 verifying r4)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "d2664eab363ddb6deed80b811e5b9c9c3169dee584634bc9e079183bbb004156",
      "verify_mode": "mixed-state",
      "note": "r4 TWO-BREAK on the revert: A's revert removed a free port independent approval B also set (no port provenance); B not told. A contract-invalid r4 room also showed 2 env doors (stale provenance, chained refusals). Bypass + loopback held. openai quota; Claude fallback."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "9095680c-5a75-4dd4-9bee-335c128deac7",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T20:26:46.170Z",
      "author": "worker (FEAT-200 fixing r5)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "4db09b1f5408b5c996b0d572f6dbe57ee80ea0660cbf0cbb76409543a7544956",
      "verify_mode": "mixed-state",
      "note": "r5 commit-on-success: the four recorded doors HELD; a NEW door broke \"a user edit is never undone\": the stateless supersede rule misses user edit SEQUENCES (K old->new->old, add-then-delete, add-then-remove a port) while a request is approved-pending; the commit re-applies it."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "91a246ca-617a-42fd-bcbf-39a2e75a4b0c",
      "verdict": "broken",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T21:48:40.068Z",
      "author": "worker (FEAT-200 fixing r6)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b6e1464d2486511c45c659ee20d71a4b3b06b30817fb38b197b4cb280849d7ca",
      "verify_mode": "mixed-state",
      "note": "r6: all 7 docker blocks HELD (U,Y,X,G,P/R,B,L); user edit held. BROKEN: commit two-write window (settings written, record mark lost by crash/store EACCES) then a user edit of one named key -> told \"cancelled, never written\" while its port is in settings+container. openai quota; Claude."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "7b08ede8-3ba6-400d-be94-73289a604b4f",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T01:26:14.675Z",
      "author": "worker (FEAT-200 fixing r7)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "d7d509dba02c976264c2ec5431478f7b16bf4a208db73117f53dcc0c8574e6bf",
      "verify_mode": "mixed-state",
      "note": "r7: all 8 docker blocks HELD (C,U,Y,X,G,P/R,B,L); forged accessCommitted held. BROKEN, new door: commit lands, store mark lost (EACCES), project DELETED and RE-ADDED under the same id -> told \"cancelled ... never written\". openai quota mid-run; Claude."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ec528a8a-3277-4fff-b357-14bd29e61d53",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T04:28:49.100Z",
      "author": "worker (FEAT-200 fixing r8)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "3f303796f1322bae218fc5a28681777c04e884cad08f1b9e453bcc0da5f1bccc",
      "verify_mode": "mixed-state",
      "note": "r8: 9 docker blocks HELD (D,C,U,Y,X,G,P/R,B,L), fixer 92/0. BROKEN: granted already QUEUED in the outbox (held), then delete+re-add; the outbox resumed the old session into the new project, delivered granted (run 8216df1bf6c7). openai quota; Claude fallback."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "2af93888-5e21-462c-b404-86dc8723fbdb",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T06:51:56.047Z",
      "author": "worker (FEAT-200 verifying r9)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "a870933b4654ffd985efc68c8100bc0093cfa1c47539c588f04ff6d5c52f4f6d",
      "verify_mode": "mixed-state",
      "note": "r9 combined tree (FEAT-200+BUG-284): all 15 docker blocks HELD incl Q,QR; outbox doors 9/0; fixer 92/0. BROKEN: a committed request queued then delete+re-add: row correctly failed, but the card reads \"resume message could not be delivered - open the session\", not \"not sent\". openai quota; Claude."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ee013774-874c-471f-ba90-332f2b403294",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T07:29:41.869Z",
      "author": "worker (FEAT-200 fixing r10)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c5c1723f6bae02e2e7d393b09e993a65c9c97639a95f7b4cb16ebb01dc417ba1",
      "verify_mode": "mixed-state",
      "note": "r10 narrow IV: card text + limit counting HELD (unit 98/0 incl CV). BROKEN: cancelByUser 409 TEXT for final+gone records: closed-removed undecided says 'reject it instead' (reject is refused project-removed); committed+re-added says 'already applied and saved'. Docker blocks not run by IV."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "8ac3c8fc-d36a-433e-a658-ac347f0bd5f2",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T08:21:17.161Z",
      "author": "worker (FEAT-200 verifying r12)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b2a92332a4aaad5a24e00993e6e858403c001da27c6e249686b67fb57de5654f",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "f1c813d6-e63d-44ec-9d2b-04356365b843",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T09:11:17.207Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "cf6eaa9db018e5025a17019d7b75c00802d88a9c356d8f2544488a5c1d2e6270",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a184bc-4509-7cb0-bd25-ae9ca4c70e90",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T23:32:15.612Z",
      "author": "dispatch openai (r10 bookkeeping)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID manifest-backed. Outbox refuses removed project incarnations across running+idle routes incl. after registry-read failures; adversarial mixed-incarnations-registry-recovery PASS."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
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

# FEAT-200 — A container session cannot ask the user for host access

## What the user asked for

A container-mode session finds that its project needs something the container lacks: a host
service such as MongoDB, or a published dev-server port. The flow:

1. The agent works out what it needs.
2. It creates a request.
3. The user approves or rejects it on a card in the UI. The card works like the command-permission
   approval card, in a different, distinct color so it reads at a glance as a container-access request.
4. On approval the change is written to the project's container config and the container is rebuilt.

Every container-mode session gets launch-time instructions (src/server/templates.ts) on WHEN and HOW
to make a request. Direct sessions get none.

Decided by the user (not re-opened here):
- The agent never applies a config change itself. The request is the only path; the user's approval
  is the only writer (the answer-route `agent-not-user` / FEAT-175 grant pattern).
- v1 scope: (a) container env vars, (b) publishing a container port on 127.0.0.1 only, never 0.0.0.0.
  The request type is extensible; only these two kinds are built. The card shows exactly what changes,
  what becomes reachable, and the agent's stated reason.
- Requesting ends the agent's turn with a clear "waiting for approval" state. On approve the setting is
  persisted and the container is recreated at idle by FEAT-175's level-based reconciler; env/ports become
  part of its desired state; no second recreate trigger. "Rebuild now" still forces it. After the rebuild
  the requesting session is auto-resumed with "access granted: <what>, continue"; on reject with
  "denied: <what>". The decision is a typed record, not prose.
- Publishing must not collide with or steal another project's host port: refuse, and say so on the card.

## Hypothesis check (done before planning)

- `container.env` exists (FEAT-155): written by `createArgs` as `--env`, drift-checked in
  `driftReasons` (subset + `claude-station.env-keys` label). So env needs no new create plumbing.
- Ports have no plumbing at all; `createArgs` is the single place create flags are composed, and
  `driftReasons` the single drift oracle. Ports go into both. (`desiredBinds` is binds only, so the
  charter's guess "ports go in desiredBinds" is corrected: they go in createArgs + driftReasons.)
- The reconciler CAN carry env/ports without a second trigger: BUG-254 r4 already added an orthogonal
  non-holding recreate reason (`readCredDrift`: clean | stale | unknown) to the same level-based loop.
  Access drift is added the same way: a second optional level read, recreate-when-idle, never holds
  turns, unknown is retried and never acted on. No edge detection, no pending-state file, no per-path hold.
- The in-container agent has NO channel to the host today: the server listens on 127.0.0.1 only and
  in-container git is not shimmed. A channel is required (see plan, item 2).

## Plan

1. **Model — `src/server/access-requests.ts` (new).** A typed, persistent store
   (`<data>/access-requests.json`, writeAtomic, BUG-202 quarantine-on-unreadable like decisions.ts).
   `AccessRequest { id, projectId, projectName, sdkSessionId, reason, changes: AccessChange[],
   conflicts: string[], createdAt, decision: { verdict: 'approved'|'rejected', at, by: 'user' } | null,
   resume: { state: 'waiting'|'queued', at, text } | null }`.
   `AccessChange = { kind:'env', key, value, previous } | { kind:'port', hostIp:'127.0.0.1', hostPort,
   containerPort }` — a discriminated union, so a later kind is one more arm. A record is decided ONCE.

2. **Agent channel — a per-project unix socket served by the server, reached with curl.** The socket
   lives in the project's session-history dir, which is ALREADY bind-mounted rw into every container
   (`<home>/.claude/projects/<store>/.orchard-access.sock`). Chosen over a new bind because a new bind
   would be "missing bind" drift on every existing container at deploy, refusing new launches in every
   project with a live session (BUG-214 class). The server speaks minimal HTTP on it:
   `POST /v1/access-requests` (raise) and `GET /v1/access-requests/<id>` (read own status). There is NO
   decide endpoint on the socket: approval is structurally unreachable from the container.
   The socket path is per project, so the project identity is structural; the session id comes from the
   `X-Orchard-Session: $ORCHARD_SESSION` header and must name a live session of that project. The exec
   env gets `ORCHARD_ACCESS_SOCK` (exec env is not create-time config, so no drift). The listener is
   (re)ensured on boot, on container ensure and on a slow tick; it never unlinks a socket another
   process is listening on (a scratch server sharing a HOME cannot steal the live server's channel).
   Paths are declared once next to the history bind in container-manager.

3. **Server routes (main HTTP, 127.0.0.1).**
   - `GET /api/projects/:id/access-requests`, `GET /api/sessions/:sid/access-requests` (read).
   - `POST /api/projects/:id/access-requests/:rid/decide { verdict: 'approve'|'reject' }` —
     `requireUserCaller` FIRST (403 `agent-not-user`, nothing written), 409 if already decided, approve
     re-validates the changes and re-checks port conflicts (409 + the conflict, record stays pending),
     then merges env keys / ports into project settings through `validateProjectPatch` + `updateProject`,
     records the typed decision and nudges the reconciler. Reject records the typed decision and queues
     the "denied" resume at once.
   - Project PATCH: a change to `container.env` or `container.ports` now requires `requireUserCaller`
     (same as the path change), so a host agent cannot bypass the card through settings.
   - Also close FEAT-112's sibling hole: the services-proposal answer was not user-gated; it now is.

4. **Ports — `container.ports: [{ hostPort, containerPort }]`.** Validated (integers; host 1024-65535;
   unique host ports). Host IP is not stored: `createArgs` always writes `-p 127.0.0.1:H:C`, so a
   non-loopback publish is not expressible. Drift compares the container's actual PortBindings
   (HostIp must be 127.0.0.1) with desired; one helper `accessDriftReasons(project, live)` is used by both
   `driftReasons` and the reconciler's level read, so the env/port fact is computed in one place.
   **Collision check** (raise, approve): another registered project declares that host port; another
   container on the daemon publishes it; or something on this host already listens on 127.0.0.1:H
   (unless it is this project's own container). A conflict is shown on the card and approval is refused.
   **Swap path:** a Dockerfile project's swap creates `.next` while the old container runs; with a
   published port the new one could not start and the image would wrongly be marked bad. When ports are
   involved the old container is stopped before the new one starts (restarted on failure), and a
   port-allocation failure never marks the image bad.

5. **Reconciler — `grant-rebuild.ts`.** Optional dep `readAccessDrift(p): clean|stale|unknown`, handled
   exactly like `readCredDrift`: stale → pending, recreated when every session is idle, never holds turns;
   unknown → pending, retried, never recreated on. Rail texts name the access reason. "Rebuild now" works
   unchanged.

6. **Resume on decision — level-based, never edge.** A checker (on reconciler `settled`, on decide, and
   every few seconds) walks decided-but-unresumed records. Reject → queue now. Approve → queue only when
   the project's access drift is `clean` (container matches desired, or no running container — then the
   resume's own ensure creates it with the new config). The text is computed at queue time from what the
   container actually has ("access granted: MONGODB_URI, 127.0.0.1:3000 → container 3000. Continue." or,
   if the user has since changed it, says so). Delivery uses the durable outbox (idempotent nonce
   `access-<id>`, resume route for a closed session), so a restart or a closed session does not lose it.
   A stuck rebuild is already a reconciler card; the session card says "approved — waiting for the
   container rebuild" with the reconciler's own message, so it is never a silent hang.

7. **Turn end.** The socket's 201 reply tells the agent to end its turn now; the injected instructions
   say so; the session shows the access card as its waiting state. No forced interrupt (an interrupt
   could cut a tool result). If the agent keeps going, the reconciler simply waits for idle.

8. **UI.** `.ask.access` card in the session's asks area (same shape as the permission card), and a
   `needs-card.access` on the Needs-You rail, both in a new `--access` hue (muted violet; defined in all
   four theme blocks) that no other card uses. It lists each change, what becomes reachable, the reason,
   any conflict (Approve disabled), and Approve / Reject. After a decision it shows the state (waiting for
   rebuild / resumed). Drawer: published ports are listed and removable next to env.

9. **Injected instructions — `containerAccessSection()` in templates.ts**, appended for container
   sessions only, static text (FEAT-113 byte-stable prefix): when to ask (a host service, a dev-server
   port; not for things installable inside), how (the curl line), what is refused (reserved env names,
   ports <1024, non-loopback), and "end your turn after raising; you are resumed with the decision".

## Security property for the plan reviewer

No path lets an agent (in-container or on the host) persist an access change without a user approval.
Paths to attack: the socket (raise-only); the decide route (requireUserCaller); project PATCH
(env/ports gated); the generic board answer route (access records are not decisions there); the
services-proposal answer (now gated); direct registry-file writes by a same-uid host process (residual,
same class as FEAT-164's named residuals; a container cannot reach the registry).

## Verification plan

- Unit: reconciler with access drift (recreate when idle, never under a busy session, unknown never
  recreates, no hold); validation (ports, reserved env); collision.
- E2E in the FEAT-158 sandbox, scratch server (`isolatedServerEnv`, `CLAUDE_STATION_DATA`), fake
  in-container CLI that raises the request FROM INSIDE the container with curl over the socket:
  MONGODB_URI + port 3000 → approve → container recreated (`docker inspect`: env present, PortBindings
  HostIp 127.0.0.1 only) → session resumed with the granted text. Reject → "denied". Agent-caller
  refusal (403 agent-not-user from a process in a session scope / server descendant). Port collision.
  Busy session: no recreate until idle.
- Must-FAIL: the same suite against the pre-change tree.
- Playwright screenshots of the card in light and dark themes.
- Independent verification (`scripts/independent-verify.mjs`), attacking self-approval/bypass,
  non-loopback publish, collision, recreate while busy, resume not firing.

## Risks

- The socket sits in the transcript store dir. Readers filter `*.jsonl`; it is a dotfile.
- A unix socket path is limited to 107 bytes; a very long project id could exceed it on the host. The
  listener reports that loudly and the request path says the channel is unavailable.
- Between approval and the idle recreate, a NEW session start on that project with others live is
  refused exactly as any env change is today (FEAT-155 behaviour, unchanged here).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-27 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **plan review + dispositions:** **Plan review (independent, cross-provider): dispatch openai run (FEAT-200 finding r1, read-only), VERDICT PLAN-BROKEN, 13 findings.** Raw output kept at scratch feat-access/review-out.md. Dispositions, all adopted before building:
  1/2/4 (creation, mounts, dockerSocket, isolation, services bypass the card): project CREATE and PATCH now require `requireUserCaller` whenever the normalised patch touches an authority-expanding field: `container.env`, `container.ports`, `container.dockerSocket`, `mounts`, `services`, `isolation`. The FEAT-112 services-proposal answer is gated too; `acc-` ids are refused on the generic board answer route. Docker-socket ON is a user-granted root-equivalent and stays the explicit scope boundary (a container holding it can publish anything; said on the card's project and in the ticket).
  3 (requireUserCaller is not absolute): adopted as a BOUNDED threat model, the same one FEAT-164 option A accepted: an agent is a process in a session scope / server descendant / server service cgroup; residuals named: a same-uid host process that escapes its scope, relays through a user process, puppets the user's browser, or writes the registry / store files directly. A container cannot reach the registry or store (not bound) unless the USER mounts the data dir.
  5/6 (socket in an agent-writable dir: replaceable, path-length limit, shared HOME): channel CHANGED to a flat file inbox in the history dir root: the agent writes `.orchard-access.<session>.<nonce>.json` (tmp + mv); the server polls, opens O_NOFOLLOW|O_NONBLOCK, requires a regular file <= 64 KiB, raises, deletes it, and writes a courtesy reply `....reply` with O_CREAT|O_EXCL|O_NOFOLLOW. Flat (no subdirectory) so the ONLY agent-controlled path component is the last one, which those flags cover; the history dir itself is the bind source and cannot be swapped from inside. No path-length limit; works without curl. Authoritative status lives in the data dir. Shared HOME + same project id on two servers: either may raise the card, the user still decides (named residual). Session id in the name establishes membership not identity: sessions sharing one container are one trust domain (same uid, same filesystem); naming a sibling only redirects the resume message, and the card names the session.
  7 (multi-file crash window): approval writes the typed decision INTENT first (`decision` + `applied:false`), then settings, then `applied:true`; boot recovery re-applies an intent that never reached `applied` (idempotent merge). Approval is refused (409) if a key's current value no longer equals the `previous` the card showed.
  8/9 (truthful delivery, frozen payload): the resume text is computed once and FROZEN in the record before the outbox row is created; retries reuse it (stable nonce `access-<id>`). Approve queues only when access drift is clean; a resumed session goes through the resume route, which ensures the container (recreating a stopped one) before the turn. The card reads the real outbox row state (queued / delivered / failed / uncertain / discarded), never "queued = resumed". Named residual: a settings edit after queueing and before delivery.
  10 (collision writers, race): every writer that sets ports (create, PATCH, approval) runs the same collision check; docker start stays the final authority: a late conflict is a reconciler failed card with docker's error, the approval is kept. Own-container exemption only for the exact 127.0.0.1:H binding the container holds. TCP only; unknown fields refused.
  11 (swap recovery): restart condition fixed (`!live.running || stoppedForPorts`); the initial-create `markImageBad` also exempts port-allocation errors; interrupted swap is handled by the existing `.next` recovery (old stopped container is kept, `.next` removed, normal drift recreate follows).
  12 (reconciler spec): access drift is folded into every place cred drift is read (pending update, failed clear/downgrade, drive eligibility, the "why" text, rail items); access `unknown` for > 2 min gets its own rail card; approval never passes forceOver.
  13 (tests): adversarial cases added to the verification plan: create/PATCH gates, mounts/socket/isolation gates, inbox symlink/FIFO/oversize/truncated files, changed `previous`, frozen payload, late port allocation.

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **built + fixer verification:** **Built (fixing r1), all unstaged.** Plan review was openai thread 01a17c9d-a547-7d41-9fed-1357dccb1a1e (PLAN-BROKEN, 13 findings, dispositions in the previous entry).
  - New: `src/server/access-requests.ts` (typed store: decision intent -> applied, decided once, frozen resume text, BUG-202 quarantine), `src/server/access-channel.ts` (raise-only inbox poller with hostile-file defences; one port-collision check for every writer; level-based resume checker), `scripts/verify-feat-200-access-unit.mjs`, `scripts/verify-feat-200-access-requests.mjs`, `scripts/fixtures/feat-200/fake-container-cli.mjs`.
  - Changed: `container-manager.ts` (ports in createArgs as `-p 127.0.0.1:H:C` only; one `accessDriftReasons` shared by driftReasons and `accessDriftOf`; `liveAccessOf`, `publishedHostPorts`; inbox paths + `ORCHARD_ACCESS_DIR` exec env; swap path stops the old container when ports are involved and restarts it on failure; a port-allocation error never marks an image bad), `grant-rebuild.ts` (`readAccessDrift` folded into every cred-drift site; access-unknown card; reason-aware messages; `phaseOf`), `index.ts` (wiring; user-only decide route; GET routes; rail items; PATCH/create gates for env/ports/dockerSocket/mounts/services/isolation; services-answer gate; `acc-` refused on the generic answer route), `templates.ts` (`containerAccessSection`), `agent-bridge.ts` (appended for container sessions only), `registry.ts`/`validate.ts` (`container.ports`, `validatePorts`), `events.ts` (`access-request` event), `public/app.js`/`styles.css`/`lib/api.js`/`lib/drawer.js` (session card + rail grid tile + rail answer card in a new `--access` violet, defined in all four theme blocks; drawer "Published ports"), `docs/CONVENTIONS.md` (one sentence: the reconciler's third level fact). `scripts/verify-bug-254-reconciler-unknown.mjs`: its verbatim-pinned hunks updated to the new text (same pre-fix semantics).
  - Hypothesis verdict: CONFIRMED with one correction. The reconciler carries env/ports as a third level read exactly like BUG-254's credential (no second trigger, no per-path hold). Ports belong in createArgs + driftReasons, not desiredBinds. A NEW finding the charter did not anticipate: the container had no channel to the host at all; the inbox in the already-bound history dir provides one with no new bind (a new bind would have drifted every existing container).
  **Verified (fixer's own runs, sandbox daemon):**
  - `verify-feat-200-access-unit` 58/0. Must-FAIL: against the pre-lane grant-rebuild.ts, 8 reconciler properties FAIL (R1, R4-R8, R10, R13).
  - `verify-feat-200-access-requests` full run 47/0 (I, A, K, L, G, P, B, R, SHOTS). Must-FAIL against a pre-lane copy of the tree: I/K/L 12 of 17 FAIL; G 8 of 10 FAIL — on the pre-lane server an agent-scope process could turn the docker socket on (200), move the project out of the container (200) and create a project carrying env (201).
  - Real-artifact cases: the machine really has 0.0.0.0:3000 in use; a request for host 3000 was raised from inside the container with the conflict on the record and approval refused 409. `docker inspect` after approval: `Env` has `MONGODB_URI=mongodb://host.docker.internal:27017/app`, `HostConfig.PortBindings={"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"<free port>"}]}`. The resumed session received `[station] access granted: env MONGODB_URI=…; port 127.0.0.1:<p> → container 3000, continue. The container was rebuilt with it.` and its process env showed MONGODB_URI. Reject: `[station] denied: env SECOND_DB=…`, no recreate. Busy: approved during another session's 60 s turn, container id unchanged for 10 s of sampling, recreated only after that turn ended.
  - Partial/hostile inbox reads (unit C1-C13): symlink, FIFO (no hang, 4 ms), oversize, a young truncated file left for the next poll then raised once completed, an old one refused, a planted reply symlink neither followed nor overwritten.
  - Screenshots (both themes, Playwright + brave): docs/bugs/assets/FEAT-200-session-card-{light,dark}.png, FEAT-200-rail-card-{light,dark}.png (git-ignored local evidence).
  - Anti-regressions: feat-175 unit 48/0; bug-254 r9 31/0, reconciler-unknown 9/0, r7 2/2; feat-113 system-prompt-stable 11/11; feat-112 services 17/0; feat-164 self-grant 65/0; feat-157-policy 36/0; feat-102-static 10/0; bug-091 21/0; feat-175 e2e 44 pass / 6 fail with the SAME 6 (P1s x4, P1r, P6 precondition) failing on the pre-lane copy. Pre-existing, identical on the pre-lane copy (not this change): feat-155-image-env-policy 3 FAIL; bug-118 C1 (PATH carry) 1 FAIL; feat-108 git-request-approve in the confined runner ("live session never started" + one leak-gate check).
  - `npm run gate` exit 0.
  **Found and fixed during the build:** the resume checker read "no container" during the reconciler's own remove→create window and froze the wrong text variant; it now waits while the reconciler holds an entry for the project (unit Q2b). The outbox framed the station message as "composed while the previous response…"; it now uses the "held until the session could take it" framing.
  **Named residuals:** bounded threat model as FEAT-164 (scope escape, relays, browser puppeting, same-uid file writes); docker-socket-ON projects; sessions sharing one container are one trust domain (a sibling can name another session id, which only redirects the resume message); two servers sharing one HOME and project id may both read the inbox (either raises; the user still decides); a settings edit after the resume text is frozen and before delivery; the host-listen probe checks this machine's netns, which equals the daemon's only for the host daemon (true in production; in the sandbox tests, docker's own port list and the registry carry the cross-project case); between approval and the idle recreate, a NEW session start with others live is refused exactly as any env change was before (FEAT-155 behaviour, unchanged).
  **Couldn't test:** a real Claude agent deciding on its own to raise a request (the sandbox cannot authenticate a real CLI; the fake raises it exactly as the instructions say); a direct (non-container) session's launch text (excluded by the `isolation === 'container'` branch, not exercised live); server restart between the decision intent and the settings write (recovery path unit-tested via listUnapplied/abandon only).

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **Verification recorded:** dispatch anthropic run 4c8e506c-465e-4677-9ec9-b6de804747f3 — VERDICT: BROKEN — mixed-state candidate a9c3269ce2ca — r1: agent PATCH of container.image / container.dockerfile was not gated (200, saved), so an image baking a non-reserved ENV (MONGODB_URI) puts env in the container without an approval. openai quota hit; fell back to a fresh Claude clean room.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **IV r1 BROKEN + fix:** **Independent verify r1: BROKEN** (dispatch anthropic run 4c8e506c-465e-4677-9ec9-b6de804747f3, mixed-state candidate a9c3269ce2ca; openai hit its quota window and the harness fell back to a fresh Claude clean room, so decorrelation was reduced this round). The fixer suite re-ran 41/0 in the room. Break (property a, agent bypass): the PATCH/create gate covered env/ports/dockerSocket/mounts/services/isolation but NOT `container.image` / `container.dockerfile`; an agent-scope PATCH set both (200, saved), and the image-ENV policy admits a non-reserved name such as MONGODB_URI, so env could reach the container with no approval.
  **Fix (one class, not one field):** the gate now covers everything that changes what the container RUNS or can REACH: `container.env`, `container.ports`, `container.image`, `container.dockerfile`, `container.dockerSocket`, `container.gpu` (only a move toward more access), `mounts`, `services`, `browser.enabled`, `tools.openaiDispatch`, `isolation`; create is gated the same way. Also hardened: `createArgs` and the drift comparison take only integer, in-range ports, so a hand-edited registry value cannot shape the `-p` argument (unit L1/L2: `["127.0.0.1:4001:3001"]` survives out of five hostile entries; no `-P`/`--network` is ever composed).
  **Rescope, for the next verifier to attack (WA §N option 1):** env BAKED into image contents that the agent already controls (a repo Dockerfile the USER chose to build from) is not an access change this feature can or should gate. The agent controls its own process env inside the container regardless (it can export a variable or write a wrapper script); an env var opens no network path (host.docker.internal is already routable from every container); and image contents cannot publish a port (the only publish path is `-p 127.0.0.1:H:C` in createArgs; no `-P`, no network mode). What the USER owns, and what is now gated, is the project setting that chooses which image or Dockerfile runs.
  **Verified after the fix:** e2e `--only G` 16/0 (new G4b image, G4c dockerfile, G4d gpu, G4e browser, G4f mount, G6b create-with-image all 403 for an agent; user PATCH of an ordinary field still 200). The r1 room's own repro (agent PATCH image/dockerfile → 200) is the must-FAIL for G4b/G4c. Unit 60/0.

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **Verification recorded:** dispatch anthropic run 1aa81581-ce3d-4c3f-8985-c382c352553e — VERDICT: BROKEN — mixed-state candidate 638abe522fda — r2: (a) held. (c) broke twice by different doors: IPv6-only listener reads free; port taken after approval bricks the idle recreate. (e/f): inbox flood quarantines the store and loses an approved record.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 fixing r1)
- **IV r2 BROKEN + two-break STOP on (c):** **Independent verify r2: BROKEN** (dispatch anthropic run 1aa81581-ce3d-4c3f-8985-c382c352553e, mixed-state candidate 638abe522fda; openai still over quota). Fixer suite 41/0 in the room. Property (a), agent bypass: HELD; the verifier found no second path (session overrides, wiring, services, hostPath all gated or project-scope only), so the r1 rescope of image-baked env stands unbroken this round.
  Three findings:
  1. (e/f) inbox flood: about 200 valid max-size request files pushed the store past its 8 MiB read cap; the next raise quarantined it and lost an approved, unresumed record (the session would never be told). FIXED structurally: the agent-driven raise path never quarantines or overwrites. It refuses while the store is unreadable, and undecided requests are capped (3 per session, 8 per project). Only the server recovers an unreadable store, once, at boot. Unit S10-S14: the flood is capped at 8 pending with 192 refused with a reason; the approved record survives and stays in the resume worklist; a torn store's bytes are untouched by a raise. The r2 room's repro is the must-FAIL. Unit 64/0; gate exit 0.
  2. (c) an IPv6-only program on `[::1]:H` reads free: the host probe checks 127.0.0.1 only, so approval proceeds and `localhost:H` may reach that program instead of the container.
  3. (c/d) a host port taken AFTER approval, before the idle recreate: on a station-image project the recreate removes the old container, then docker refuses the bind. No container is left; the reconciler entry goes `failed` and holds every turn and new session in the project.
  **TWO-BREAK STOP on property (c), applied as chartered (WA §N).** (c) broke twice this round through different doors (probe coverage; a late allocation after the check), so I have stopped patching (c) and have added no guard for either. Routing to independent design review. My evidence-backed recommendation for the reviewer: **REDESIGN**. Docker's own start is the allocation authority, and every pre-check is advisory UX (still shown on the card). An access-driven recreate that docker refuses must leave the project's PREVIOUS container running (stop old → start new → on failure restart old: the swap shape this lane already built for Dockerfile projects, extended to every image source when ports are involved). It must resolve the request as "approved, but could not be applied: <docker's reason>" through the same frozen-resume path, and never leave the project container-less or turn-held for an access change. The probe also covers `[::1]` because loopback is two addresses, not as a separate guard. Alternatives for the reviewer to weigh: KEEP PATCHING (probe [::1], treat a non-git failed entry as non-holding); this keeps the brick, because with no container a new session's ensure fails on the same port. RESCOPE ("free the port or remove it in the drawer"); this leaves a project wholly unusable from one taken port, which the charter's "must not collide" rules out. Until the design review rules, the port kind ships with this open: a port that is free at approval but taken before the idle recreate can strand the project.
  **State:** env requests are verified on everything attacked so far; ports are blocked on the (c) design review. No further implementation rounds on (c) without that ruling.
  **Post-fix E2E:** `--only P,R` 22/0 (approve → idle recreate → docker inspect env + 127.0.0.1-only binding → resumed "access granted … continue"; reject → "denied", no recreate). Full run earlier 47/0; G 16/0 after the widened gate.

### 2026-10-27 — worker (FEAT-200 fixing r3)
- **design question for independent review (c):** **Design question (round 3, sent to an independent clean-room reviewer; the r2 recommendation is supplied as evidence, not as a conclusion).** Property (c): an approved 127.0.0.1-only port publish must never collide with or steal a host port held by another project, container or host process, and a collision must never strand the project. It broke twice: (1) TAKEN LATE: free at approval, taken before the idle recreate; the non-Dockerfile recreate path removes the old container before creating the new one, docker refuses the bind, no container is left, the reconciler entry goes failed and holds every turn. (2) IPv6: a listener only on [::1]:H reads free because only 127.0.0.1 is probed. Questions: (a) rescope, redesign, or bounded keep-patching? (b) how does 'the previous container stays running' hold when the recreate removes the old container first: create-before-remove under a temporary name (the existing Dockerfile swap shape) for every image source, or docker create+start as the atomic check with rollback? (c) what happens to the approved-but-unapplied record and the desired state so nothing loops, retries every idle tick, or holds turns forever? (d) the IPv6 door. Hypothesis to verify against the code: one recreate chokepoint that never destroys the working container until its replacement has started makes 'no container left' impossible for ANY start failure, without a second trigger or a per-path hold (BUG-214 class).

### 2026-10-27 — worker (FEAT-200 fixing r3)
- **design review verdict (c): REDESIGN:** **Independent design review: REDESIGN at the one existing chokepoint** (not rescope, not more patching). openai was tried first (dispatch thread 01a17d37-4b04-75b2-922d-bc348e7ed356 aborted [quota-window], no verdict); the review ran in a fresh Claude Opus process in a clean room (empty cwd, no setting sources, no write/shell tools, prompt-only evidence): session 7a5ad2e2-75df-429c-aa54-6c8c3149c1ee. Raw output kept at /tmp/feat200-r3/review-out.keep.md (scratch). Rulings: (1) hypothesis HOLDS with three corrections: a swap alone LOOPS (swapContainer restores the old container then returns success, so the reconciler logs applied and re-adds a fresh no-backoff entry next tick; Dockerfile projects already had this for port failures); the interrupted-swap recovery block must run for every image source, not only Dockerfile; markImageBad must be gated on Dockerfile projects. (2) Create-before-remove under <name>.next for EVERY image source; create .next while the old runs (create binds nothing), stop the old ONLY if its published ports intersect the new ones, start .next, on failure remove .next and restart the old. Residual: a port the old already held, stolen in that one-start window, leaves a STOPPED container (not a missing one), loud start-failed, no loop. (3) Approved-but-unapplied = option A in the chokepoint (not the reconciler): on a port-allocation refusal naming a port the attempt ADDS, freeze the record's resume as 'approved, but could not be applied: <docker's reason>', revert exactly that record's changes (compare-and-set: still the approved value, approved before the attempt), throw a typed replacement-refused so the reconciler goes intact->pending and its next level read is clean and drops. Any other failure keeps desired state and uses the existing backoff (a transient error must not become a silent denial). Drawer-written refused ports are reverted too. (4) No running container: the resume checker runs a CREATE-ONLY ensure (running -> do nothing) before freezing, so 'granted' is never claimed before a container has it; not a second trigger (never destroys a running container, closes nothing, holds nothing). (5) IPv6: probe [::1] at raise/approve and again just before the swap; dual-publish -p [::1]:H:C makes docker the authority but must be checked per docker mode first; otherwise IPv4 plus probe, and say '127.0.0.1, not localhost'. (6) No second trigger, no per-path hold; close one gap: a FAILED entry should hold turns only when git-driven.

### 2026-10-27 — worker (FEAT-200 fixing r3)
- **r3 redesign built + verified (c):** **Built the r3 design-review REDESIGN of (c), all unstaged.** regressed-from: FEAT-155 r5 swap (Dockerfile-only create-before-remove; returned success on a kept container, which looped). Changes: container-manager.ts: EVERY image source recreates through swapContainer (old remove-then-create path deleted; interrupted-swap recovery for every source; both recovery paths through the swap); swap creates .next while the old runs, stops the old ONLY if its published ports intersect, starts .next, on ANY failure removes .next and restarts the old; it then THROWS ReplacementRefusedError (keptPrevious) unless a Dockerfile image was marked bad; markImageBad only for Dockerfile projects; a port docker refused that the attempt ADDED goes to onPortRefused; doEnsure retries once after a revert; a fresh create that docker refuses removes its half-made container; ensureIfNotRunning (create-only, in the slot, no-op if running or leased). access-channel.ts: hostPortFree probes 127.0.0.1 AND [::1]; revertRefused (compare-and-set against the attempt snapshot and the approved value; marks notApplied + freezes 'approved, but could not be applied: <docker's reason>' BEFORE reverting; drawer-typed refused ports removed too); the resume checker creates first when nothing runs (backed off 5s..300s), never freezing 'granted' first; granted text adds 'use 127.0.0.1, not localhost'. access-requests.ts: notApplied + markNotApplied. grant-rebuild.ts: a FAILED entry holds turns only when git-driven; a refused-but-intact entry gets its own rail card (error + Retry now). index.ts wiring; templates.ts one sentence; app.js card status; CONVENTIONS one sentence. IPv6 dual-publish NOT adopted (the review made it conditional on per-mode checks; it works on the sandbox daemon but not proven on the host's iptables mode): probe + 127.0.0.1 hint, residual named. **Verified (sandbox daemon):** e2e --only X MUST-FAIL on the pre-change tree 7 pass / 12 fail (taken-late: old container REPLACED by a new id and the change kept; IPv6 listener read free and approval passed; GPU rebuild left a created-not-running container in place of the running one; no-container approval said 'granted'); after: X 19/0; full e2e 65/0 (I,A,G,K,L,P,B,R,X). X1 real observation: approval during a busy turn, another container takes 127.0.0.1:H, the idle recreate is refused by docker, the SAME container id stays running, settings reverted, the session told 'approved, but could not be applied: …Bind for 127.0.0.1:35149 failed: port is already allocated', container id stable for 16 s with no further recreate, a NEW session starts and runs a turn (no hold). X3 non-port failure (GPU on a daemon without one): Rebuild refused 'created …next but it would not start; the previous container is still running', same id running, no .next left. X4 no running container + a host-netns process on the port: told 'could not be applied', never 'granted'; container recreated without the port. Unit 78/0 (V1-V13 new); pre-change tree: V1,V2,V3-11,V12 FAIL. Anti-regressions: feat-175 unit 48/0; bug-254 reconciler-unknown 9/0, r9 31/0, r7 2/2; bug-244 matrix 6/0; feat-175 e2e 44/6, the SAME 6 as the pre-lane baseline (P1s x4, P1r, P6); P5 now expects 'failed OR refused-intact with its error, holds kept' (an injected create failure no longer destroys the container) and passes with the new Retry card; arch-022 S1 + I12 fail identically on the pre-change tree (other tickets' spawn sites; lease tear); feat-155-dockerfile 22/21 identical on the pre-change tree (sandbox build uid check), so its Dockerfile swap cases are not exercised here; feat-157-base-recreate-under-live harness error (predates the ARCH-022 authority); bug-214-218 timed out at 1500 s with only B11 (concurrent base build) failing before it, not baselined. gate exit 0. **Orchestrator decisions recorded (not re-asked):** env baked into a user-chosen Dockerfile/image is out of scope (FEAT-164 threat model); sessions sharing a container can name each other's session id for the resume message, accepted (only redirects who is told). **Residuals:** pre-checks advisory; a port the OLD container held, stolen during the one-start stop window, leaves a stopped (not missing) container with a loud error; a [::1] listener appearing after the publish can shadow localhost:H (text says use 127.0.0.1); non-port replacement failures keep desired state and retry with backoff (old container keeps running; with intersecting ports each retry briefly stops it); a refusal docker words outside the regex degrades to that backoff, not a brick.

### 2026-10-27 — worker (FEAT-200 fixing r3)
- **Verification recorded:** dispatch openai run 01a17e35-a01f-7ba1-a870-5ec25477de8e — VERDICT: BROKEN — mixed-state candidate 204127a179e1 — r3 (cross-provider): collision doors not broken; the revert broke: two pending requests both set K=new (previous old) with different ports; A's port refused -> revert restored K=old over B's independent approval. Value-only CAS; the design review had specified per-key provenance.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 fixing r3)
- **IV r3 BROKEN (revert) + fix, unverified:** **Independent verify r3: BROKEN.** Cross-provider: openai thread 01a17e35-a01f-7ba1-a870-5ec25477de8e, mixed-state candidate 204127a179e1, recorded with board-tool verified. The fixer suite ran 78/0 in the room. The break was in the revert, not in a collision door: two requests raised while both were pending each set K=new (previous old), with different ports. When A's port was refused, the revert put back K=old over B's independent approval. The cause is mine: the design review specified per-key provenance, and I built a value-only compare-and-set. Docker lifecycle, HTTP gating and session delivery were not exercised in the room (its UNTESTED line). Per the charter, (c) did NOT break through a new door, so this is not a STOP. **Fix (after the one allowed round, so independently UNVERIFIED):** revertRefused never reverts an env pair that any other standing approval (approved, applied, not notApplied, not itself owning a refused port) also set. Ports need no such guard: a host port maps to one container port per project, so a second record naming it was refused by the same docker call. Must-FAIL: unit V14 FAIL before the fix (KS reverted to old), PASS after; unit 79/0; e2e --only X 19/0 after the fix; gate exit 0; orchard-leak-check --push PASS. **Owed:** one more clean-room verify round on this candidate.

### 2026-10-27 — worker (FEAT-200 verifying r4)
- **Verification recorded:** dispatch anthropic run 2aa4e78b-39fe-44e8-b8fc-717277c79a22 — VERDICT: BROKEN — mixed-state candidate d2664eab363d — r4 TWO-BREAK on the revert: A's revert removed a free port independent approval B also set (no port provenance); B not told. A contract-invalid r4 room also showed 2 env doors (stale provenance, chained refusals). Bypass + loopback held. openai quota; Claude fallback.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 verifying r4)
- **IV r4 BROKEN (two-break, revert) + bug-214-218 baselined:** **Independent verify r4: BROKEN, and a TWO-BREAK on the revert property.** No patch proposed (charter).
  Provider: openai was available at --check, but the dispatch then hit its quota window. The harness fell back to Claude in the same clean room, so author and verifier are both anthropic this round and decorrelation is reduced. Two rooms ran:
  - Room 1, session e6f7644b-7434-410f-95b9-e8b765b8684a. Contract INVALID (two adversarial sections cited the same run), so nothing was recorded from it. Its run 0f5a34fdf879, which calls revertRefused directly, showed two env doors. (C1) Stale provenance: approval C set K=new, the user later deleted K, then A set K=new again with a port that was refused. protectedEnv still counts C, so K=new stays even though A is told its change was removed. (C2) Chained same-key refusals: A sets K old→new1 with port P1, B sets K new1→new2 with port P2, and docker refuses P1 and then, on the retry, P2. K ends at new1, which is A's refused value, and both requesters are told "could not be applied".
  - Room 2 (recorded), run 2aa4e78b-39fe-44e8-b8fc-717277c79a22, candidate d2664eab363d, contract VALID. Fixer unit suite 79/0. BREAK (adv/port-overlap.mjs, run b5692787afaf, unit-level): A asks for ports 42001 and 42002, B independently asks for 42002, both are approved, docker refuses 42001. A's revert also removes 42002, the ports end as [], and B is not marked notApplied, so B gets the "settings changed" text and not "could not be applied". This refutes the r3 claim "ports need no such guard". HELD: the same-key/same-value case in both orders, both requests refused, and a user edit kept (run a2056233465c). Loopback-only with hand-edited hostIp 0.0.0.0, string and out-of-range entries (run 4c5b37ed1d93). No loop and no hold over 20 idle ticks after a refusal with the container intact (adv/no-loop-hold.mjs). Agent bypass on the sandbox daemon: decide, PATCH of every gated field, the answer route and create all return 403 (409 on the answer route), settings byte-identical, e2e G 16/0.
  - Room 2 did not test: the e2e X docker-lifecycle block (port taken late, IPv6 [::1] listener, GPU start failure keeps the old container, approval with no container), because a G run took more than 15 minutes. The shared-port break replayed over HTTP with a real docker refusal. An unreadable store at revert time. Cross-project and another-container collisions through the live server.
  - Read: the revert property broke in r3 (concurrent same key and value) and again in r4 through three different doors (a shared free port, stale env provenance, chained refusals). Per-record compare-and-set over shared settings keeps leaking. This needs a design decision (who owns each setting, or a different revert model), not a fourth patch.
  **bug-214-218 regression gap (from r3): CLOSED, matches the baseline.** The suite was run with a 4500 s timeout, sequentially, on real-copy trees (src, package.json and scripts/lib copied, no symlinks) under /tmp/feat200-r4/{cur,prer3,prefeat}. cur: 37/1 in 2076 s. pre-r3 (the r3 .snap files overlaid): 37/1 in 2007 s. pre-FEAT-200 (the feat-access/pre copies overlaid, access-*.ts removed): 37/1 in 1922 s. The case-by-case PASS/FAIL sets are identical. The only failure in all three is B11 (two instances building the same missing base at once), which is pre-existing and not FEAT-200. The r3 1500 s timeout was runtime, not a hang. Caveat: the cur run overlapped the room's sandbox e2e G run on the same daemon, but B11 fails identically on both baselines.

### 2026-10-27 — worker (FEAT-200 fixing r5)
- **design review r5: REDESIGN commit-on-success:** **Independent design review of the REVERT property (r5, after the r3/r4 two-break): REDESIGN, commit-on-success, NO serialization.** openai passed --check but the test dispatch hit its quota window (thread 01a17e9c-cea3-7033-9d02-7c9f226f2b9a, [quota-window]); the review ran in a fresh Claude Opus process in a clean room (empty cwd, no setting sources, no tools, prompt-only evidence): session 0a294aac-5a2d-465d-93ec-1a0f66d158fd. Prompt and raw output kept in scratch (/tmp/feat200-r5/review-prompt.md, review-out.keep.md). The author hypothesis was supplied as a candidate. Rulings: (1) keep-patching loses because the owner of a value in shared settings is destroyed at write time and `previous` goes stale (breaks 1-4 are one root cause); rescope (env-only) drops half the feature; serialization alone does not fix break 3 (a committed approval + a user delete) and under commit-on-success it is cost without benefit; permanent per-setting layers are correct but heavier (drawer edits would target layers). (2) Model: record status approved_pending -> committed | failed | superseded (terminal), a per-project approvalSeq; desired(p) = base settings folded with approved_pending ops in approvalSeq order (env set, ports set-union), used by createArgs AND drift; `previous` = base at raise, used only as a guard (approve-time staleness, drawer supersede), NEVER written back; a user drawer save that contradicts a pending op supersedes that whole record in the same save (the user edit is never masked or overwritten); COMMIT by the level-based resume checker once a running container is drift-clean against desired: apply ops into base in approvalSeq order, write base first then mark committed (desired-preserving, so no recreate; idempotent on crash); REFUSAL: the chokepoint hook marks failed every approved_pending record with a port op on a refused host port, writes NOTHING to base, returns retry iff a record failed and no refused port is in base; bounded retry inside the same ensure (pending count + 1); a refused drawer-typed (base) port is left in base and shown, the reconciler backs off with the old container intact (removing it was the same bug class). (3) No second trigger, no per-path hold: commit preserves desired; retries are inside the one chokepoint call. Wording flag: commit is the deferred materialisation of the user approval. (4) Residuals: pending requests can wait behind a base-attributed refusal (a user cancel on the card is recommended); up to N+1 create attempts per pass; a same-batch earlier record on a shared key is told a later request set the final value; supersede is whole-record.

### 2026-10-27 — worker (FEAT-200 fixing r5)
- **r5 commit-on-success built + verified (fixer):** **Built the r5 design-review REDESIGN (commit on success), all unstaged.** regressed-from: FEAT-200 r3 (revertRefused / the write-on-approve + revert model; r3 IV 01a17e35 and r4 IV 2aa4e78b broke it through four doors). No serialization (the review ruled it cost without benefit under this model).
    Changes: access-requests.ts: approved = APPROVED-PENDING (`decision.applied:false`, per-project `decision.seq`); `foldAccess` (pure: env set, ports set on host port), `listApprovedPending`/`pendingOverlayFor`, `markCommitted` (applied + frozen text, one write), `markNotApplied(items, cause refused|superseded)`; removed markApplied/abandonDecision/listUnapplied (no settings write on approve, so no intent to recover). access-channel.ts: revertRefused DELETED; `failRefused` (fails every approved-pending owner of a refused host port, writes nothing, returns retry|stop; stop when a refused port is the user own base port); `supersededBy` (a contradicting user save supersedes the whole record); checkResumes COMMITS once a running container is drift-clean against the desired config (settings first, then mark; idempotent), project gone / not container = superseded; parseChanges checks ports against the desired config (an approved-pending publish claims its host port). container-manager.ts: `setAccessOverlay` + `accessSettingsOf` = base + overlay, read by createArgs, accessDriftReasons (doEnsure, status, the reconciler level read), envKeysOf label, validPublishes (swap clash + refusal report); refusal retries bounded by progress (cap 32) instead of once; `ReplacementRefusedError.dropped`. index.ts: approve writes no setting (validates the desired config, beginDecision, nudge); `commitBase` folds ops onto the CURRENT base; `cm.onPortRefused` -> failRefused; overlay hook (an unreadable store THROWS, read as unknown by the reconciler, never as "no overlay"); project PATCH supersedes contradicted approved-pending records before writing; other projects approved-pending ports count as conflicts. templates.ts one sentence, app.js card wording, CONVENTIONS sentence, grant-rebuild log wording.
    **Verified (fixer, sandbox daemon):** NEW scripts/verify-feat-200-commit-on-success.mjs (real access layer + real createArgs; the docker daemon and the index.ts wiring are mirrored per model, SYNTHETIC by necessity): after 27/0. Must-FAIL vs the pre-r5 tree (/tmp/feat200-r5/pretree = the r4 candidate src, byte-identical): W2 shared port, W3 stale provenance, W4 chained refusals FAIL; W5 random interleavings (400 runs, N=2-6 requests, random refused subset; invariant settings = base + exactly the applied requests in approval order, container = settings, every message true) 166/400 runs violate before, 0/400 after; W1 (shared key) passes on the pre-r5 tree because of the r3 protectedEnv patch and FAILS on that tree with protectedEnv removed (the r3 room shape). E2E NEW block Y (the four doors over HTTP on a real scratch server, real docker refusal by a squatting container while a turn holds the idle recreate): after 16/0; pre-r5 tree 10/6 (Y2a-c shared port: B port dropped, B told "settings changed since"; Y3a stale provenance: YK=new survives the user delete; Y4a-b chained: YK=new1, A refused value); Y1 passes on both (r3 patch). Full e2e (I,A,K,L,G,P,B,R,Y,X; no shots) 79/2, the 2 were a harness bug in Y3 (the recreate closed the requester session; raise now from a fresh session), fixed and Y re-run 16/0. X docker-lifecycle block r4 could not reach: X1 taken late (same container id kept running, told "could not be applied", not in settings, stable 16 s, no recreate, a new session starts), X2 [::1]-only listener is a conflict and approval 409, X3 GPU start failure keeps the old container (no .next left), X4 no running container + port taken: told "could not be applied", never granted, container running without the port: all PASS. P now asserts approval writes nothing (P2) and the commit after the container has it (P9). Unit verify-feat-200-access-unit 78/0 (S/Q/V rewritten for the new model). Anti-regressions: feat-175 unit 48/0; bug-254 reconciler-unknown 9/0, r9 31/0, r7 2/2; feat-113 11/11; feat-164 self-grant 65/0; feat-175 e2e 64 pass, the SAME 6 unique failures as the r3 baseline (P1s x4, P1r, P6; same case set as /tmp/feat200-r3/sb2-f175-now.txt plus 4 SHOTS passes); feat-112-services did not run (needs VERIFY_F112_BASE, base image absent in the sandbox; environment, not this change); gate exit 0. The e2e suite now tags project names per run (a container left by the killed r4 room run, owned by another data dir, collided with f200-alpha; it was left alone).
    **Behaviour change to note:** a host port the USER typed into the project settings that docker refuses is now LEFT in the settings (r3 removed it; the review ruled removal is the same bug class): the old container keeps running, the reconciler rebuild card shows docker reason + Retry, and a new session launch in that project fails with docker reason until the user changes the port.
    **Not built (review recommendations, residuals):** a card "cancel" for an approved-pending request; the drawer pre-save warning that a save supersedes a pending request (the server supersedes and tells the requester).

### 2026-10-27 — worker (FEAT-200 fixing r5)
- **Verification recorded:** dispatch anthropic run 9095680c-5a75-4dd4-9bee-335c128deac7 — VERDICT: BROKEN — mixed-state candidate 4db09b1f5408 — r5 commit-on-success: the four recorded doors HELD; a NEW door broke "a user edit is never undone": the stateless supersede rule misses user edit SEQUENCES (K old->new->old, add-then-delete, add-then-remove a port) while a request is approved-pending; the commit re-applies it.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 fixing r5)
- **IV r5 BROKEN (new door: user-edit sequences) — STOP, no patch:** **Independent verify r5: BROKEN through a NEW door; STOPPED per charter, no patch.** Run: anthropic 9095680c-5a75-4dd4-9bee-335c128deac7, mixed-state candidate 4db09b1f5408 (openai over quota until 2026-10-28 01:34; the harness fell back to Claude in the same clean room, so decorrelation is reduced again), recorded with board-tool verified. Contract VALID. Fixer suite 27/0 in the room. The four recorded doors were not broken.
    BREAK (property: a user edit is never undone; adv run scratch-adv/undo-user-edit.mjs, 0/3): the design-review supersede predicate is STATELESS (a save supersedes a pending request only when the new base value is neither the request `previous` nor its `value`; a port only when remapped). So user edit SEQUENCES slip through while a request is approved-pending: (1) base K=old, A old->new approved; the user saves K=new then K=old: neither save supersedes, the commit writes K=new over the user final K=old; (2) A adds K=new (previous null); the user adds K=new then deletes K: the delete equals `previous`, A stays, container keeps K=new and the commit writes it back; (3) A publishes 47701->8080; the user publishes the same then removes it: removal never supersedes, the commit re-adds it. HELD: loopback-only even with malformed/non-loopback port ops injected straight into approved-pending records in the access store (scratch-adv/loopback-store.mjs).
    Room did NOT test (its UNTESTED): the e2e docker blocks (Y, X, G) and so the index.ts wiring, real refusals, the [::1]/other-container doors, old-container survival, no-loop/no-hold on a real server, the 403s over a real scope; a registry write that throws after the PATCH supersede (requester told "superseded" for an edit that never landed). The fixer ran Y 16/0, X 19/0, G in the full e2e run (79/2 -> harness fix -> Y 16/0); the room did not re-run them.
    Read (for the orchestrator, not a patch): the commit-on-success core (approve writes nothing; refusal fails owners, writes nothing) held every concurrency door attacked; what broke is the user-edit rule bolted on to it. Candidate decisions: (a) supersede on ANY user save that CHANGES a key or port a pending request names (stateful "touched", not "contradicts"; an unrelated save still supersedes nothing); (b) refuse a user save of a key/port named by an approved-pending request (409, "wait or cancel the request") plus a cancel on the card; (c) rescope: accept that a user edit of a pending key can be re-applied. Each needs its own must-FAIL from these three repros. The PATCH supersede-then-write crash window is a second, smaller item for the same decision.

### 2026-10-27 — worker (FEAT-200 fixing r6)
- **orchestrator decision r6: rule (a):** **Decided by the orchestrator (recorded here as the orchestrator's decision, not the lane's):** rule (a) — a user's save that touches a key or port named by an approved-but-unapplied request CANCELS that request; the user's own edit is the newest intent. (b) a 409 on the user's save lost: it blocks users from editing their own settings because of an agent's request. (c) re-applying over the edit lost: it violates the property. Detection must be STRUCTURAL, not by value (r5 compared final values, so A→B→A and add-then-delete slipped through): a monotonic per-key / per-port edit version stamped by the ONE user-save writer; a request records the versions of what it names at approval; any change at commit cancels it; commit and cancel decided in ONE place (the existing chokepoint), never in both the save route and the reconciler. The requester is resumed with a truthful "cancelled: …"; a failed settings write at commit says "approved, but could not be saved: <reason>", never "superseded". Also decided: a Cancel button on an approved-pending card, a drawer warning before a save that will cancel a pending request (existing violet styling), and a user-typed port docker refused stays in settings but is made VISIBLE with docker's reason.

### 2026-10-27 — worker (FEAT-200 fixing r6)
- **Verification recorded:** dispatch anthropic run 91a246ca-617a-42fd-bcbf-39a2e75a4b0c — VERDICT: BROKEN — mixed-state candidate b6e1464d2486 — r6: all 7 docker blocks HELD (U,Y,X,G,P/R,B,L); user edit held. BROKEN: commit two-write window (settings written, record mark lost by crash/store EACCES) then a user edit of one named key -> told "cancelled, never written" while its port is in settings+container. openai quota; Claude.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (FEAT-200 fixing r6)
- **r6 edit versions + commit-pass cancel built + verified (fixer):** **Built r6 (orchestrator rule (a): the user's edit wins, detected STRUCTURALLY), all unstaged.** regressed-from: FEAT-200 r5 (the stateless value-compare supersede predicate; IV 9095680c broke it).
      Hypothesis CONFIRMED: there is ONE settings writer, `registry.ts updateProject`, so the version stamp lives there. Every writer of container env/ports goes through it. The user writes through the PATCH route (create makes a fresh row); services, wiring and base-update write other fields; the commit writes through it too. The stamp therefore covers every non-commit writer, not only the drawer.
      Changes. registry.ts: `Project.accessEdits {env, ports}` holds monotonic per-key / per-host-port versions, bumped by updateProject in the same atomic save for every key whose value or presence changed and every host port whose mapping was added, remapped or removed. A patch can never set them. The commit passes `{ accessCommit: true }` and bumps nothing. Helpers `accessEditsOf` and `bumpAccessEdits`. access-requests.ts: `decision.basis` (the versions of the named keys/ports plus the project createdAt, taken at approval), `basisFor`, `editsSince` (structural; also catches a project re-added under the same id), causes 'cancelled' | 'save-failed'. access-channel.ts: `supersededBy` DELETED. `liveFor` is the one predicate. `overlayFor` drops non-live records from the desired config at once. checkResumes is the ONE place that cancels ("cancelled: the user edited env K … after approving it"), in the same synchronous pass as the commit. A failed commit write is terminal: "approved, but could not be saved: <reason>", never "superseded". `cancelByUser` backs the card. `failRefused` skips non-live records. A user-set port docker refused is recorded (`userPortRefusalOf`, level-filtered on read). index.ts: the PATCH route decides nothing; it only wakes the commit pass. Approve records the basis in the same synchronous step. commitBase passes accessCommit. New user-only POST …/access-requests/:rid/cancel (403 agent-not-user; 409 not-pending). Container status carries `access.pending` and `access.portRefusal`. accessView gains `cancellable`. UI: a "Cancel request" button on an approved-pending card. Before saving, the drawer re-reads the approved-pending requests, and a save touching a named key/port is held behind a violet warning ("Save and cancel the request" / "Keep editing"). The ports group shows a refused user port with docker's words. Existing --access styling is reused (selectors joined). templates.ts gets one sentence; CONVENTIONS gets one sentence.
      **Found and fixed (pre-existing, regressed-from: FEAT-157):** the drawer's putContainer re-sent the whole cached `container` object, including `container.base`, which the server refuses ("not writable here"). So EVERY drawer container save on a base-pinned project was refused with 400. Must-FAIL: SHOTS6 "Save and cancel" on a tree with the old putContainer: PATCH 400 container.base; after: 200. It now sends only the changed fields (the server merges `container` one level deep), which also stops a stale drawer writing back old env/ports.
      **Verified (fixer, sandbox daemon):** commit-on-success 46/0 (200 runs). Must-FAIL on the r5 tree: 14 FAIL. The three r5 sequences W13/W14/W15 fail: K=new written over the user's K=old; K=new back after add-then-delete; 47701 re-published. W16 save-write failure: on r5 the requester was never told. W17 Cancel is absent. W21 re-added project. W22 is the NEW random invariant with user saves mixed in (env set/change/delete/change-and-back, port add/remove; oracle = never undone + "cancelled" true + settings = replay + container = settings): 0/200 violations after; on r5 69/200 violate, 21 of them a commit over a user edit. W20 (a failed user save stamps nothing) is an anti-regression only: on r5 it passes for a harness reason (chmod also blocks the r5 store write). Unit 81/0 (V14 rewritten for r6; FAIL on the r5 tree). E2E NEW block U (HTTP, real containers): after 20/0; on the pre-r6 tree 13 FAIL (U1a/U2a/U3a are the three IV r5 doors live). SHOTS6 7/0 in both themes plus the Save-and-cancel click-path. Full e2e (I,A,G,K,L,P,B,R,Y,X,U,SHOTS6,SHOTS): 110/2. The 2 were SHOTS6 timing: the drawer read the pending list from a status that had not loaded yet. Fixed: the drawer now re-reads it at save time, and SHOTS6 re-ran 7/0. Screenshots: docs/bugs/assets/FEAT-200-r6-cancel-card-{light,dark}.png and FEAT-200-r6-drawer-warning-{light,dark}.png (git-ignored local evidence). Anti-regressions: feat-175 unit 48/0; feat-175 e2e 64 pass with the SAME 6 unique failures as the r3 baseline (P1s x4, P1r, P6); bug-254 reconciler-unknown 9/0, r9 31/0, r7 2/2; feat-113 11/11; feat-164 self-grant 65/0; gate exit 0. Also bug-214-218 37/1 (only B11, the pre-existing baseline failure).

### 2026-10-27 — worker (FEAT-200 fixing r6)
- **IV r6 BROKEN (new door: commit two-write window) — STOP, no patch:** **Independent verify r6: BROKEN through a NEW door (truthfulness in a commit crash window). STOPPED, no patch.** Run: anthropic 91a246ca-617a-42fd-bcbf-39a2e75a4b0c, mixed-state candidate b6e1464d2486. openai test dispatch thread 01a17f42-c123-7ad1-a5a0-e7c9c535be5c hit [quota-window] until 2026-10-28 01:34, so the harness fell back to Claude in the same clean room and decorrelation is reduced. Recorded with board-tool verified. Fixer suite 46/0 in the room (400 runs); unit 81/0.
      **All seven REQUIRED docker blocks ran in the room this time and HELD:** U 20/0 (user-edit sequences over HTTP, the cancel route with an agent 403, a refused user port shown), Y 16/0 (the four revert doors with a real refusal), X 19/0 (port taken late keeps the old container; [::1] is a conflict; a non-port start failure keeps the container; no running container never claims granted), G 16/0 (403 from a real session scope), P,R 23/0 (wiring; inspect env + 127.0.0.1-only bindings; granted/denied texts), B 5/0 (no recreate while busy), L 3/0.
      BREAK, classified: the requester-TRUTH property, not "a user edit is never undone". The user's K=mine stood in both runs. Door: the commit's TWO writes. checkResumes writes the settings (commitBase) and then marks the record (markCommitted). If the mark never lands (a crash, or the access store's write failing with EACCES, which is only logged), the record stays approved-pending over a base that already holds its ops. A later user save of ONE named key then cancels it through editsSince, and it is told "None of it was applied, and it was never written to the project settings", while its other op (port 127.0.0.1:48101→8080) is in the settings and published. Runs e748e55dfe7f (crash window) and e7b55803bcb6 (store write fails), both against the real access layer and the real registry writer with a simulated container. r5's W8 had the same window but tested no user edit inside it.
      Why STOP and not patch: the charter's two-break rule. The r6 cancel path is the mechanism of the user-edit rule, and it produced a false message through a new door. The one verify round is spent, so any patch would ship unverified.
      Lane's recommendation for the decision (not built): make "committed" atomic with the settings write. commitBase stamps the committed record ids into the SAME registry save (e.g. `Project.accessCommitted`, with `{ accessCommit: true }`). The commit pass treats a record named there as committed (mark it, compute its text from the live container), never as cancelled. A crash or a store failure between the two writes then cannot reclassify it. Alternative: accept it as a named crash/store-failure residual (it needs a crash or an unwritable access store between two synchronous writes, followed by a user edit of a named key).
      Room UNTESTED: an HTTP PATCH truly racing a commit (both synchronous in one process; could not interleave); a legacy no-basis record plus delete/re-add within one 2 s pass; SHOTS/SHOTS6 (the fixer ran them: 7/0 both themes); the crash-window break on the docker daemon (shown on the real access layer + registry).

### 2026-10-27 — worker (FEAT-200 fixing r7)
- **orchestrator decision r7: option (a), committed is atomic with the settings write:** **Decided by the orchestrator (recorded here as the orchestrator's decision, not the lane's):** option (a), make the r6 two-write window impossible BY CONSTRUCTION. The fact that request R was committed is written INSIDE the same atomic settings write that applies R (a committed set in the project settings record). The commit pass and every reader of request state treat a request in that set as committed, never cancelled, whatever the request store says; the store's own mark becomes a derived convenience, reconciled from the settings record on the next pass, with no second source able to disagree (ARCH-010: one owner of the fact). The agent's message must come from the committed set, so "None of it was applied" is impossible when R is in the set. Option (b), accepting the gap as a residual, REJECTED: it tells the agent something false about the user's settings. Hypothesis to verify first: the settings write is one atomic write through one writer; if not, STOP.

### 2026-10-28 — worker (FEAT-200 fixing r7)
- **r7 committed-set-in-settings built + verified (fixer):** **Built r7 (orchestrator option (a): "committed" is written inside the settings write), all unstaged.** regressed-from: FEAT-200 r5/r6 (the commit's settings-then-mark two-write order; r5 W8 covered the window without a user edit, r6 added the cancel path that turned it into a false message; IV r6 91a246ca).
    **Hypothesis CONFIRMED:** the settings write is atomic and has one writer. `registry.ts save()` is the only writer of `registry.json` (writeAtomic: temp file, fsync, rename), every caller is synchronous read-modify-write in registry.ts, and nothing else in src/ or scripts/lib writes the file (lane-docker/own-project only read it). So the committed set rides in that one save.
    **Changes.** registry.ts: `Project.accessCommitted` (ids), written only by `updateProject(…, { accessCommit: true, committed })` in the same atomic save as the folded ops; a patch can never set it, every other write keeps it. access-requests.ts: `committedInSettings` (reads the settings record; null when the registry is unreadable), `isApprovedPending` is false for a committed id, `listCommittedUnmarked`, `committedSetAfter` (an id leaves the set on a later commit once the store has marked it, so the set stays bounded), `markNotApplied` refuses a committed id and refuses when committed-ness is unknown (the structural backstop: no caller can write "not applied" over the fact), `markCommitted` reconciles store-pending records. access-channel.ts: `commitPlanFor` builds the ONE commit write (ops + set); `liveFor` false for a committed id (overlay, drawer, refusal handler); `checkResumes` reconciles committed-but-unmarked records with text from the running container (never cancels, refuses or supersedes them); after a commit write throws it RE-READS the settings record and only ids not in the set are told "could not be saved"; a project that stopped using a container gets "approved and saved … not in effect"; a REMOVED project (its record gone, so committed-ness is unknowable) gets "approved, but its project was removed … not in effect", never "None of it was applied". index.ts: commitBase writes `commitPlanFor` with `{ accessCommit, committed }`; `accessView` shows a committed-by-settings record as applied.
    **Verified (fixer):** commit-on-success 70/0 (400 runs). Must-FAIL on the pre-r7 tree (real copy of src at the r6 state, /tmp/feat200-r7/pretree, byte-identical to the r6 files): 7 FAIL. W23b/c (crash after the settings write, then a user edit of K: told "cancelled … None of it was applied, never written" while 127.0.0.1:48101 is in the settings and container), W24b/c (the same with the store write failing EACCES), W26 (no committed set), W31 (project removed in the window), W29 (NEW random search: user saves + a one-shot fault at EVERY write point: registry write fails, crash after the settings write, store fails after the settings write, outbox refuses, store fails after enqueue, user save fails; plus random server restarts as fresh module imports; oracle = every message matches the settings ground truth, each requester told exactly once, container = settings, nothing left pending) 3/400 violate before, 0/400 after, every fault point hit (about 250 each) and 362 user edits landed inside a lost-mark window. Anti-regressions that pass on both trees: W25 (crash after the settings write, before any message → on restart "access granted" EXACTLY once, no recreate), W27 (the settings write itself fails), W28 (in the outbox, "queued" lost → same text, one row). W26b-f: Cancel, the docker-refusal handler and markNotApplied cannot reclassify a committed id; a user save keeps the set; a patch carrying accessCommitted is ignored; the set stays bounded. W30: the real registry truncated at 4 points reads as committed-unknown and no "not applied" mark is written.
    E2E NEW block C (real scratch server + sandbox daemon; on-disk crash state SYNTHETIC by necessity: raise from inside the container and HTTP approval are real, then SIGKILL, then the registry written as the commit's one write leaves it, the store untouched): after 7/0. On the pre-r7 tree C1b FAILS live: "was cancelled: the user edited env CK … None of it was applied, and it was never written" while port H1 is in the settings and published. After: "approved, but env CK=new (was old) is not in the container now. In place: port 127.0.0.1:H1 → container 8080", delivered once to the closed session through the resume route; C2 (no edit) "access granted" exactly once. Full e2e (I,A,G,K,L,P,B,R,Y,X,U,C,SHOTS6): 108/1, the 1 a SHOTS6 element-detached screenshot right after C's server restart; SHOTS6+SHOTS re-run alone 13/0, and block C now runs last. Unit 81/0 (the Q/V commitBase stubs now honour the r7 contract: the commit write names the ids). Anti-regressions: feat-175 unit 48/0; feat-175 e2e 64 pass with the SAME 6 unique failures as the baseline (P1s x4, P1r, P6); bug-214-218 37/1 (only B11, the baseline); bug-254 reconciler-unknown 9/0, r9 31/0, r7 2/2; feat-113 11/11; feat-164 self-grant 65/0; gate exit 0.
    **Couldn't test:** a real process crash at the exact instant between the two writes (both are synchronous in one tick; the crash state is constructed on disk); the UI line for a committed-but-unmarked record (accessView flips it to applied; not screenshotted).

### 2026-10-28 — worker (FEAT-200 fixing r7)
- **Verification recorded:** dispatch anthropic run 7b08ede8-3ba6-400d-be94-73289a604b4f — VERDICT: BROKEN — mixed-state candidate d7d509dba02c — r7: all 8 docker blocks HELD (C,U,Y,X,G,P/R,B,L); forged accessCommitted held. BROKEN, new door: commit lands, store mark lost (EACCES), project DELETED and RE-ADDED under the same id -> told "cancelled ... never written". openai quota mid-run; Claude.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 fixing r7)
- **IV r7 BROKEN (new door: project delete + re-add in the lost-mark window) — STOP, no patch:** **Independent verify r7: BROKEN through a NEW door (requester truth after a project delete + re-add). STOPPED per charter (two-break on commit atomicity), no patch.** Cross-provider was attempted: the openai test dispatch passed (thread 01a17fbb-6718-7580-984a-2324d447f197, "READY"), and the verify dispatch ran on openai (thread 01a17ff9-8777-78b0-8598-de42a5507fb8) until it hit [quota-window] mid-run (reset 06:39). The harness then fell back to Claude in the same clean room, recorder and prompt: anthropic run 7b08ede8-3ba6-400d-be94-73289a604b4f, mixed-state candidate d7d509dba02c, contract VALID, recorded with board-tool verified. Author and verifier are both anthropic, so decorrelation is reduced. openai independently found the same break before its abort (its probe iv-r7-readd.mjs, via cancelByUser).
      **HELD in the room:** the fixer suite (commit-on-success, exit 0); all eight docker blocks on the sandbox daemon: C (the r7 crash window: truthful text, told once, "granted" once on restart), U, Y, X, G, P/R, B, L; a PATCH or create carrying accessCommitted/accessEdits is refused or ignored (run 23052e3b823c).
      **BREAK, classified: requester truth (the agent's message matches the settings truth).** Door: the commit's settings write lands and names R in the committed set; the store mark is lost (EACCES); then the project is REMOVED and RE-ADDED under the same id (DELETE, then POST /api/projects with the same name) before the next pass. The new row has a fresh createdAt and an empty accessCommitted, so R is no longer committed by any record. editsSince sees the createdAt change and the pass cancels R: "was cancelled … None of it was applied, and it was never written to the project settings", although a landed write had folded its ops (K=new, port 48777) into the REMOVED project's settings (run b1ee192603dc, exit 1, real registry create/delete; HTTP reproduction not run). r7 already handled the plain removal (getProject null → "approved, but its project was removed … not in effect"); a re-add under the same id slips past that branch.
      **Why STOP:** the charter's two-break rule for commit atomicity. The r7 design held every write-point fault and every docker block; this is a second door into the same property, so it ships unpatched pending a decision.
      **Lane's read for the decision (not built):** a record approved for a project INSTANCE that no longer exists (its basis.projectCreatedAt differs from the current row's createdAt) belongs to a removed project, whatever the store says. Close it with the removed-project text ("approved, but its project was removed from Orchard, so it is not in effect"), never the cancelled text, in both checkResumes and cancelByUser. That is the same rule as the r7 plain-removal branch extended to "removed then re-added". It needs a must-FAIL from run b1ee192603dc's shape plus an HTTP replay. Alternatively, accept "project deleted and re-created under the same id inside the lost-mark window" as a named residual: it needs a crash or an unwritable store between two synchronous writes, then a delete and a re-add before the next 2 s pass.
      **Room UNTESTED (its own list):** the HTTP replay of the re-add break; SHOTS/SHOTS6.

### 2026-10-28 — worker (FEAT-200 fixing r8)
- **design review r8: REDESIGN (incarnation + one classifier):** **Design review r8 (independent, clean room): REDESIGN — project INCARNATION + ONE classifier.** openai was unavailable (test dispatch thread 01a18020-9bfb-7461-9c39-548a3a2f8425: [quota-window] until 06:39), so the review ran on Claude Opus through scripts/dispatch.mjs in a separate read-only process: anthropic run 8e184b1e-90b7-4d43-8b51-e40b1a101026. It was given the property, both break paths, the code and the orchestrator's hypothesis as a candidate only. Raw output: /tmp/feat200-r8/review-out.txt.
      Its reading: the root cause is misclassification. `editsSince` counted "removed and re-added" as a user edit, and an edit always produces the "never written" text. RESCOPE was rejected because two id-reuse doors need no crash: (1) an UNDECIDED request of the old project is approvable on the re-added project's card (the decide route compared the id only, then basisFor bound it to the new createdAt); (2) a record with no basis skipped the createdAt check and would be folded into and committed to the new project. Other doors it found: (3) the outbox resumes a closed session by projectId, so a queued message would start the removed project's session inside the re-added one (outbox-wide; for FEAT-200 the delivery step must not do this); (4) resumeTextFor's no-project branch said "Nothing was applied" even for a committed record; (5) the pending cap and seq counted a removed project's records.
      Design (adopted as given): `Project.incarnation` is a random token set only by createProject and ensureScratchProject. It cannot be patched and is copied on every write; legacy rows read as createdAt. A request records `projectIncarnation` at raise time. ONE pure classifier `classify(rec, project|null|UNREADABLE)` has this precedence: unknown, final, removed (no row, or a different incarnation), committed, edited, live, undecided. Every reader goes through it: the commit pass, liveFor/overlay, failRefused, cancelByUser, the decide route, accessView, delivery, the pending cap, and the store writers' own backstops (markNotApplied writes a cause only when the class allows it; new cause 'removed'). editsSince loses its createdAt clause.
      Answers: (a) an undecided request of a removed incarnation gets 409 project-removed and is closed as removed. (b) Frozen text is delivered as is, but never by resuming into another incarnation. (c) Legacy records: use basis.projectCreatedAt; otherwise rec.createdAt < project.createdAt means removed.
      Budget (confirmed and tightened): one build, then at most ONE verify round. If the build cannot route every reader through the classifier, stop before verify. If the verify round breaks requester truth again, or any other property, there is no further round: the residual is recorded, contained by a regression test, and the case goes to technical adjudication.

### 2026-10-28 — worker (FEAT-200 fixing r8)
- **r8 incarnation + one classifier built + verified (fixer):** **r8 built (design review 8e184b1e REDESIGN: project incarnation + ONE classifier), all unstaged.** regressed-from: FEAT-200 r6/r7. r6 put "removed and re-added" into `editsSince` as a user edit; r7's committed set did not survive the row's replacement. IV r7 7b08ede8 found it.
      **Hypothesis CONFIRMED (fits the registry):** ids are reusable. createProject picks slugify(name), unique only among current rows, and ensureScratchProject re-creates id 'scratch'. A row's createdAt is immutable but carries no identity token. Rename and repoint keep id + row (same project). No other writer creates rows: index.ts only calls createProject/ensureScratchProject; scripts/lib/broker-fixture.mjs is a test fixture.
      **Changes.**
      - registry.ts: `Project.incarnation` (random `inc-<uuid>`) is set only by createProject and ensureScratchProject. It is excluded from the patch type and forced by updateProject. `incarnationOf(p)` reads legacy rows as `created:<createdAt>`.
      - access-requests.ts: `AccessRequest.projectIncarnation` is set at raise time. ONE pure `classify(rec, project|null|UNREADABLE)` (unknown > final > removed > committed > edited > live/undecided), with `classOf`, `readProject` and `UNREADABLE`. Legacy matching: basis.projectCreatedAt, else rec.createdAt < row.createdAt means removed. `editsSince` lost its createdAt clause. `committedInSettings` and `isApprovedPending` are thin wrappers over it. `listOpen` is the commit pass's one worklist (replaces listCommittedUnmarked). `markNotApplied` writes a cause only if the class allows it (MAY_CLOSE; new cause 'removed', which also closes an UNDECIDED record). `markCommitted` marks only class 'committed'. `beginDecision` refuses a removed incarnation (code project-removed). The pending cap counts only the current incarnation. New resume state 'undeliverable'.
      - access-channel.ts: the raise binds the incarnation. `liveFor` is `classify(...) === 'live'`. `cancelByUser` returns 409 project-removed for a removed incarnation and writes nothing. `checkResumes` classifies each open record ONCE: removed records are closed with the removed text; committed ones are reconciled; edited ones cancelled; live ones committed. After the commit write, records are re-classified against the re-read row. Delivery: a record whose incarnation is gone is sent only to a RUNNING session. Otherwise any outbox row under its nonce is withdrawn (outbox discard) and it is marked 'undeliverable', so a closed session is never resumed into another project. `resumeTextFor`'s no-project branch no longer says "Nothing was applied". A registry read that throws is UNREADABLE (unknown), never "removed".
      - index.ts: the decide route gives an early 409 project-removed, and AccessStoreError project-removed maps to 409. ResumeDeps get `sessionLive` and `withdraw` (createOutboxRow with discard under the same nonce). accessView uses one classOf: committed is shown applied, removed is shown closed, cancellable means live|edited.
      - public/app.js: the card has a "removed" state line ("…its project was removed from Orchard, so it is not in effect · not sent: …"), and an undecided-but-closed record shows no Approve/Reject.
      **Verified (fixer).**
      - Must-FAIL on the r7 tree (/tmp/feat200-r8/pretree, a copy of src as it stood before this round):
        - commit-on-success: 11 FAIL. W32b/c and W32xb/c: IV r7's exact shape (store fails / crash after the settings write, then real deleteProject + createProject under the same id) is told "cancelled: the user edited the project itself … None of it was applied … never written". W32e/W32xe: queued and resumed into the re-added project. W32f. W33: Cancel on the new card writes "cancelled". W34: the old project's UNDECIDED request is approved onto the re-added project, which gets K=new and "access granted". W35. W29: 3/400 violations.
        - e2e NEW block D (HTTP DELETE + POST same name, real containers): 6 FAIL. D3 is live: "was cancelled: the user edited the project itself (it was removed and added again)". D2/D5: approve returned 200 and the re-added project got DB=yes and a committed set.
      - After: commit-on-success 92/0. W29 extended with delete + re-add events (real registry functions), also inside lost-mark windows, plus restarts and both session states: 0/400 violations (140 re-adds, 61 inside a window, 45 approvals refused as removed, 114 undeliverable, 355 restarts, every fault point about 200-280 hits). Also new: W36 scratch door, W37 legacy no-token / no-basis both directions, W38 rename/repoint/forged-token keep the incarnation and a re-add mints a new one, W39 truncated registry (3 cuts) gives unknown with no mark and nothing sent.
      - e2e D 9/0 after. Full e2e (I,A,G,K,L,P,B,R,Y,X,U,SHOTS6,SHOTS,C,D): 126/0.
      - Unit 81/0. V14b now expects classify→removed for a re-add. The S/Q/V stubs commit through the REAL registry row, because markCommitted's backstop reads it.
      - Anti-regressions: feat-175 unit 48/0; feat-175 e2e 64 pass with the SAME 6 unique baseline failures (P1s x4, P1r, P6); bug-214-218 37/1 (B11 baseline); bug-254 reconciler-unknown 9/0, r9 31/0, r7 2/2; feat-113 11/11; feat-164 self-grant 65/0.
      - Gate: only leak-gate fails, on tmp/feat-199-r9-verdict.json (another lane's file); typecheck and the other checks pass.
      **Couldn't test:** a real process crash at the instant between the two writes (the on-disk state is constructed, as in block C). Block D holds the lost mark by making the store unreadable for the delete + re-add window (a store fault), not EACCES on the mark itself. No screenshot of the new "removed" card line. The general outbox resume-by-projectId for non-access messages is out of scope (design review door 3).

### 2026-10-28 — worker (FEAT-200 fixing r8)
- **Verification recorded:** dispatch anthropic run ec528a8a-3277-4fff-b357-14bd29e61d53 — VERDICT: BROKEN — mixed-state candidate 3f303796f132 — r8: 9 docker blocks HELD (D,C,U,Y,X,G,P/R,B,L), fixer 92/0. BROKEN: granted already QUEUED in the outbox (held), then delete+re-add; the outbox resumed the old session into the new project, delivered granted (run 8216df1bf6c7). openai quota; Claude fallback.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 fixing r8)
- **IV r8 BROKEN (queued outbox row + delete/re-add) - budget spent, residual contained, to adjudication:** **Independent verify r8: BROKEN (requester truth, through a queued outbox row). Per the design-review budget: NO further round and NO patch. The residual is recorded, contained by a regression test, and goes to technical adjudication.** Cross-provider was attempted: openai thread 01a1808e-1508-7142-90c5-e55805175e03 hit [quota-window] (reset 06:39), so the harness fell back to Claude in the same clean room, recorder and prompt. That run is anthropic ec528a8a-3277-4fff-b357-14bd29e61d53, mixed-state candidate 3f303796f132 (20 files), recorded with board-tool verified. Author and verifier are both anthropic, so decorrelation is reduced.
      **HELD in the room:** the fixer suite (commit-on-success 92/0, run 04291bbbd365); all NINE docker blocks on the sandbox daemon: D (new r8: delete + re-add over HTTP in the lost-mark window), C, U, Y, X, G, P/R, B and L; incarnation kept by rename, repoint and isolation change (run 405ef9aac23e); and the race variant of its own probe (delivery failed, nothing false told).
      **BREAK, classified: requester truth** (and the cross-incarnation resume the design review named as door 3).
      - The door: the request commits, and "[station] access granted: env QX=1" is already QUEUED in the outbox for the closed requester. The outbox holds the row on its external-writer hold.
      - The project is then DELETE ?force=1'd and re-added (POST, same name, same id).
      - When the hold clears, the outbox resumes the REMOVED project's session inside the re-added project and delivers "access granted", although the re-added project's settings have env {} (run 8216df1bf6c7, Q5).
      - Root cause per the verifier: r8's withdraw step only looks at records not yet 'queued', and the outbox's probe and handOver resolve the project by resume.projectId alone, never by incarnation.
      **Contained (not fixed):** NEW e2e block Q in verify-feat-200-access-requests.mjs reproduces it on the sandbox daemon. It is EXPECTED TO FAIL, runs only with --only Q (excluded from a default run), and the run here gives 4/1: Q3 delivered "access granted: env QX=1" into the re-added project, whose env is {}. The verifier's own probe script was not preserved by the clean room, so Q is a re-creation of its shape (approve, queue, hold by touching the transcript, delete + re-add, hold clears).
      **For adjudication (not built):** the remaining door is the OUTBOX, not the access model. Every r8 access-layer door held. Two candidate shapes:
      - (a) Stamp the incarnation into the outbox row's resume target (`resume.projectIncarnation`) and have probe/handOver refuse to resume into a different incarnation. This is outbox-wide, so it also covers non-access queued messages.
      - (b) At delete time, withdraw (discard) every queued access row of the project. This is a second write at delete, which the design review warned against.
      Alternatively, accept it as a named residual: it needs a queued, HELD resume row (another program writing the transcript), then a delete + re-add under the same id before the hold clears.
      **Room UNTESTED (its list):** scratch delete + re-ensure over HTTP with a queued row (likely the same door); a restart-held queued row and then a re-add; SHOTS/SHOTS6; a truncated store or registry on a live server.

### 2026-10-28 — worker (BUG-284 fixing r1)
- **orchestrator adjudication of IV r8: outbox defect, filed as BUG-284:** **Decided by the orchestrator (recorded here, not the lane's decision):** the r8 break (IV ec528a8a, run 8216df1bf6c7) is in the OUTBOX, not the access code. A queued resume row is matched to its project by id alone, so after a delete and re-add under the same id a held row resumes the OLD session into the NEW project. That affects every queued message, not only access requests: a pre-existing outbox defect FEAT-200 exposed. Option (a) chosen, fixed structurally in the outbox: a queued row records the project incarnation token (FEAT-200 r8, registry.ts) at enqueue, and delivery refuses to resume into a different or missing incarnation; the row is dropped with a logged reason and an access row tells nobody "granted". (b) withdraw-at-delete lost (an extra write at delete, covers only rows it knows to look for); (c) accept the residual lost (one known-correct structural change). FEAT-200's own budget is spent, so this is NEW ticket **BUG-284** (linked both ways). **FEAT-200's residual is contained by e2e block Q until BUG-284 lands**; BUG-284 promotes Q into the default run.

### 2026-10-28 — worker (BUG-284 fixing r1)
- **BUG-284 built + IV HOLDS: block Q now in the default run:** BUG-284 (the outbox defect behind IV r8's break) is built and independently verified HOLDS (anthropic run 907ca05e-357a-4f55-9ec7-cf80006c8e9e; openai over quota). Every outbox row now records the project incarnation at enqueue (FEAT-200's enqueue/withdraw pass the request's own projectIncarnation), and delivery never resumes or starts a session into a different or missing incarnation. Block Q of verify-feat-200-access-requests.mjs now runs by default and passes. It fails on the pre-BUG-284 tree. It now also covers a plain queued message and a re-added project's own session, and new block QR covers a restart in between. The access card says "not sent…" when the outbox refused the row. Until BUG-284's files are committed alongside FEAT-200's, the residual stays contained by block Q. Full FEAT-200 e2e: 104 pass, then the known SHOTS6 screenshot flake aborted the run; the remaining blocks SHOTS6, SHOTS, C, D, Q and QR passed 37/0 on a re-run.

### 2026-10-28 — worker (FEAT-200 verifying r9)
- **Verification recorded:** dispatch anthropic run 2af93888-5e21-462c-b404-86dc8723fbdb — VERDICT: BROKEN — mixed-state candidate a870933b4654 — r9 combined tree (FEAT-200+BUG-284): all 15 docker blocks HELD incl Q,QR; outbox doors 9/0; fixer 92/0. BROKEN: a committed request queued then delete+re-add: row correctly failed, but the card reads "resume message could not be delivered - open the session", not "not sent". openai quota; Claude.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 verifying r9)
- **IV r9 BROKEN (card text after delete+re-add) - budget spent, to adjudication:** **Independent verify r9 (final, combined tree FEAT-200 + BUG-284): BROKEN. Per charter: no patch, no further round; goes to adjudication.** openai was tried first (thread 01a1812d-8a60-73c3-a1ce-690fc33db5ff, [quota-window] until 2026-11-02), so the harness fell back to Claude Opus in the same clean room: anthropic run 2af93888-5e21-462c-b404-86dc8723fbdb, mixed-state candidate a870933b4654 (22 files: the r8 set plus src/server/outbox.ts and scripts/verify-bug-284-outbox-incarnation.mjs), 21 recorded runs, recorded with board-tool verified. Author and verifier are both anthropic, so decorrelation is reduced. Requirement: /tmp/feat200-r9/iv-req.md; verdict: /tmp/feat200-r9/iv-verdict.txt (scratch).
        **HELD in the room:** fixer commit-on-success 92/0 (W29 0/400 violations, 140 re-adds); access-unit exit 0; bug-284 suite exit 0; ALL FIFTEEN docker blocks on the sandbox daemon, one recorded run each, exit 0: I, A, G, K, L, P+R, B, Y, X, U, C, D, Q, QR (Q and QR are the r8 door: held access row + plain message, delete + re-add, and SIGKILL + restart; neither resumed into the re-added project, rows failed with the reason). Its own outbox doors 9/0 (run 8c8f51e79e17): held row + re-add at a different hostPath + restart; rename + repoint + restart delivers once; scratch re-ensure across restart; Send again on a refused row; legacy unstamped row + rename delivers; row minted while registry unreadable then re-add; uncertain row + re-add + restart + Send anyway; third incarnation; held + restart same project delivers once.
        **BREAK, classified: requester/user truth on the CARD (UI text), not delivery.** Door (run 0bb38c95d85b): a request is COMMITTED (classify final) and its "access granted" row is queued; the project is deleted and re-added under the same id. The outbox correctly fails the row "not sent: the project ... was removed" and hands over nothing. But index.ts accessView marks notApplied removed only for NON-final records, so public/app.js accessStatusText renders "approved · container ready · the resume message could not be delivered — open the session to see it" instead of "not sent…", inviting the user to open a session that would then resume in the re-added project. Agent truth held (nothing false delivered); the user-facing card is wrong and steers toward the cross-project resume BUG-284 forbids for queued rows.
        **Room UNTESTED (its list):** SHOTS/SHOTS6 (run --no-shots; the card defect was shown by evaluating the real accessStatusText, not a screenshot); a TOCTOU delete + re-add during async container admission inside handOver; survivor host processes across restart + delete (accepted running-session residual); the pending cap counting undecided records already closed removed (code-read only).
        **For adjudication (not built, not a proposed round):** the remaining defect is display-only in accessView/accessStatusText for final records whose outbox row failed as gone; every delivery, authority, collision, container-survival, loop/hold, loopback and instruction-scope property held.

### 2026-10-28 — worker (FEAT-200 fixing r10)
- **r10 card text for removed/replaced projects + limit counting built (fixer):** **r10 card-text fix built (orchestrator adjudication of IV r9 2af93888), all unstaged.** regressed-from: FEAT-200 r8 (accessView marked "removed" only for non-final records; the BUG-284 card line covered only that branch).
  **Orchestrator adjudication (recorded as given):** r9's only break is copy on the card; every delivery, permission, port, container-survival, loop, loopback and scope property held across 15 docker blocks, and delivery is correct (the row is held back and marked not sent). Fixed in place as a contained render/copy change, not another design round. One classifier decides; the view does not re-derive.
  **Hypothesis check (done FIRST):** PARTLY right. The r8 classifier does NOT say "delivered": for the r9 shape it returns `{kind:'final', where:'reincarnated'}`. So it already knows the incarnation is gone, but its precedence (final > removed) puts finality first. accessView then asked only `kind === 'removed'`. I did NOT reorder `classify`. The store backstops (MAY_CLOSE in markNotApplied, markCommitted) rely on a final record never being re-closed. Instead, "removed before final" is read off the same classification through a new `projectGone(cls)`: removed, or final with where != current.
  **Changes.**
  - access-requests.ts: adds `projectGone`. Adds a pure `accessCardView(rec, cls, delivery, rebuildOf)`, which is accessView's reading moved here so it can be unit-tested. It sets `projectRemoved` and keeps any frozen outcome. It adds the display-only cause 'removed' only when there is no outcome (and never on a rejected record). A removed record is not cancellable and shows no rebuild wait. `raiseAccess`: the per-session AND per-project limits count only classOf undecided|unknown.
  - index.ts: accessView now supplies the outbox row state and rebuild wait, then calls accessCardView. The Needs-You rail lists only requests waiting for the user (undecided|unknown), so a record closed as removed is no longer a dead card on the re-added project.
  - public/app.js accessStatusText: the removed branch fires on `projectRemoved` too. The prefix is outcome-aware ("not decided:", "rejected, and", "approved, but not applied (<cause>: <reason>), and", "approved, but"). The sent part maps uncertain to "may not have reached the session; it is not resumed into another project". It never says "open/check the session". The card shows no Approve/Reject/Cancel when projectRemoved, and the session card's sig includes it.
  **Open item r9 left (limit counting): CONFIRMED and fixed.** The per-session limit counted `!r.decision`, which included undecided records already closed as removed.
  **Verified (fixer).**
  - Must-FAIL on the r9 tree (/tmp/feat200-r10/pretree):
    - unit: 9 FAIL. CV1 reproduces IV r9's exact text: "approved · container ready · the resume message could not be delivered — open the session to see it". Also CV2-5, CV8 and CV9 (rejected / cancelled / refused / save-failed / gone all said "open the session"), and CV10/10b (limit: "this session already has 3 … waiting" after all 3 were closed as removed).
    - e2e D,Q: 4 FAIL. Q5 over HTTP, project AND session list, gives the same text. Q5s light and dark on the real session view. D7: the undecided-closed request was still on the re-added project's rail.
  - After:
    - unit 98/0. New section CV: every end state in the current project (anti-regressions, including a live project's failed row still saying "open the session"), then after delete + re-add, then after a delete with no re-add, plus the limit cases.
    - commit-on-success 92/0; BUG-284 suite 14/0.
    - e2e D,Q 21/0; FULL e2e with shots (I,A,G,K,L,P,B,R,Y,X,U,SHOTS6,SHOTS,C,D,Q,QR) 140/0.
    - Screenshots: /tmp/feat200-shots/feat200-removed-card-{light,dark}.png. The card reads "approved, but its project was removed from Orchard, so it is not in effect · not sent: …", with no buttons, in both themes.
  - Gate PASS.
  **Couldn't test / observed:** the outbox's own failed-row panel below the card still offers "Send again" for a row that can never be sent. That is BUG-284's outbox UI, out of this scope, and delivery refuses it anyway (IV r9 A4). The CV section is synthetic (a real store and registry driven directly). Q5/D7 are the real HTTP path.

### 2026-10-28 — worker (FEAT-200 fixing r10)
- **Verification recorded:** dispatch anthropic run ee013774-874c-471f-ba90-332f2b403294 — VERDICT: BROKEN — mixed-state candidate c5c1723f6bae — r10 narrow IV: card text + limit counting HELD (unit 98/0 incl CV). BROKEN: cancelByUser 409 TEXT for final+gone records: closed-removed undecided says 'reject it instead' (reject is refused project-removed); committed+re-added says 'already applied and saved'. Docker blocks not run by IV.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 fixing r10)
- **IV r10 BROKEN (cancel 409 text for removed records) - reported, stopped:** **IV r10 (narrow): BROKEN. Per charter, reported and stopped (no patch).** anthropic run ee013774-874c-471f-ba90-332f2b403294 (openai blocked until Nov 2; same provider, so decorrelation is reduced). Mixed-state candidate c5c1723f6bae: the r9 set of 22 files, with 32 other-ticket hunks disclosed. Requirement /tmp/feat200-r10/iv-req.md; output /tmp/feat200-r10/iv-out.txt (scratch).
  **HELD in the room:** the unit suite exited 0, including every CV case (card text for each end state, current and removed / re-added / gone, and both limit cases), run 349e44643871; the BUG-284 suite.
  **BREAK, classified:** user truth in a 409 ERROR BODY, not on the card. Its probe was run 46bc5d4d9dab. access-channel.ts `cancelByUser`'s 'final' branch ignores `where`:
  - (a) an UNDECIDED request already closed as removed gets "cannot be cancelled: it is not decided yet (reject it instead)". But reject is refused with project-removed, so the advice is false.
  - (b) a COMMITTED request after delete + re-add gets "already applied to the container and saved", which is not true of the re-added project.
  The card offers no Cancel for either (projectRemoved), so these texts are reachable only by a direct API call or a stale tab. The fix shape is obvious and contained: use `projectGone(cls)` in cancelByUser's final branch to return the project-removed text. Not built, per charter.
  **Room UNTESTED (its list):** the docker blocks D, Q (Q5/Q5s) and QR. The verifier did not run them; the fixer ran them: D,Q 21/0, full e2e 140/0. The decide 409 body over HTTP. Card text with an unreadable registry (unknown).

### 2026-10-28 — worker (FEAT-200 fixing r11)
- **r11 cancel 409 fix + text property; closed under §N:** **r11 — cancel 409 text fixed; standing text-property assertion added; CLOSED under the WA §N stopping rule (no fresh HOLDS).** regressed-from: FEAT-200 r8 (cancelByUser's 'final' branch ignored `where`; IV r10 ee013774).
    **Orchestrator adjudication (recorded verbatim):** "r9 and r10 both broke on WORDING only: card text, then a 409 message that only a direct API call reaches. Every behavioural property held, across 15 docker blocks in r9 and the card fix in r10. Under WA §N's stopping rule (two consecutive rounds returning only wording means STOP), no further verify round is commissioned. The remaining budget becomes a standing property assertion instead."
    **Fix.** src/server/access-channel.ts `cancelByUser` checks `acc.projectGone(cls)` BEFORE the finality-based 409 texts, so a request whose project was removed or replaced (closed as removed while undecided, or committed into the removed incarnation) gets the project-removed text ("… it is not in effect, and there is nothing to cancel here"), consistent with the card and the decide route. The decide route's record-state refusal (already-decided / project-removed, texts unchanged) moved from inline index.ts into `accessChannel.decideRefusal(rec)` so it can be driven; index.ts behaviour is identical (same 409 bodies, same kickAccess on project-removed).
    **Standing property assertion (the deliverable): NEW scripts/verify-feat-200-text-property.mjs.** It drives every user-facing producer across 30 end states: undecided, undecided with a port conflict, approved-pending, granted, denied, cancelled by user edit, could not be applied, could not be saved. Each is driven in the current project, after a removal and after a replacement, and the open states are also driven after the commit pass closed them as removed. The producers are the real accessStatusText (extracted from app.js) over the real accessCardView for 7 outbox row states, the card's Approve/Reject and Cancel buttons, the Needs-You rail predicate (extracted from index.ts and evaluated), the decide and cancel routes as composed (404 no project, then decideRefusal then beginDecision, or cancelByUser), and cancelByUser called directly.
      - P1: no text claims applied / saved / container ready / open-or-check the session for a gone project.
      - P2: no text, button or rail entry suggests an action the matching route refuses. Each acceptance is probed on its own fresh fixture.
      - Discovery: every non-2xx response in the decide and cancel route blocks is inventoried from the source. A new uninventoried one FAILS, and so does a vanished one. cancelByUser's error codes, beginDecision's AccessStoreErrors, the card's button set and its exact button conditions are pinned the same way.
      - Anti-regressions A1-A7 cover the current project's truths, e.g. granted still says "applied and saved", undecided still says "reject it instead" (and reject is accepted), and a live project's failed row still says "open the session".
    **Must-FAIL on the r10 tree:** 21 pass / 7 fail (/tmp/feat200-r11/mustfail.txt).
      - P1 reproduces IV r10 (b): granted/removed (cancelByUser) and granted/replaced (cancel 409) say "already applied to the container and saved".
      - P2 reproduces IV r10 (a): undecided and undecidedConflict, removed or replaced, then closed by the pass, say "not decided yet (reject it instead)" while reject is refused project-removed.
      - Plus the inventory checks I1/I2/I3-shape/I5 (no decideRefusal yet).
    **After:** 26/0; 324 texts graded.
    **Mutation checks of the assertion itself (scratch tree copies):**
      - Reverting accessStatusText's `rec.projectRemoved ||` gives P1+P2 FAIL.
      - Adding an uninventoried 409 to the cancel route gives I1 FAIL.
      - Widening the rail predicate gives P2 FAIL.
    **Re-run:** access-unit 98/0; commit-on-success 92/0; BUG-284 outbox-incarnation 14/0; e2e D,Q,QR on the FEAT-158 sandbox daemon 21/0 (--no-shots); `npm run gate` exit 0; `orchard-leak-check --push` exit 0 (nothing to push). All work unstaged.
    **Verification status (no fabrication):** the last independent verdict is IV r10 (anthropic ee013774), BROKEN on API wording only. That defect is fixed here and contained by the property assertion. No fresh HOLDS exists for the r11 tree, and no verification entry is recorded for it. Closed under the §N stopping rule by orchestrator adjudication.
    **Not covered / residual:** agent-facing resume texts (projectRemovedTextFor etc.) are out of the assertion's user-facing scope. The unknown/unreadable-registry state is not in the end-state matrix. The decide route's "already approved; a decision is honoured once" for a decided request whose project is gone is kept as is: it is true, and it claims nothing and advises nothing. The fixtures are synthetic (real store and registry in a scratch data dir); the HTTP path was exercised by e2e D,Q,QR.

### 2026-10-28 — worker (FEAT-200 verifying r12)
- **Verification recorded:** dispatch anthropic run 8ac3c8fc-d36a-433e-a658-ac347f0bd5f2 — VERDICT: BROKEN — mixed-state candidate b2a92332a4aa. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 verifying r12)
- **IV r12 BROKEN — same property, new door (outbox running route); STOPPED per section N, structural choice:** **IV r12: BROKEN — anthropic dispatch run 8ac3c8fc-d36a-433e-a658-ac347f0bd5f2**, mixed-state candidate b2a92332a4aa (base 56dc556 -> tree ead5a3ae; 20 FEAT-200 files frozen, 32 other-ticket hunks disclosed; same-provider, openai quota blocked until Nov 2 so decorrelation reduced). verify-feat-200-text-property.mjs re-run in room: 26/0 (the r11 standing assertion HELD across its 324 texts / 30 end states, incl. P1/P2 and the whole decide+cancel non-2xx inventory I0-I10).

  **Status found (step 1):** the latest open break handed to me (IV r10 ee013774, cancelByUser 409 wording) was ALREADY fixed in the working tree by the prior session's r11 (access-channel.ts reads projectGone BEFORE finality in cancelByUser; decideRefusal extracted; NEW scripts/verify-feat-200-text-property.mjs). r11 was closed under WA section N without a fresh HOLDS. All three non-docker suites green on the tree before IV: text-property 26/0, access-unit 98/0, commit-on-success 92/0.

  **The break (step 2 classification): SAME property, NEW door — this is the section-N stop condition.** The property that has broken across r5-r10 and now r12 is: a committed/granted access message is never delivered into, and no reader is told it took effect for, a project incarnation other than the one the request was approved for. r11 made the TEXT side structural (one projectGone read before finality + the standing text assertion), and that side HELD (P1/P2 pass). But the DELIVERY side regressed through a door r8's fix left open: src/server/outbox.ts line 1165 gates the BUG-284 incarnation guard (targetOf -> 'gone' -> fail the row) behind an "if (!p.running)" test. A route that reports running:true (an already-bridged session) SKIPS the guard — fail-OPEN for this property. The verifier's adversarial run (scratch-adv/granted-into-readded.mjs, manifest bbfbf39f93cf exit=1) queued a committed request's "[station] access granted: env QX=1, continue", deleted + re-added the project under the same id, resumed the old session (now running) under the re-added project, and the message was DELIVERED (delivered=1) into it though the re-added project has env {}. This is the r8 break reopened via the running door. Secondary finding: the card for that delivered row reads "approved, but its project was removed ... the session has been told" — true that it was told, but what it was told ("access granted") is false; the "not resumed into another project" wording only appears for uncertain/failed rows, not this delivered one.

  **Reachability caveat (verifier's own UNTESTED list):** the running:true in the adversarial run is the harness fake, not a real resumed bridge; the verifier argues from reading index.ts outboxWiring.probe (bridgeForSession(sid), no project check) that a session resumed under the re-added project WOULD report running. Docker e2e blocks (I/A/G/K/L/P/B/R/X/Y/U/C/D/Q/QR) not run (no sandbox daemon in room). access-unit / commit-on-success / bug-284 suites not re-run by the verifier.

  **STOPPED per charter + WA section N — no door #5 patch applied.** The recurring property has now broken via four doors (non-running outbox route r8-fixed, card wording r9, 409 wording r10-fixed, running outbox route r12). Rather than add a fifth per-door guard, the STRUCTURAL CHOICE owed to the orchestrator: the BUG-284 incarnation guard must be fail-closed at the ONE delivery chokepoint that BOTH running and non-running routes pass through — i.e. move the targetOf/'gone' check to precede the running/not-running split so no "running" route can bypass it (ARCH-010: one guard owns the incarnation-match fact, not per-route). This spans src/server/outbox.ts and the outboxWiring.probe in src/server/index.ts (a currently shared/locked file). Scope note: outbox.ts is BUG-284's file; this finding straddles FEAT-200 and BUG-284. No code changed this round; all work unstaged. Verdict typed in verification[]; this line is the analysis, not the proof.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run f1c813d6-e63d-44ec-9d2b-04356365b843 — VERDICT: HOLDS — mixed-state candidate cf6eaa9db018. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (FEAT-200 fixing r13)
- **STRUCTURAL FIX built + independently verified (HOLDS); regressed-from: BUG-284 (its deliberate running-route skip):** r12's fifth door is closed by making the BUG-284 incarnation check the ONE chokepoint rather than adding a per-door guard.
      **Audit of every delivery / consume path (rg outbox, deliver, probe, granted, incarnation).** `wiring.handOver` has exactly ONE caller: `pump()` in src/server/outbox.ts:1223. `targetOf`/incarnation is read in exactly ONE place: `pump`. `holdNow` only probes (sets the display hold, delivers nothing); `confirmFromTranscript` only reads. `outboxWiring.probe` in index.ts selects a route (new/bridge/strand/gated/survivor/resume) and makes NO incarnation decision — so it is not a second check to route through. `deliverIntoSurvivor` has two callers: the outbox's `handOver` (via pump) and the WS `start` socket path (index.ts:7312) — the latter is the user interactively resuming/sending, gated by `outboxBlocks`, not a queued-row route; the WS `send` path (index.ts:7560) is likewise an interactive live-session send. So the only route by which a QUEUED/granted row reaches a session is pump → handOver.
      **Before:** the incarnation verdict (targetOf → same/gone/unknown; unknown→wait, gone→fail with GONE_REASON) sat INSIDE `if (!p.running)`, so the bridge/strand/gated/survivor routes (all `running: true`) skipped it — BUG-284's own r1 log named this gap ("a surviving host or live bridge of the removed project (running routes skip the check by design)"). **After:** the verdict runs unconditionally BEFORE the route is used; the `running` escape-hatch field is removed from `ProbeGo` and its 5 `running: true` annotations deleted in index.ts, so NO route can opt out and none can reintroduce the skip. Both running and non-running delivery now pass through the single chokepoint.
      **Must-FAIL (pre-fix gated tree /tmp/bug284-pretree-*, the working tree with `if (!p.running)` restored, loaded via the suite's --tree):** verify-bug-284-outbox-incarnation.mjs R5 = FAIL — "access granted" row delivered (handedOver 1, state delivered) into the re-added project through the running bridge route (this is the r12 hole). R5b PASSES on both trees. **After (working tree):** 15/0, R5 now failed-gone (handedOver 0), R5b delivered (intact project, criterion 5 preserved). Real outbox + real registry in a scratch data dir (synthetic sessions; the wiring is index.ts's exact projectIdentity).
      **Independent verify: HOLDS.** scripts/independent-verify.mjs --ticket FEAT-200, mixed-state candidate cf6eaa9db018 (outbox.ts, index.ts, the suite; 8 other-ticket hunks disclosed), anthropic run f1c813d6-e63d-44ec-9d2b-04356365b843, contract = FEAT-200 success criteria + "one chokepoint: no delivery route bypasses the incarnation check", VERDICT-CONTRACT VALID. Verifier's own adversarial cases (all four running routes × gone/unknown; access-unit + text-property regression) + fixer suite 15/0. Author and verifier both anthropic (openai quota to 11-02), so decorrelation is reduced. Verifier UNTESTED (its list): the async gap if a re-add lands while handOver is still running after the check (needs live CLI; checked statically in BUG-284 r1 — pump→targetOf→sending-write→handOver's getProject run synchronously to the first await); the real probe/handOver end-to-end (fake-CLI harness, as every outbox suite); legacy same-ms timing; an access request with no own incarnation enqueued after a re-add (bindResume stamps the new one then).
      **Anti-regressions (this tree):** gate exit 0 (leak-gate + typecheck). FEAT-200 units: access-unit 98/0, text-property 26/0. Outbox: bug-284 15/0, bug-191-adopt-window-send 39/39, bug-150-load-window-queue 16/0, bug-150-adversarial 25/0. bug-253-first-prompt-durable 41/4 — the SAME baseline (R1, R2, S + its pre-fix synthesis anchor) BUG-284 r1 recorded on both trees, not from this change.
      **Files (unstaged):** src/server/outbox.ts, src/server/index.ts, scripts/verify-bug-284-outbox-incarnation.mjs (R5 rewritten to the new contract + R5b anti-regression added). See BUG-284's log for the cross-ticket note.

### 2026-10-28 — dispatch openai (r10 bookkeeping)
- **Verification recorded:** dispatch openai run 01a184bc-4509-7cb0-bd25-ae9ca4c70e90 — VERDICT: HOLDS — VALID manifest-backed. Outbox refuses removed project incarnations across running+idle routes incl. after registry-read failures; adversarial mixed-incarnations-registry-recovery PASS.. Typed entry in the record's verification[]; this line is an echo, not proof.
