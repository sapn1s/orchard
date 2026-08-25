```orchard-ticket
{
  "id": "ARCH-012",
  "type": "architecture",
  "title": "A rotating secret mounted as a single file goes stale invisibly",
  "summary": "Docker resolves a file bind once and holds the inode. A token rotation writes a new file and renames over the original, so the container reads an unlinked ghost until it is recreated. Nothing errors. BUG-136 treated the one instance; the pattern is unrepresented as a thing to avoid.",
  "impact_if_we_wait": "A real project was silently logged out for two days and took three rounds to diagnose, because every natural check reports health. Any future capability that mounts a second rotating secret as a single file inherits the same silent, delayed, inspection-proof failure.",
  "current_need": "decide",
  "severity": "medium",
  "area": "container",
  "reported": "2026-08-22",
  "reported_by": "orchestrator",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-22",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Inode drift on a rotating-secret bind is a checked health signal for every such bind, not one.",
    "Either no rotating secret is mounted as a single file, or the rule that they must not be is written down and enforced.",
    "A repro exists that rotates a host credential by write-then-rename and proves the container stops reading the live inode."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [
    "BUG-136",
    "FEAT-102"
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

# ARCH-012 — A rotating secret mounted as a single file goes stale invisibly

## The structural problem
Orchard mounts a ROTATING SECRET into every project container as a SINGLE FILE bind:

    { hostPath: credentialsFile(),
      containerPath: '/home/claude/.claude/.credentials.json', readOnly: false }
    — src/server/container-manager.ts:266-271

Docker resolves a file bind ONCE, at container create, and holds the resolved INODE for the
container's whole life. The host's Claude Code does not rewrite that file in place on a token
rotation — it writes a new file and renames over the original. The original inode is then
unlinked, but the container still holds it. From that moment the container reads a GHOST: a
file that exists nowhere in the host's namespace, whose contents are the token as it stood
before the rotation.

Nothing errors. The bind is present, the path resolves, the JSON parses. The session simply
behaves as a logged-out user, and it stays that way until the container is RECREATED —
restarting it is not enough, because restart reuses the same bind resolution.

## What today established (2026-08-22, BUG-136)
A real project was logged out for TWO DAYS by exactly this. It took three rounds to diagnose,
because every check that a person naturally runs reports health: the host credential is
valid, the bind is listed in the container's Binds, the file is readable inside the container.
The only signal is that the inode inside differs from the inode outside — which nothing looked
at. BUG-136 shipped `staleFileBinds` to turn that inode difference into container drift, so
the next ensure re-binds the current file. That fix is correct and it treats the instance.

## Why this is filed as a class, not a fix
The fix is per-file and per-secret. The PATTERN — "mount a rotating secret as a single file
bind and depend on it staying fresh" — is what is fragile, and it is currently unrepresented
anywhere in the design as a thing to avoid. Any future capability that adds a second such
mount inherits the whole failure mode: silent, delayed by hours or days, and indistinguishable
from a healthy container by inspection.

Not to be fixed now (user's explicit call, 2026-08-22): getting openai dispatch working is the
priority. This ticket exists so the class is on the board rather than in one person's memory.

## Relation to FEAT-102 (openai dispatch from a container)
FEAT-102 weighed two routes. The rejected one, Option A, was to mount ~/.codex/auth.json into
every container — which is a SECOND instance of exactly this class, and the OpenAI OAuth token
rotates on the same kind of schedule. The chosen route (host-side broker over a unix socket)
adds no new secret bind, so it does not double this class. That reliability argument was the
strongest thing said against the mount route; it did not block FEAT-102 and does not depend on
this ticket being worked.

## What a real fix would have to cover (for whoever picks this up)
- The general rule, not the instance: either avoid single-file binds of rotating secrets
  (bind a DIRECTORY, or broker the secret on the host and never mount it), or make inode drift
  a first-class, always-checked health signal for every such bind rather than one.
- Detection must be cheap enough to run on every ensure, and must not require the credential
  to be parsed or its validity tested — inode identity is the whole signal.
- A directory bind is not a free win: container-manager.ts:273-274 records that you cannot
  nest a file mount inside a :ro directory mount in Docker, "which is one more reason
  ~/.claude is never mounted wholesale". Any directory-bind proposal must say what else it
  exposes.
- Whatever lands must keep the rw property that credentialsFile() has today: the CLI INSIDE
  the container refreshes the token in place, and a :ro mount silently blocks that refresh
  from reaching the host (the comment at :262-264 is the record of that earlier bug).

## Context pack (grows)
- Files/functions in play: src/server/container-manager.ts — desiredBinds() :254-365, the
  credentials bind :266-271 with its two comment blocks :262-264 and :273-274, staleFileBinds
  (BUG-136), the drift/recreate oracle documented at :250-253.
- Related tickets: BUG-136 (the live incident and the per-file self-heal), FEAT-102 (weighed
  and rejected adding a second instance of this class), BUG-107/BUG-108 (the
  pinned-and-baked provisioning doctrine any replacement must satisfy).
- Repro test: none exists. A real one would create a container, rotate the host credential by
  write-new-then-rename, and assert the container no longer reads the live inode.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-22 — orchestrator
- **Filed:** through the board tool; the record was validated before it was written.
