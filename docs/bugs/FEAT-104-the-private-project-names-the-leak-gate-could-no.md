```orchard-ticket
{
  "id": "FEAT-104",
  "type": "feature",
  "title": "the private project names the leak gate could not see",
  "summary": "Real private project names were still sitting at HEAD in ticket prose, a source comment and a Dockerfile, because no leak-gate token covered them. One case, in an archived cross-project ticket, was a PARTIAL scrub that read as finished: some names in the sentence were aliased, the rest left verbatim beside them.",
  "impact_if_we_wait": "The names ship the first time this repo is published, and the gate reports PASS while they do — the failure mode is a green check over a leak.",
  "current_need": "Alias the remaining names in the style the earlier scrub used, add the class to the gate token list so it cannot go invisible again, and hoist the .arch ignore rule into the root .gitignore.",
  "severity": "high",
  "area": "leak-gate / docs",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "the gate FAILS on the class before the scrub and PASSES after, with the hit count recorded both times",
    "no private name survives anywhere in the working tree",
    "the alias-to-real-name mapping exists nowhere in the repo",
    "docs/bugs/archive/ files differ ONLY by the aliasing"
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

# FEAT-104 — the private project names the leak gate could not see

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — scrub + gate token class + ignore hoist

**What the audit actually found.** The brief named four files; the real surface was
**26 hits across 9 files**, because the short forms used in prose — the same names with the
vendor prefix filed off, and in one case a possessive — would have survived a scrub aimed only
at the full spellings. (Those short forms are not quoted here: this ticket is gated too.)
The token regexes are
therefore anchored on the distinctive stem, not the full name, so the short forms cannot
come back.

**Must-FAIL proof, in that order — the tokens went in BEFORE the scrub.**
- Baseline, tokens absent: `node scripts/leak-gate.mjs` → **PASS, 0 hits / 851 files, exit 0.**
  This is the defect stated as a number: the gate was green while the names were present.
- Tokens I–P added, nothing else changed: → **FAIL, 26 hits / 9 files, exit 1**
  (`<scratch>/hist-audit/gate-mustfail.txt`). Every hit is a real private name; no
  false positives. A token added without this step is decoration.
- After the scrub: → **PASS, 0 hits / 851 files, exit 0**
  (`<scratch>/hist-audit/gate-after-scrub.txt`).

**The partial scrub.** `archive/FEAT-020` line 120 was the dangerous one: `external-project-C/D/E`
already appeared four lines above, so the file read as finished, while four real names sat
verbatim in the sentence below. Finished in the same style. The sentence still says what it
said — which projects had plain context files and which only ran the loop — with the names
aliased rather than the clause deleted.

**Meaning preserved where the name was load-bearing.** Two places would have become nonsense
under a blind find-and-replace, because a *prefix* of the private name was the point:
- `archive/BUG-009` reproduces a finder bug by typing `'#disc'` and completing to the full
  project name. The typed prefix was re-cut to `'#exte'` so it is still a prefix of the alias;
  otherwise the repro step no longer reproduces anything.
- `public/app.js:1270` had the same prefix-then-completion example in the grammar comment,
  re-cut the same way. (`discord-style` on the line above is left alone — that is Discord the
  application, describing `#`-channel scoping, not the project.)

**Archive integrity.** `docs/bugs/archive/` holds the only verbatim copies of 194 original
tickets. Four archived files were edited — `BUG-009`, `FEAT-020`, `FEAT-023`, `FEAT-033` —
and **the edits are the aliasing and nothing else**: no reflow, no reformatting, no content
change. Stated here rather than left for someone to infer from a diff, because the whole
value of that directory is that it is untouched unless a ticket says otherwise.

**Where the mapping lives: nowhere.** Aliases are `external-project-I` … `external-project-P`,
continuing the existing A–H. The alias↔real-name key is deliberately absent from the repo,
and the gate now enforces that — writing the mapping into this ticket would fail the very
check this ticket added. The letters are matched to token names in `scripts/leak-gate.mjs`
so the scheme is decipherable by anyone who can already see the token list.

