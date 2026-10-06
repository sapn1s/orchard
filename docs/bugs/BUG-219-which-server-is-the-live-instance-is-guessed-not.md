```orchard-ticket
{
  "id": "BUG-219",
  "type": "bug",
  "title": "Which server is the live instance is guessed, not declared",
  "summary": "Orchard decides which running server is the live one by whether its data directory was left at the default, instead of reading a declared marker. A second server whose data directory was moved another way is therefore treated as live. It may then rebuild or remove containers and base images the real live server owns.",
  "impact_if_we_wait": "This only bites when a second server runs with its data directory moved through the home or data-home path rather than the explicit setting. When it does, that server can rebuild or delete the real live server's legacy containers and images. No user data is touched.",
  "current_need": "Declare the live instance explicitly, for example by having the service unit set an instance marker, and read that marker instead of inferring liveness from an unset data directory.",
  "severity": "medium",
  "area": "Container instance ownership",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "the live instance is declared by its owner (service unit or boot) and read from that declaration, never inferred from an unset data directory",
    "a second server with a data directory moved through HOME or XDG_DATA_HOME is treated as non-live and adopts no unlabelled container or image",
    "a test plants a live server plus a second server on a moved data dir and proves the second cannot act on the first's images"
  ],
  "code_refs": [
    {
      "path": "src/server/instance-owner.ts"
    }
  ],
  "related": [
    {
      "id": "ARCH-022",
      "relation": "superseded_by"
    },
    {
      "id": "ARCH-010",
      "relation": "see_also"
    },
    {
      "id": "BUG-218",
      "relation": "see_also"
    },
    {
      "id": "FEAT-158",
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

# BUG-219 — Which server is the live instance is guessed, not declared

## Evidence
From BUG-218 verifying round 4 (2026-09-30): "shared" is defined as `CLAUDE_STATION_DATA` unset (`mayActOn`, FEAT-158), so a second server with no `CLAUDE_STATION_DATA` but a data dir moved through `HOME`/`XDG_DATA_HOME` also counts as the live/shared instance and may Rebuild over an unlabelled base image. That matches the accepted decision's WORDING (unset knob) but not its REASON (the one live server the service runs). It was flagged there for this follow-up.

## Violated invariant
ARCH-010: a fact a reader acts on is declared once by its owner and never inferred. "Which server is the live instance" is currently inferred by every reader from the absence of an env var; the owner — the service unit that launches the live server — never declares it. The inference has a second possible answer (a data dir moved another way), which is exactly the ARCH-010 failure this project decided to eliminate as a class.

## Fix design
Declare the live instance at its source: the systemd `--user` unit (or the boot path) sets an explicit flag or instance id on the one server it runs as live. `mayActOn` / `refuseForeign` read that declared marker instead of `!process.env.CLAUDE_STATION_DATA`. Every other server — a scratch server, a second instance, a moved data dir — is non-live by default and adopts no unlabelled object. Keep the isolation knob for data-dir location; stop overloading its absence to also mean "I am the live instance".

## Build queue
Build queued behind FEAT-157 (same files: container-manager.ts / index.ts; also instance-owner.ts).

## Symptom of a deeper design flaw?
Yes — ARCH-010 (facts inferred by each reader instead of declared by their owner). This ticket is the concrete instance for the live-instance fact; tracked under that ARCH.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — worker
- **Note:** Folded into ARCH-022 (container lifecycle has no single owner): this is the same live-container class as BUG-214's 8 clean-room breaks. Build it as a step of ARCH-022's migration path, through the single lifecycle authority, not as a standalone guard.
