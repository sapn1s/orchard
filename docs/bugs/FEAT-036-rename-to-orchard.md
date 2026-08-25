```orchard-ticket
{
  "id": "FEAT-036",
  "type": "feature",
  "title": "Project keeps its old internal name while the product is rebranded",
  "summary": "The product is presented everywhere as Orchard, but the repository, working directory and service still carry the original internal name. A full path rename was scoped and then declined on 2026-08-05, because moving those paths is a live migration of the service unit, the assistant's memory directory keying and the git remote for purely internal gain.",
  "impact_if_we_wait": "Anyone reading the code meets one name and anyone using the product meets another. Bounded: this is a naming mismatch behind the scenes only. Nothing users see, no data and no running service is affected by leaving it alone.",
  "current_need": "Nothing is outstanding. The rename was inventoried, priced against the live migration it required, and closed as won't-do; the user-facing rebrand shipped separately.",
  "severity": "low",
  "area": "Project naming",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Should the repository, directory and service paths be renamed to match the product name?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-05",
      "chosen_by": "user",
      "note": "Leave the folder, repository and service path on the original internal name; the user-facing brand is fully Orchard across the interface, favicon, wordmark and launcher. The rename was judged a risky live migration for internal-only value."
    }
  ],
  "success_criteria": [
    "The product name a user sees is Orchard throughout the interface and launcher",
    "The service, launcher and containers keep resolving on their existing paths"
  ],
  "code_refs": [
    {
      "path": "package.json",
      "symbol": "name",
      "note": "carries the original project name, deliberately left unchanged"
    },
    {
      "path": "scripts/station-open.sh",
      "symbol": null,
      "note": "launcher script named after the old project; the desktop entry it backs came from FEAT-028"
    },
    {
      "path": "src/container-manager.ts",
      "symbol": null,
      "note": "container and image names embed the old project name"
    },
    {
      "path": ".mcp.json",
      "symbol": null,
      "note": "hard-codes the project path that a directory rename would break"
    }
  ],
  "related": [
    {
      "id": "FEAT-028",
      "relation": "see_also"
    },
    {
      "id": "FEAT-035",
      "relation": "see_also"
    },
    {
      "id": "FEAT-049",
      "relation": "superseded_by"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "exempt",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-036-rename-to-orchard.md",
    "sha256": "3cab563c8394524466b9d26e39921f242a468ad799173dbc975deb4aab8b4250",
    "bytes": 1933,
    "original_title": "Rename claude-station → Orchard (repo / dir / service / paths)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the provider-agnostic goal, the full ripple list, the staged approach, and the won't-do rationale are all present above.",
    "dropped": [
      "the exact command named for renaming the hosted repository",
      "the literal memory-directory encoding string, which is machine-specific"
    ]
  }
}
```

# FEAT-036 — Project keeps its old internal name while the product is rebranded

## Diagnosis

The goal was a provider-agnostic name for the whole project, on the reasoning that one engine is not the product. The obstacle is that the old name is not only a string: it is the on-disk directory, and the assistant's memory directory is keyed by an encoding of that directory path, so moving it loses continuity unless the memory files are migrated too.

## Evidence

The rename surface was inventoried before the decision: the hosted repository name, the local directory path, the package name, the service unit, the desktop launcher and its opener script, container and image names, the project path recorded for the tool server, and documentation references. The listening port was to stay unchanged either way.

## Implementation notes

The intended sequence, had it gone ahead, was to enumerate every occurrence with a structural search, rename in stages, re-point the service unit and launcher, and check end to end that the service, launcher and containers still resolved. The user-facing branding was explicitly separable and was allowed to land first, since the product name shown in the interface does not have to match the repository name.

## Migration and rollback

This was closed without a build, so no migration ran and there is nothing to roll back. The reason it was closed is the migration itself: the service unit paths, the memory-directory keying and the git remote would all have had to move together on a live system.

## Risks

Renaming the directory breaks the memory-directory encoding and drops accumulated continuity. The service unit and desktop launcher point at absolute paths and would stop resolving until re-pointed. All of this is risk taken on for value that never reaches a user.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Deferred; FEAT-035 (branding) proceeds first. Big careful refactor — its own pass.

### 2026-08-05 — orchestrator
- User decided: leave it. Launcher already renamed to Orchard; path rename closed as won't-do.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