**One extra scrub, flagged rather than smuggled.** `src/server/container/Dockerfile:4` cited
the template by an absolute private path, `~/random_projects/<name>/Dockerfile.claude`. The
project name had to go (gate). The `random_projects` directory went with it because keeping
half a private path to preserve a reference the reader cannot follow anyway is not worth it.
The comment still says what it needs to: derived from that project's own Dockerfile, do not
edit that copy.

**Ignore hoist.** `docs/bugs/.arch/` was ignored only by a nested `.gitignore` containing `*`
— which works, and is invisible to anyone auditing the root file. Rule moved to the root
`.gitignore` with a comment saying what the directory is and why it is never committed.
Verified the root rule alone is sufficient before removing the nested file: `git check-ignore -v`
attributes both `.arch/findings.json` and `.arch/acks.json` to `.gitignore:42` with the nested
file gone, and nothing under `.arch/` appears as untracked. Nothing there was ever tracked
(`git ls-files docs/bugs/.arch/` is empty), so no history is involved. The removed nested file
(one line, `*`) is preserved at
`<scratch>/orchard-backup-20260825/nested-arch-gitignore.bak`.

**Anti-regression.** `npm run gate` (leak-gate + check-nul + typecheck) read unpiped, exit 0.

**Not done, deliberately:** history is untouched. The names remain in old blobs; nothing here
rewrites them. See the handback note — that is a separate decision for the user.

**Symptom of a deeper design flaw?** Yes, and it is the mechanism this ticket already fixes:
the token list is an allowlist of names someone remembered, so its blind spots are silent by
construction — a name nobody thought of produces PASS, which is indistinguishable from clean.
The audit that caught this was a human-directed sweep, not the gate. Worth considering a
complementary check that flags *candidate* private-looking identifiers for review rather than
only matching known ones; not filed as ARCH pending the user's view on whether the noise is
worth it.

### 2026-08-25 — the archive integrity check the scrub broke, and the re-pin

Editing an archived original is not a free act here, and the board proves it. Each migrated
ticket records `source.sha256` + `bytes` of the file it derives from, `docs/bugs/archive/INDEX.md`
repeats them in a manifest table, and `scripts/verify-bug-125-wrapped-verdict.mjs` re-hashes
every archived original on every run:

> `the archived original is VERBATIM — its bytes still hash to the sha256 the record derives from`

**It caught the scrub, by name, unprompted:** before the re-pin that suite was
**48 passed / 1 failed, exit 1**, and the failure listed exactly the four files this ticket
edited — `BUG-009`, `FEAT-020`, `FEAT-023`, `FEAT-033` — and no others. Recorded here because
it is the best independent evidence that the edits touched nothing else in that directory:
an unintended fifth file would have appeared in that list.

**Re-pinned** the four `source.sha256`/`bytes` pairs in the parent tickets and the matching
four rows of `archive/INDEX.md`, to the new bytes:

| ID | sha256 | bytes |
|---|---|---|
| BUG-009  | `e3aa0fab…` → `f89fcb06…` | 6088 → 6091 |
| FEAT-020 | `c9a5107e…` → `d056e9a2…` | 13870 → 13915 |
| FEAT-023 | `463dec7e…` → `93c11741…` | 2473 → 2470 |
| FEAT-033 | `50b19439…` → `de87c593…` | 9201 → 9202 |

After: **49 passed / 0 failed, exit 0.**

Re-pinning is the honest move here and not a way around the check: the check asks "do the
archived bytes still match what this record says it derives from", and after a sanctioned edit
the truthful answer requires updating the record. Leaving the old hashes would have left the
manifest asserting something false while the suite stayed permanently red — a broken check
nobody can distinguish from a real breach. The old values are written above so the edit is
reversible and auditable from the ticket alone. **This is the only reason those four archived
files changed; the aliasing is the only content change in them.**
