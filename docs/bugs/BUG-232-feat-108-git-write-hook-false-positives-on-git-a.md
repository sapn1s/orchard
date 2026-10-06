```orchard-ticket
{
  "id": "BUG-232",
  "type": "bug",
  "title": "FEAT-108 git-write hook false-positives on git as a plain word",
  "summary": "The FEAT-108 PreToolUse Bash-text parser treats the token `git` anywhere in a command as a git invocation, so a command that only mentions it as a word is mis-parsed as a write and denied. `command -v git; echo` was read as `git echo` and blocked. It models no shell grammar.",
  "impact_if_we_wait": "Legitimate agent Bash (`command -v git`, `which git`, a heredoc or comment mentioning the token) is refused with a denial it cannot satisfy, stalling lanes and eroding trust in the guard. The inverse risk — a real write hidden by the same tokeniser — lives on the same parser.",
  "current_need": "Enforce on the command actually executed, not on proximity of the token `git`: either parse shell grammar (separators, `command -v`/`type`/`which`, heredocs, quoting) or move enforcement off the text parser (ARCH-021).",
  "severity": "medium",
  "area": "FEAT-108 git-write block / Bash-text hook",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A command that only names the token as a plain word (`command -v git; echo`, `which git`, `echo git`, a heredoc/comment mentioning it) is ALLOWED.",
    "A genuine git write (`git commit`, `git -C x commit`, a write chained after `;`/`&&`) is still DENIED.",
    "Must-FAIL: on the current parser, `command -v git; echo` reproduces the false denial."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-021",
      "relation": "see_also"
    },
    {
      "id": "BUG-230",
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

# BUG-232 — FEAT-108 git-write hook false-positives on git as a plain word

### Evidence

Follow-up (3) in the BUG-230 fixing-r1 Activity log: `command -v git; echo` was parsed as `git echo` and denied. Reproduced while filing this ticket — a board-tool call whose argument text contained the phrase was itself blocked, so it had to be routed through a node runner.

### Diagnosis (hypothesis)

The guard is a text parser (ARCH-021 records this shape). It does not model command separators (`;`, `&&`, `||`, `|`), builtins that take a command NAME as an argument (`command -v git`, `type git`, `which git`), heredoc/quoted bodies, or comments. Any of these places the token next to a word and it is read as a subcommand.

### Not in scope

The fix direction (parse vs. relocate enforcement) overlaps ARCH-021 — linked see_also, not duplicated. This ticket records the concrete false-positive class.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.
