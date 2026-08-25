```orchard-ticket
{
  "id": "BUG-154",
  "type": "bug",
  "title": "Socket dialog says the access is permanent, when the damage is",
  "summary": "The Docker socket confirmation said \"This cannot be undone for work already done inside the session\", and the user read it as a claim that the mount is permanent. It is not: turning the toggle off and rebuilding removes the socket the same way turning it on added it. What survives is what the session did while it had it.",
  "impact_if_we_wait": "The one control that hands a session root on this machine is the one the user cannot parse. Some will refuse a reversible setting; worse, some will decide the warning is loose and discount the part of it that is true.",
  "current_need": "Independent read of the new consent text by someone who has not read the code: does it now say the access is reversible and the consequences are not.",
  "severity": "medium",
  "area": "Settings drawer / security consent",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The confirmation separates the reversible grant from the irreversible consequence, in plain words",
    "The wording is true of this machine s daemon, established by checking it rather than inherited from the old text",
    "It says when turning it off takes effect, since a running container keeps the socket until it is rebuilt",
    "Neighbouring lines on the same screen that imply a setting is already live are corrected too",
    "It reads at a glance in both themes, still short enough for a confirmation row"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-154 — Socket dialog says the access is permanent, when the damage is

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — worker
- **socket consent text: the access is reversible, the consequences are not:** What I understood: the user read the armed socket confirmation and could not tell what it claimed. "This cannot be undone for work already done inside the session" reads as "the mount is permanent". Their technical reading was right: the flag is a bind (container-manager desiredBinds), so turning it off and letting the container be recreated removes the socket exactly the way turning it on added it. What survives is what the session did while it had it.

  Checked before rewriting, rather than inheriting the old text's assumption: this machine runs a ROOTFUL daemon (docker info DockerRootDir=/var/lib/docker, SecurityOptions has no name=rootless, /var/run/docker.sock is root:docker mode 660), so the "root on this machine" clause is not overstated. The browser cannot inspect the daemon, so the wording now scopes the reach to "any path the daemon can reach" (exact on a rootless daemon too, where it still means the whole of that user's home, keys and every other project) and flags the rootful case as the usual kind rather than asserting it.

  What changed (public/lib/drawer.js only):
  - armed confirmation, three beats: what it grants ("the daemon socket: containers of its own, mounting any path the daemon can reach"), what that means ("on a rootful daemon - the usual kind - that is root on this machine, and every limit set above stops applying"), and what turning it off does and does not undo ("removes the socket at the next container rebuild; it does not undo what was done with it - files written anywhere on the host, and containers left running, outlive it"). Net shorter than the old copy, 9 rendered lines down to 8, 98 words for the whole block.
  - the confirm row beside Cancel / Turn it on anyway is now the one-line takeaway: "The access is reversible. What it is used for is not."
  - the ON state (where a user goes to turn it off) says the same thing: off takes the socket away at the next container rebuild, and undoes nothing already done through it.
  - NEIGHBOUR, same defect class: the container block's rows read as a description of what is running, but a setting here is only a request until the container is recreated (ensureContainer recreates on drift, and the route refuses to while sessions are live). The server already computes `drifted`, so when it is set the block now says "Changed since this container started. It keeps the mounts, socket flag and limits it was created with until you rebuild."

  Verified - scripts/verify-bug-154-socket-consent-wording.mjs, 31 PASS / 0 FAIL. It drives the REAL app in headless brave over a realistic container project (isolation=container, two mounts, a running-looking container), clicks the REAL toggle to arm, and reads what the user reads in BOTH themes; the ON state is reached by clicking "Turn it on anyway" on the SYNTHETIC project, never a real one. Only /container/status is stubbed (settled vs drifted), because reaching those states otherwise means creating a container. MUST-FAIL proof against the committed pre-fix drawer.js: 20 PASS / 11 FAIL, including "the old sentence is GONE", every "turning it off" clause, and the drift line.

  Read the screenshots myself in both themes (armed dark, armed light, drifted dark, on dark/light, ~/scratch/bug-154/shots/) - the first draft was a 9-line wall, so the copy was tightened into the three beats above before re-verifying.

  Anti-regression, all on this tree: verify-bug-075-mount-chip 9/9, verify-bug-088-tool-settings 11/11, verify-feat-101-slide-panels 31/31, verify-bug-152-browser-degrades 25/25. verify-session-scope is 8 passed / 2 failed - PRE-EXISTING, identical 8/2 on the committed drawer.js (model-row "inherited" tag, untouched by this change). npm run gate: PASS, exit 0 read directly.

  Still open / handoff: the dialog cannot inspect the daemon, so the rootful clause stays a hedge. The server could report rootless-ness from `docker info` SecurityOptions and let the text state it flatly; that is a server+UI change and was left out of a wording fix. Risk bucket: security-surface copy plus one new UI line, no behaviour change - an independent clean-room pass is worth it for the claim's accuracy (does the new text survive a reader who has NOT read the code), not for regression risk.

  Symptom of a deeper design flaw? no - the mechanism was right, only the sentence describing it was imprecise. The neighbour drift line is the structural half and it is fixed here.

### 2026-08-25 — worker
- **committed:** Committed as 303f851 (public/lib/drawer.js, scripts/verify-bug-154-socket-consent-wording.mjs). Not pushed.
