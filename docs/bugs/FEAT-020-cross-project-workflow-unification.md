```orchard-ticket
{
  "id": "FEAT-020",
  "type": "feature",
  "title": "Every project rebuilt the same agent orchestration from scratch",
  "summary": "Running several projects at once meant re-creating the same orchestration scaffolding in each one. A survey of the existing project setups found which parts recur everywhere and which are local to one project. The recurring rules were folded into the shared working agreement and synced, and the remaining platform work was filed as its own features.",
  "impact_if_we_wait": "The survey's conclusions would have decayed as the surveyed projects moved on, and the same scaffolding would keep being rebuilt by hand. Bounded: this was a study feeding rules and feature requests, and nothing running was at risk either way.",
  "current_need": "Nothing is outstanding. The shared rules were written and synced, the follow-on platform features were filed separately, and the container tier turned out to already exist.",
  "severity": "high",
  "area": "Cross-project orchestration",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Which surveyed practices should become shared rules, and which should become platform features?",
      "mode": "single",
      "options_keys": [
        "shared-rule",
        "feature",
        "local"
      ],
      "chosen": "Shared rules for the orchestration and verification discipline; separate feature tickets for the platform work; everything else left project-local",
      "chosen_on": "2026-08-04",
      "chosen_by": "user",
      "note": "Proposed for approval rather than added silently, per the working agreement. The container tier was then found to be already built."
    }
  ],
  "success_criteria": [
    "Recurring rules found in more than one project are added to the shared working agreement and synced",
    "Platform-sized proposals are filed as their own tickets rather than built inside this one",
    "Practices that only suit one project are named and deliberately left project-local",
    "The never-pause autonomous style is offered as a selectable mode, not imposed on the interactive default"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-017",
      "relation": "see_also"
    },
    {
      "id": "FEAT-019",
      "relation": "see_also"
    },
    {
      "id": "FEAT-021",
      "relation": "blocks"
    },
    {
      "id": "FEAT-022",
      "relation": "blocks"
    },
    {
      "id": "FEAT-023",
      "relation": "blocks"
    },
    {
      "id": "FEAT-024",
      "relation": "blocks"
    },
    {
      "id": "FEAT-030",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-020-cross-project-workflow-unification.md",
    "sha256": "d056e9a25d8745ebd951a24cdb1d6314dfd3da4653774b2bfe18c4bbb36f76e2",
    "bytes": 13915,
    "original_title": "Cross-project workflow unification: mine existing project setups into shared rules + station features",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original section by section: every scouted project, the four convergences, the relayed security flags, the proposed rules and the filed features are present.",
    "dropped": [
      "individual repository names of the surveyed projects, which identify third-party checkouts rather than carrying the finding",
      "the niche vendor-neutral copy-paste prompt pipeline, marked niche in the original",
      "the list of plain context-file repos with no orchestration to lift"
    ]
  }
}
```

# FEAT-020 — Every project rebuilt the same agent orchestration from scratch

## Diagnosis

### What was surveyed

The user runs roughly three projects concurrently and kept re-creating the same orchestration scaffolding in each. Read-only scouts read the setups already living in those repos and sorted each practice into one of three buckets: a universal rule, a platform feature, or something that belongs only where it was found. One project was excluded by the user, and a further breadth sweep covered eight more repos.

### What the survey found

One project ran a persistent idling container with named terminal sessions attached to it, a narrowly scoped credential mount, a file-based job queue with hardware-aware admission control, and an idle reaper that measures processor activity rather than elapsed time. A second, unrelated project had rebuilt almost the identical container and session pattern independently. A third had no orchestration at all — a plain context file and nothing to lift, which contradicted the user's expectation that it was the richest source. A fourth ran a single session looping forever over research waves, and contributed a split between append-only raw dumps and separately curated rollups, plus the idea of keeping a small root file that is a routing table into topic files.

The strongest recurring practices, each found in more than one place: the container plus named-session tier; a never-pause autonomous loop; append-only raw storage with curated rollups; choosing a model by the cost of a mistake rather than by price; and a second agent whose job is to refute the first.

The deepest single exemplar combined hardened multi-container isolation, routing into domain playbooks, two-level manager-to-subagent trees, an eight-step adversarial verification pipeline with a live-reproduction gate, and append-only findings rolled up into a dashboard. Another repo supplied the discipline that the orchestrator never implements, not even a one-line fix — an independent confirmation of what the user had been teaching in the same session.

## Evidence

### Convergence, and what it rules out

