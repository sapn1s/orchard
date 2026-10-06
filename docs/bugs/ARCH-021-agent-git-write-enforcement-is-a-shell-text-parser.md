```orchard-ticket
{
  "id": "ARCH-021",
  "type": "architecture",
  "title": "Agent git-write enforcement is a text parser over shell",
  "summary": "The mandatory leak gate runs only when FEAT-108 classifies an agent's Bash string as a git write. Shell is a full language, so the classifier is an open-ended parser and every gap is fail-open: an unrecognised write runs with the gate skipped. Six rounds and five clean rooms each landed an ungated commit through a new shell form.",
  "impact_if_we_wait": "Each clean-room round found a fresh bypass the previous parser missed (wrappers, expanded heads, pipe-into-shell, heredoc-as-stdin, git -c config execution). The enumeration is open: any new wrapper, builtin, config key or interpreter is a latent ungated commit until noticed. A leaked commit costs a full rewrite of main.",
  "current_need": "Decide whether agent git-write enforcement stays a text classifier or gains a structural layer that runs the gate at git itself and the OS boundary.",
  "severity": "high",
  "area": "agent git-write enforcement / leak-gate trigger",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-09-30",
  "decision": {
    "mode": "single",
    "question": "Should agent git-write enforcement stay a shell-text parser, or enforce the leak gate at git and the OS boundary?",
    "options": [
      {
        "key": "A",
        "label": "Price the text-only residual",
        "what_changes": "Freeze the round-6 classifier as the only layer.",
        "benefit": "Nothing new to build.",
        "cost": "The invariant is not actually held; every new shell form is a latent ungated commit.",
        "why_not_obvious": "It is the current de-facto state, so choosing it makes the fail-open an explicit recorded choice."
      },
      {
        "key": "B",
        "label": "Enforce at git via hooks plus the shim",
        "what_changes": "Add server-installed pre-commit/pre-push hooks that run the gate, alongside the FEAT-135 PATH shim.",
        "benefit": "git invokes the hook however the string was formed.",
        "cost": "Bypassable by absolute /usr/bin/git, --no-verify, and core.hooksPath.",
        "why_not_obvious": "It raises the floor a lot but is not airtight alone."
      },
      {
        "key": "C",
        "label": "Mount .git read-only in containers",
        "what_changes": "Container sessions get the repo .git read-only; writes go through an Orchard-mediated gated path.",
        "benefit": "The kernel refuses the write; no parsing needed.",
        "cost": "Applies only to container sessions; needs a mediated write channel.",
        "why_not_obvious": "Direct host sessions are unaffected, so it is not a whole answer."
      },
      {
        "key": "D",
        "label": "Combine B for host and C for containers",
        "what_changes": "Keep the text policy as early feedback; add hooks for host sessions and the read-only mount for containers.",
        "benefit": "The invariant holds for every session class; the parser is demoted to a hint.",
        "cost": "The most work of the four.",
        "why_not_obvious": "Its residual is a small enumerable set, not any unparsed shell form."
      }
    ],
    "recommendation": "D",
    "recommendation_reason": "Only D actually holds the invariant for every session class while keeping the fast text feedback.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "No agent-session git write reaches the repo ungated, proven by a probe that invokes git through a form the text classifier does not recognise.",
    "Freezing or removing the FEAT-108 text rules does not reintroduce an ungated commit.",
    "The chosen layer's own bypasses are enumerated and either closed or recorded as accepted residual.",
    "If the text-only option wins, the open-enumeration fail-open is recorded as an explicit priced choice."
  ],
  "code_refs": [
    { "path": "scripts/lib/git-write-policy.mjs" },
    { "path": "scripts/lib/git-grant.mjs" },
    { "path": "scripts/lib/git-shim.mjs" },
    { "path": "src/server/runtime/claude-runtime.ts" }
  ],
  "related": [
    { "id": "FEAT-108", "relation": "recurrence_of" },
    { "id": "FEAT-135", "relation": "see_also" }
  ],
  "recurrence_evidence": [
    "FEAT-108",
    "FEAT-135"
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
    "confirmation": "Authored directly in the record format by the FEAT-108 round-6 fixing lane, per its charter (WA §N). There is no legacy original.",
    "dropped": []
  }
}
```

# ARCH-021 — Agent git-write enforcement is a text parser over shell

## Violated invariant
No git write from an agent session reaches the repo without the leak gate running
over its content, **however the write is invoked**.

## The design that produces this class
FEAT-108 enforces the invariant by classifying the agent's Bash **command string**:
`decideGitWrite(command)` decides whether the string is a git write, and the
mandatory leak gate (`runLeakGateForRepo`) is triggered *only when that
classification is positive*. So the gate's completeness equals the classifier's
completeness.

