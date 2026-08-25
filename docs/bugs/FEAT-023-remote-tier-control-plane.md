```orchard-ticket
{
  "id": "FEAT-023",
  "type": "feature",
  "title": "Running sessions on another machine is not possible yet",
  "summary": "Sessions can only be driven on the machine they run on. This is a parked design for driving containerised sessions from a browser, including across machines. It was deliberately sequenced behind earlier container work, and it carries hard security requirements before anything could be reached over a network.",
  "impact_if_we_wait": "Cross-machine work stays impossible and the design stays cold. Bounded: nothing breaks, no shipped behaviour is affected, and no user data is at risk — the ticket is a parked design, not a defect.",
  "current_need": "Confirm the ticket stays parked behind the earlier container work, or re-prioritise it.",
  "severity": "low",
  "area": "Remote session control plane",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-04",
  "decision": {
    "mode": "single",
    "question": "Should this stay parked behind the earlier container work, or be re-prioritised now?",
    "options": [
      {
        "key": "A",
        "label": "Keep it parked",
        "what_changes": "Nothing is built; the design and its security gates stay on record until the earlier work lands.",
        "benefit": "No effort spent on a large feature whose foundation is still being built.",
        "cost": "Cross-machine working stays unavailable for as long as the earlier work takes.",
        "why_not_obvious": "A parked design ages against the code it was scouted from, so parts of it may need re-scouting when it does start."
      },
      {
        "key": "B",
        "label": "Start it now",
        "what_changes": "Work begins on the browser-driven remote tier ahead of the container work it was sequenced after.",
        "benefit": "Cross-machine working arrives sooner.",
        "cost": "It would be built on foundations that are still moving, so parts would be rewritten.",
        "why_not_obvious": "Its security requirements are blocking, and rushing them is how sessions or credentials end up exposed on a network."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "Its size and blocking security requirements make starting before the foundation lands more expensive than waiting.",
    "prerequisite": "Establish whether the earlier container and transport work is still on track. If it has stalled, parking stops being sequencing and becomes indefinite."
  },
  "decision_history": [],
  "success_criteria": [
    "A per-project container is created and its in-container agent answers a health check",
    "A terminal session is driven over a websocket to a container and torn down cleanly",
    "No container can read another project's credentials",
    "Nothing binds beyond loopback until encryption and a login are in place"
  ],
  "code_refs": [
    {
      "path": "container-manager.ts",
      "symbol": null,
      "note": "reuse the existing container manager rather than the scouted wrapper's own; FEAT-023 is a control-plane and transport layer over it"
    }
  ],
  "related": [
    {
      "id": "FEAT-020",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-021",
      "relation": "depends_on"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-023-remote-tier-control-plane.md",
    "sha256": "93c1174120ab123212c47329d7696ffcce0bbae72c9ca32633e9b66d5e5fef86",
    "bytes": 2470,
    "original_title": "Remote tier / control plane (drive sessions in containers on another machine)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "The parked recommendation, the triage ask, the three blocking security gates, the reuse instruction and the loopback-first verification order are all present above.",
    "dropped": [
      "the reference-material framing note that introduced the detailed sections"
    ]
  }
}
```

# FEAT-023 — Running sessions on another machine is not possible yet

## Evidence

Design lifted from a scout of the external-project-P project on 2026-08-04: per-project containers managed programmatically, an in-container agent exposing a health endpoint and a terminal-over-websocket channel, and cookie-based token auth.

## Implementation notes

### Shape

Per-project containers with create/stale-check/recreate handling, an in-container agent exposing `/health` and `/ws/terminal`, and JWT-cookie auth.

### Reuse

Build on the existing `container-manager.ts` rather than porting the wrapper's own manager. This ticket is a control plane and transport layer over container support that already exists.

### Security gates (blocking)

- TLS and authentication are required before binding beyond `127.0.0.1`.
- Do not copy the wrapper's shared read-write `claude-auth-data` volume — one compromised container could rewrite every project's credentials. Use the narrow per-project credential bind from the Linux docker template posture instead.
- The docker socket stays off by default.

## Verification plan

Loopback only first: create a project container, health-check its agent, drive a terminal over a websocket, then tear it down. Assert that no container can reach another project's credentials. The auth and TLS gate is verified after that, before anything binds beyond loopback.

## Risks

Done carelessly, this exposes sessions or credentials over a network. The shared credential volume in the source design is the specific trap: it makes one compromised container able to rewrite all projects' credentials.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. User deferred to recommendation: sequence after boot-aware + autonomous.

### 2026-08-20 — you (answer · via ticket view)
- **Question:** Should this stay parked behind the earlier container work, or be re-prioritised now?
- **Answer:** uhm what, what does this mean, not being able to control a sessionw ithin a container? im pretty sure it already works? or what do u mean
- **State:** answered — awaiting agent action (not dispatched)