The container-and-session tier appearing near-identically in two projects that never shared code is the signal that made it the top platform candidate rather than one project's taste. The never-pause loop appearing across most of the research repos is what turned it from a rule into a selectable mode: it is dominant in that class of work and directly contradicts the interactive contract used here, so neither can be imposed on the other.

One bucket was settled empirically against the user's own prior: the project expected to be richest had no orchestration apparatus at all.

### Container and remote templates

A pair of existing templates turned out to be the canonical form of the tier the other projects had each rebuilt: a non-root session user, a keep-alive process with an activity-based idle reaper, an attach-or-create chooser so closing a window detaches instead of killing, matched ownership on mounts, dropped capabilities and memory limits, the container control socket off by default, and a credential mount narrowed to this project's memory directory rather than the whole home configuration. A separate wrapper is a working precedent for a remote tier: per-project containers, an in-container health and terminal-over-websocket agent, cookie-based auth, and stale-container recreation.

The container tier proposal was closed on the finding that this already-built template covers it.

### Relayed security observations

The scouts read only. Three findings were passed to the user without being acted on: the remote wrapper mounts one shared credentials volume read-write into every project container, so one compromised container can rewrite every project's credentials; a real environment file exists in that wrapper's directory and was deliberately not opened, so the user should confirm it is not committed; and the template's fixed port mapping collides when two projects run at once.

## Implementation notes

### What landed here

The universal rules were applied to the shared working agreement and synced: the orchestrator delegates rather than implements; model choice follows the cost of a mistake and defaults upward; verification means a second agent trying to refute the first, with live reproduction as the bar for done; autonomous and interactive are selectable modes rather than one being forced on the other. Two smaller safety rules were folded in: terminate by process group rather than by the most recent background job, and snapshot shared append-only state before mutating it.

### What was filed elsewhere

The platform-sized proposals became their own tickets rather than being built inside this survey: the autonomous never-pause mode with an explicit stop condition, the remote control plane, and reusable dispatch templates for manager-to-subagent trees, routing tables, raw-plus-curated memory, and a numbered go/no-go checklist that must pass before work begins.

### Deliberately left local

Graphics-hardware tuning, one project's domain-specific scoring metric, its pinned toolchain, and another's plugin runtime and deployment topology. Also left local: the aggressive autonomy stance that bans asking strategic questions and enforces it with a stop hook. It suits a single-user, resource-bound setting and is kept as a selectable mode, never a universal rule.

## Verification plan

The two named suites for subagent and container behaviour are the checks that would exercise the filed follow-on features. Nothing in this ticket's record reports either of them being run, and this ticket's own output was documentation and further tickets rather than shipped behaviour.

## Risks

### Where this can go wrong

The survey's conclusions are a snapshot of other repositories at the time they were read, and those repositories continue to change. Lifting the container template also carries a naming constraint: the container name has to match the convention the tool derives from the working directory, or stored memory silently fails to persist. The remote tier remains gated on the shared-credential-volume and transport-security issues noted above.

The web interface in the remote precedent binds only to the local machine today and would need transport security and authentication before being exposed.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. external-project-G + external-project-A scouted first; external-project-B, external-project-F,
  docker-template meta-infra, and a breadth-sweep dispatched. Synthesis → a
  proposed WA delta + feature tickets once scouts return.
- 2026-08-04 — appended external-project-A / external-project-B / external-project-F scout results; convergence noted. docker-template meta-infra + breadth-sweep dispatched next.
- 2026-08-04 — appended breadth-sweep (8 repos). integrity is the standout exemplar; external-project-C's orchestrator-never-implements rule validates WA §I. Awaiting docker-meta scout, then synthesis.
- 2026-08-04 — all 6 scouts in; docker-meta gives the concrete container/remote spec + security flags. Synthesis drafted; WA delta + feature set proposed to user for approval.
- 2026-08-04 — §B CHECK: claude-station ALREADY has the container tier
  (`src/server/container-manager.ts`, `src/server/container/`, per-project
  containers, docker-socket opt-in, orphan sweep, `verify:container` 13/… ). The
  proposed 'Container session tier' is therefore NOT rebuilt. Remaining container
  delta = the LIGHT `sandbox` (bwrap) tier still returns 501 (unimplemented) —
  fills none→light→full (§E); optional: audit existing hardening vs the
  external-project-O-linux posture (narrow cred mount / socket-off / CapDrop).
- 2026-08-04 — WA additions applied + synced live (9396 bytes). Features filed:
  FEAT-021 (session boots aware / memory), FEAT-022 (autonomous mode), FEAT-023
  (remote tier), FEAT-024 (workflow-pattern templates).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