But the string is written in **shell**, a full language. To decide "is there a git
write in here" the classifier must correctly model command heads, `/usr/bin/git`
paths, leading assignments, no-op heads, quoting, command substitution, `sh -c`/
`bash -lc`/`-cl` code strings, `eval`, `env` (incl. `-S`), `xargs`, subshells,
wrapper commands (`exec`/`nice`/`sudo`/`timeout`/`find -exec`), expansion-obscured
heads (`git${IFS}commit`), heredocs (body-as-data vs body-as-stdin-script), pipes
and redirections into a runner, git's own command-executing config (`-c
diff.external=`, `core.pager`, `GIT_CONFIG_*`), and non-shell interpreters that
shell out. Each is a place the parser can be wrong, and **every miss is
fail-open**: an unrecognised write is allowed AND its gate is skipped. The
classifier is therefore an ever-growing parser of an undecidable surface, and the
one property that matters (the gate ran) silently degrades to (the parser
recognised it). The FEAT-135 PATH shim is a partial second layer but shares the
SAME classifier (ARCH-008) and is bypassed by absolute `/usr/bin/git`, a rewritten
shim, or a prepended PATH.

## Why local patches did not hold
Each fixing round closed the forms the previous clean room named; the next clean
room found new ones. Every patch was individually correct; the class recurred — the
signature of a wrong design layer, not wrong code.

- **Rounds 1-3** (FEAT-108): deny-by-default over git's read allowlist; `git -C`/
  `--git-dir`/`-c`, chained, `sh -c`, `eval`, `env`, `xargs`, substitution caught.
  Left reachable: the grant path skipped the gate on a compound.
- **Round 4:** compound `git add && git commit` skipped the gate; `bash -lc`,
  subshells, `env -S`, post-heredoc trailing command, `interpret-trailers --in-place`.
- **Round 5:** flipped to fail-CLOSED head handling. Closed `exec`/`nice`/`sudo`/
  `timeout`/`find -exec`, `git${IFS}commit`, `env -S` spaced, `bash -cl`, quoted-`<<`.
- **Round 6:** closed pipe/redirect-into-runner, heredoc-body-as-shell-stdin, and
  `git -c`/`GIT_CONFIG_*` config execution. Left reachable (documented): a script
  FILE piped to a shell, `python -c`/`node -e`, an expansion that builds "git", and
  the FEAT-135 same-uid shim bypass.

Six rounds, five independent clean-room breaks, one class. The parser can never be
proven complete, and the residual is always a fail-OPEN commit.

## Decision — should git-write enforcement stay a text parser, or enforce at git itself?
The options and their trade-offs are carried in the record's `decision` block above
(rendered on the Needs-You rail). In prose:

- **A — price the text-only residual.** Freeze the round-6 classifier as the only
  layer; accept that a novel shell form can bypass it. Cheapest, but the invariant
  is not held and every future shell/git feature is a latent ungated commit.
- **B — enforce at git via hooks + the FEAT-135 shim.** Server-installed
  pre-commit/pre-push hooks run the gate regardless of how the string was formed.
  Bypasses to record/close: absolute `/usr/bin/git`, `--no-verify`, `core.hooksPath`.
- **C — mount `.git` read-only in container sessions.** The kernel refuses the
  write; no parsing needed. Applies only to containers; needs a mediated write path.
- **D — combine B (host) + C (containers), text policy as early feedback.** The
  only option under which the invariant holds for every session class; most work,
  but its residual is a small enumerable set. **Recommended.**

Why the rate matters: five independent clean rooms, each fresh, each landed a real
commit on its first serious attempt — evidence the bypass surface is dense, not
exhausted, so A's "good enough" is a bet against a demonstrated adversary.

## Migration path
1. Land the round-6 text policy (done, FEAT-108) as the early-feedback layer.
2. (B) Add server-installed `pre-commit`/`pre-push` hooks that shell out to
   `runLeakGateForRepo`, installed like the FEAT-135 shim; record `core.hooksPath`/
   `--no-verify` as the next holes. Verifiable alone: a real commit fires the hook.
3. (C) For container projects, mount `.git` read-only and route writes through the
   existing loopback decide channel; verify a direct `O_WRONLY` on `.git` is refused.
4. Throughout, the text policy and grant/leak-gate machinery stay working, so there
   is no window weaker than today. Rollback at any step removes the new hook/mount.

## Proof bar — what would have to be true to call the new design right
A probe that invokes a git write through a form the **text classifier does not
recognise** still has its content passed through the leak gate — because the hook or
the RO mount, not the parser, caught it. A test that only exercises recognised forms
proves nothing. Falsifier: if the hook/mount layer's own bypasses (`--no-verify` +
`core.hooksPath` + absolute-git, or direct-session scope) leave the path as porous
as text parsing, then B/C did not change the completeness argument and A's honesty
is the better call.

## Decision record (filled in once an option above is chosen)
- **Chosen option:** … (who decided, when)
- **Explicitly rejected:** … and why

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — FEAT-108 round-6 fixing lane (filed per WA §N)
- **Understood:** five cross-provider clean rooms (FEAT-108 rounds 2-6) each landed
  a real ungated commit through a new shell form the text classifier missed. Each
  patch was correct; the class recurred. The structural cause is that the leak gate
  is triggered by a text classification of a full shell language, so the gate is
  only as complete as the parser, which cannot be proven complete.
- **Changed:** filed this ARCH ticket only. The round-6 code fixes landed under
  FEAT-108 (unstaged, same lane).
- **Verified:** n/a (decision ticket). Recurrence evidence is FEAT-108's Activity
  log (rounds 1-6) and its five clean-room verification entries.
- **Still open / handoff:** the user picks A/B/C/D. The orchestrator must flip this
  ticket's INDEX owner to 👤 so the Decide card renders. Recommendation: **D**.
