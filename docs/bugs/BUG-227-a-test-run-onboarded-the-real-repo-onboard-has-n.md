```orchard-ticket
{
  "id": "BUG-227",
  "type": "bug",
  "title": "A test run onboarded the real repo; onboard has no self-target guard",
  "summary": "During a suite sweep on 2026-09-30, something ran onboard against the live checkout. It created .orchard/, repointed 5 package.json scripts, and changed the .claude/settings.json Stop hook. onboard.mjs has no guard that refuses its own source repo, and onboarding suites are not provably confined to scratch targets.",
  "impact_if_we_wait": "Any test sweep can silently repoint the gate, board scripts and the Stop hook for every session in the repo. A lane that does not notice commits a broken gate or a hook pointed at files that are not tracked.",
  "current_need": "Add a self-target refusal to onboard() and its CLI, with a must-FAIL test; confine every onboarding suite to scratch targets. The culprit suite is not yet identified (both obvious suspects are clean today).",
  "severity": "high",
  "area": "onboarding / test isolation",
  "reported": "2026-10-01",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "onboard() and its CLI refuse a target resolving to their own source repo and write nothing; a must-FAIL test proves it.",
    "Every suite that calls onboard runs only against a scratch target and asserts the target is not the repo it runs from.",
    "A full suite sweep run from the real checkout leaves package.json, .claude/settings.json and the repo root unchanged."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-225",
      "relation": "see_also"
    },
    {
      "id": "FEAT-106",
      "relation": "see_also"
    },
    {
      "id": "FEAT-038",
      "relation": "see_also"
    }
  ],
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

# BUG-227 — A test run onboarded the real repo; onboard has no self-target guard

## What happened

On 2026-09-30 at about 17:49, the BUG-225 round-3 lane ran an anti-regression sweep from the real checkout. The sweep was `cd <repo> && node scripts/<suite>.mjs` over about 18 suites, including verify-onboard, verify-feat-106-onboard-orchard-layout and verify-ticket-schema. The REAL repo was then found ONBOARDED:
- `.orchard/` was created in the repo root.
- Five package.json scripts were repointed at `.orchard/`: `gate`, `check:nul`, `board:check`, `board:gen` and `arch:watch`.
- The `.claude/settings.json` Stop hook was repointed at `.orchard/hooks`.

The lane repaired it by hand. Evidence: BUG-225 Activity log, the "round-3 lane — Side effect found and repaired" entry. Pre-repair copies of package.json and settings.json, and the moved `.orchard/`, are kept in `~/.local/state/claude-station/scratch/bug225-r3/` (`package.json.before-repair`, `settings.json.before-repair`, `dot-orchard-removed-from-repo/`).

## Which suite did it: not yet determined

On 2026-10-01, the BUG-225 r4 lane ran `verify-onboard.mjs` (57/0) and `verify-feat-106-onboard-orchard-layout.mjs` (52/0) inside a full scratch copy of the repo, including `.git`. Neither one onboarded the copy: no `.orchard/`, and package.json and settings.json were byte-identical before and after. Both suites target mkdtemp dirs.

The suspect is a suite or an `onboard.mjs` that concurrent FEAT-106 lanes were editing at that moment. At least 9 other suites call `onboard()` or `onboard.mjs` with a computed target: check-scope, bug-118, feat-089, feat-091 response-blocks, gatekeeper, bug-146, fleet-sync, needs-you-rail and feat-076. The feat-106 suite also writes a temporary `scripts/.feat106-prechange-<pid>.mjs` into the REAL repo, to run the pinned pre-change onboard. The cause matters less than the missing guard below.

## The design gap

`scripts/onboard.mjs` has no guard that refuses to onboard the Orchard source repo itself, its own `repoRoot`. Any caller that computes a target wrongly writes into the live checkout: an empty arg resolving to cwd, a `ROOT` or `repoRoot` mix-up, or `--dir` parsing. It repoints the gate and the Stop hook that every session in that repo runs.

## Wanted

1. `onboard()` and the CLI refuse when the resolved target is the source repo. That is: target realpath equals `repoRoot` realpath, or the target's `scripts/onboard.mjs` is this file. The refusal names the path, exits nonzero, and writes nothing. If an explicit escape hatch is genuinely needed, it must be a loud named flag.
2. Every suite that onboards runs only against a scratch target (mkdtemp, or a scratch copy) and asserts it is not the repo it runs from.
3. A must-FAIL test: onboarding the source repo's own path is refused and leaves package.json, `.claude/settings.json` and the absence of `.orchard/` byte-identical.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — agent
- **Filed:** through the board tool; the record was validated before it was written.
