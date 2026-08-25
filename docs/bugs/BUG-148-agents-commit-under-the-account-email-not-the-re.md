```orchard-ticket
{
  "id": "BUG-148",
  "type": "bug",
  "title": "agents commit under the account email, not the repo identity",
  "summary": "Three commits carry a personal email in both author and committer fields while .git/config has held the correct noreply identity since 2026-08-13. No code path bypasses that config. Subagents typed the personal address onto the command line themselves, as `git -c user.email=... -c user.name=... commit`, which outranks every config file by design.",
  "impact_if_we_wait": "It keeps recurring — the most recent instance is 2026-08-25, days after global config was corrected — and each one is a metadata field no ordinary commit can fix afterwards.",
  "current_need": "State the rule where agents read it: a commit to a real repo never carries an identity on its command line. Then decide whether the command guard should refuse the pattern mechanically.",
  "severity": "medium",
  "area": "git / agent conventions",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "the source of the address is named, with evidence, rather than guessed",
    "a rule exists in the docs agents actually read",
    "no NEW commit carries a command-line identity"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
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

# BUG-148 — agents commit under the account email, not the repo identity

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — the source of the address, established rather than guessed

**The three commits.** `43e6065` (2026-08-19 00:57), `e8e25da` (2026-08-19 01:03),
`beb5ea5` (2026-08-25 10:19, and the tip at the time of writing). Author *and* committer
carry the personal address on all three; the other 361 commits carry the noreply identity.

**Ruled out, one at a time — this was not a bypass.**
- Config resolution is unambiguous: local and global both hold the correct noreply identity,
  no `[include]`/`includeIf` in either file, no system config, no `extensions.worktreeConfig`,
  no per-worktree config.
- `.git/config` has held the correct identity since **2026-08-13 03:28**, i.e. before two of
  the three commits and twelve days before the third. "Config was wrong at the time" does not
  survive the third commit.
- No `core.hooksPath`, no hooks installed, `git` is `/usr/bin/git` with no wrapper or alias,
  and no `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_CONFIG_*` / `EMAIL` in any shell profile,
  `environment.d`, `/etc/environment`, or any `settings.json`.
- No script in this repo sets the personal address; the ones that set an identity at all set
  synthetic values into scratch fixtures.
- The reflog records `beb5ea5` as a plain `commit:` in this worktree, so it was not imported
  by a cherry-pick, `am`, or a merge from somewhere with different config.

**What actually happened.** The agents overrode the config on the command line. Searching
this project's transcripts for identity overrides:

```
125  -c user.email=t@t
 12  -c user.email=a@b
  7  -c user.email=<the user's personal address>   <- redacted; this ticket is gated too
  4  -c user.email=verify@example.invalid
```

across four subagent transcripts, in forms including
`git -c user.name=… -c user.email=… commit -q -F - <<'MSG'` and
`… commit -q --amend -m …`. A command-line `-c` outranks every config file **by design**, so
a correct `.git/config` could never have stopped this. The four runs are dated 2026-08-11,
2026-08-18/19 (the two BUG-112 commits, to the minute), and 2026-08-25 07:19Z and 07:43Z
(`beb5ea5`, to the minute). The pattern has been running for two weeks.

**Where the address came from — the actual defect.** None of those agents ever ran
`git config` to read an identity; `rg "git config"` across the offending transcripts returns
nothing. So they did not derive it from config, correct or stale. They already had it: the
Claude Code harness injects a `userEmail` block — *"The user's email address is …"*, the
**Anthropic account** email — into the system context of every session and subagent. (This is
first-hand, not inferred: it is in the context of the agent writing this entry. It does not
appear in the stored transcripts because system prompts are not persisted there, which is
also why a transcript-only search would have missed it.)

An agent that wants a deterministic, non-interactive commit reaches for "the identity to
commit under", finds a personal address sitting in its own context, and supplies it — thereby
overriding the repo identity that exists *specifically* to keep that address out of the
history. The helpful act and the defect are the same act. That is why fixing global config on
2026-08-22 changed nothing: the 2026-08-25 commit came after it.

**Fix, and its honest limits.** Rule added to `docs/CONVENTIONS.md`
("Git — never put an identity on a commit command line"), which is auto-injected into
launched sessions: pass no identity to a real repo; scratch fixtures use an obviously
synthetic address and never the user's. This is a documentation fix and therefore
**probabilistic** — it competes for attention with the same injected `userEmail` that caused
the problem. The mechanical fix is one guard pattern in `~/.claude/guard/guard.py`, whose
`_PATTERNS` list already intercepts Bash commands pre-execution, denying
`git .* -c user\.(email|name)=` and `git commit .*--author=` outside scratch paths. **Not
done: that file is the user's harness config, outside this repo, and changing an agent's own
guard configuration is the user's call, not an agent's.** Recommended, awaiting approval.

**Deliberately NOT done: no history rewrite.** No amend, no filter-repo, no force-push. The
tip is not special — the next commit makes it mid-history like the other two, so an amend
buys nothing durable, and another lane was committing to this tree at the time. Two facts
for the user's decision: origin is confirmed **private**, and `origin/main`
does **not** yet carry the address — so the three commits have never left this machine. The
corollary is that the cheapest moment to rewrite is *before* the first push and it only gets
more expensive after; noted, not acted on.

**Symptom of a deeper design flaw?** Yes — an agent's injected context contains personal
identifiers with no marking of what they may be used for, and "the user's email" reads as
authoritative to an agent that needs an email. No ARCH filed: the mechanism lives in the
harness, not in this codebase, so the repo-side answer is the rule above plus the guard
pattern once approved.
