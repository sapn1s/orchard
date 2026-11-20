```orchard-ticket
{
  "id": "FEAT-208",
  "type": "feature",
  "title": "Verifiers break fixes with inputs no real user or agent produces",
  "summary": "Fixes keep going back for rework because verifiers break them with hand-crafted or impossible inputs. A blind second rater put 44% of repeat-ticket breaks in that class. The 14-day experiment gives the verifier the project threat model, makes every finding say whether it is reachable, and records unreachable ones as visible, re-openable residuals instead of failures.",
  "impact_if_we_wait": "Repeat-break tickets keep taking about two thirds of Orchard spend, and a large share of their rounds fixes inputs nobody produces.",
  "current_need": "A cross-provider review of the plan, then the build after the ticket-branch work lands, then the 4 December read.",
  "severity": "medium",
  "area": "methodology/verify loop",
  "reported": "2026-11-20",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-11-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Spend per verified ticket falls at least 15% against the 14-day baseline of $43.3",
    "Fix lanes per verified ticket fall at least 15% against the baseline of 2.07",
    "A blind audit judges at most 20% of recorded residuals reachable",
    "No residual later shows up in real use"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "ea97b196-4da3-48c1-8960-977951052db7",
      "verdict": "broken",
      "verdict_on": "2026-11-20",
      "recorded_at": "2026-11-20T03:09:49.450Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "88f1369ec5c3bbad9cf29820628d23d45667d138780b40a62242250e4821467f",
      "verify_mode": "mixed-state",
      "verifier_verdict": "broken",
      "reach": {
        "reachable": 2,
        "unreachable": 0
      },
      "threat_model": {
        "profile": "careless-agent",
        "source": "project"
      },
      "verdict_seal": "d5f514ef412b7c4f601e1c79978dfe08f0f2eb1d0ad47381d13172a1ee7a98e7"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "765c8510-e623-436a-affa-7e5f83da2253",
      "verdict": "broken",
      "verdict_on": "2026-11-20",
      "recorded_at": "2026-11-20T03:57:45.851Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "c06e77749897cd49a146a09fe019e406840b37a2f3652b5f04f16dfaee120876",
      "verify_mode": "mixed-state",
      "verifier_verdict": "broken",
      "reach": {
        "reachable": 1,
        "unreachable": 0
      },
      "threat_model": {
        "profile": "careless-agent",
        "source": "project"
      },
      "verdict_seal": "c73fe92647f5cf51ad8b3c54181e17a5f4cdfaa6da38f43f9c96bd5d36962ae7",
      "store_seq": 1
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "2cf1f572-2394-4165-a31e-b226110a1a15",
      "verdict": "broken",
      "verdict_on": "2026-11-20",
      "recorded_at": "2026-11-20T04:03:18.502Z",
      "author": "independent-verify (sealed BROKEN, auto-recorded)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b4988e2552514fb8b491c19cce8b486a5e9b213dfeb97d773497310cbe69db28",
      "verify_mode": "mixed-state",
      "verifier_verdict": "broken",
      "reach": {
        "reachable": 1,
        "unreachable": 0
      },
      "threat_model": {
        "profile": "careless-agent",
        "source": "project"
      },
      "verdict_seal": "877761da8ff68e8823d0cd51ba348206f0d295eb459d1f65ab6e20d9359dc3c7",
      "store_seq": 2
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "c14e7ee5-0a0b-4ca3-83e8-6249a42ecdde",
      "verdict": "holds",
      "verdict_on": "2026-11-20",
      "recorded_at": "2026-11-20T04:26:30.315Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "20805d70342c630e7246d19a67d2ac774f1d97b5dfb6a9b1c2f21baaa2017064",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "plan+review",
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

# FEAT-208 — Verifiers break fixes with inputs no real user or agent produces

Plan source: `~/.local/state/claude-station/scratch/optimisation-effects-2026-11-20/PLAN-EXPERIMENTS.md` (planner lane, 2026-11-20; evidence REPORT.md, FABLE-PROPOSALS.md, OPENAI-PROPOSALS.md, SECOND-RATER.md in the same directory). Baseline and re-measure script: `experiments-baseline.mjs` there.

Related, not linked: FEAT-194 and FEAT-207 overlap this experiment; FEAT-191 holds uncommitted hunks in the same files (build after it lands).

## Plan

### 0. Findings that changed the plan (read first)

1. **BROKEN per closure is partly mechanical under E1.** E1 moves UNREACHABLE findings out of BROKEN by
   definition, so a lower BROKEN count proves only that the relabelling happened. E1's efficacy metric is
   therefore **$ and fix lanes per enrolled ticket**. BROKEN per closure is kept as an engagement and safety
   metric, next to "findings per closure including residuals".
2. **No "fix-dispatch record" exists in board-tool to refuse.** Fix lanes are Task subagents, declared only
   by the charter's `Dispatch:` line, and a round-3 fixer is often a *continued* lane (FEAT-062) that no
   dispatch hook sees. A PreToolUse gate in `claude-runtime.ts` would miss continuations and Codex, and it
   needs a service restart. The one chokepoint every round passes through is **`independent-verify.mjs
   --ticket`**, which appears in about 2,600 of about 3,000 harness mentions in the last 30 days of
   transcripts (rough count). It goes live without a restart. So E2 enforces the rule there: no verify of
   a ticket that has two or more BROKEN verdicts until a complete packet is on the ticket.
3. **A reachability label set by the fixer would be the false proof the brief forbids.** Today `board-tool
   verified --verdict` trusts whatever verdict the lane types. E1 removes that freedom: the verdict and
   residuals are **derived from the harness's composed verdict file**. The fixer has no writer path for
   residuals at all.
4. **File collision.** FEAT-191 has uncommitted hunks in `independent-verify.mjs`, `board-tool.mjs`,
   `verification-source.mjs` and `ticket-schema.mjs`, and E1 and E2 both touch the same four files.
   Serialize: FEAT-191 lands → E1 → E2. Otherwise each needs its own worktree (WA §I/§J).
5. **E2 is probably underpowered at 14 days.** Over 2026-11-06..19 only 3 tickets reached a 2nd BROKEN
   with 7 days of follow-up. E1 will shrink that cohort further, because UNREACHABLE breaks stop counting.
   The 12-04 read of E2 is an engagement read. The decision read is 12-18, after one extension.
6. **Overlap with existing tickets.** FEAT-194 (threat-model scope at dispatch, not hard-blocked) and
   FEAT-207 (accumulated property list for the fixer) overlap E1 and E2. Both are open and unbuilt. E1 and
   E2 are the measured, enforced versions. Close or re-scope 194/207 against the results; do not build them
   in parallel.

### 1. Baselines (computed 2026-11-20 from real data)

Command (transcripts through 2026-11-19 via `extract.mjs`, run 01:49 today; board read live through
`ticketVerifications`, the repo's one verification reader):

```
cd ~/.local/state/claude-station/scratch/optimisation-effects-2026-11-20
node --max-old-space-size=8000 experiments-baseline.mjs --as-of 2026-11-20 --days 14 --follow 7 --json > baseline-14d-f7.json
node --max-old-space-size=8000 experiments-baseline.mjs --as-of 2026-11-20 --days 30 --follow 7 --json > baseline-30d-f7.json
node --max-old-space-size=8000 experiments-baseline.mjs --as-of 2026-11-20 --days 30 --follow 14 --json > baseline-30d-f14.json
```

Cross-check: the 30-day run reproduces FABLE-PROPOSALS' 143 BROKEN / 30 closures = 4.77 exactly.

| metric | 14 d (11-06..19) | 30 d (10-21..11-19) |
|---|---|---|
| BROKEN verdicts / closures | 37 / 12 = **3.08** | 143 / 30 = **4.77** |
| post-HOLDS BROKEN share (BROKEN on a ticket that already had a HOLDS) | 10/37 = **27%** | 49/143 = **34%** |
| E1 enrolled (≥1 typed verdict in window) | 14 | 35 |
| E1 attributed $ per enrolled ticket (mean / median) | **$43.3** / $15 | **$64.7** / $24 |
| E1 fix lanes (`phase=fixing`) per enrolled ticket | 2.07 | 3.97 |
| E2 cohort (2nd BROKEN in window, 7 d follow-up) | 3 | 15 |
| E2 $ per enrolled, 7 d after the 2nd BROKEN (mean / median) | $90.1 / $99 | **$80.9** / $51 |
| E2 BROKEN after the 2nd, per enrolled (7 d) | 2.67 | **5.00** |
| E2 fix lanes per enrolled (7 d) | 3.67 | 4.47 |
| E2 resolved (standing HOLDS) within 7 d | 1/3 | **7/15 (47%)** |
| E2, 14 d follow-up (30 d window, n=12): $ / BROKEN after / resolved | — | $83.7 / 6.25 / 6 of 12 |
| lanes on tickets already ≥2 BROKEN: with `Dispatch:` line / `phase=fixing` | 41: 38 / 21 | 169: 164 / 93 |

Definitions:
- **$** is Claude-side only (rows.json): lane + clean-room + orchestrator sessions, attributed to the first
  ticket id in the description or first prompt (REPORT.md rule).
- **OpenAI verifier spend is not included.** Codex tokens are not in the transcripts.
- **Closures and closedOn** follow REPORT.md's rule.
- Outputs are saved as `baseline-*.json`. Input hashes (sha256, first 16 hex): rows.json `ce295492b81fc5c3`,
  meta.json `418f0e28b2973b87`.

**Re-measure on 2026-12-04.** Run it in a copy, so this directory's evidence is not overwritten:

```
cp -r ~/.local/state/claude-station/scratch/optimisation-effects-2026-11-20 ~/.local/state/claude-station/scratch/experiments-2026-12-04
cd ~/.local/state/claude-station/scratch/experiments-2026-12-04
node --max-old-space-size=8000 extract.mjs
node --max-old-space-size=8000 experiments-baseline.mjs --as-of 2026-12-04 --days 14 --follow 7 --json > post-14d-f7.json
```

- If go-live (G) is later than 11-20, use `--days <12-04 minus G>` and label the read as partial.
- The extension read is on 2026-12-18 (`--as-of 2026-12-18 --days 28 --follow 7`), compared with the
  30-day baseline.
- The script also reports the post-go-live engagement fields, which read 0 at baseline:
  - `residuals_recorded`
  - `residual_reopens`
  - `unreachable_finding_share`
  - `entries_with_reach_tags`
  - `failure_packets_written`

### 2. E1 — threat model + reachability (FEAT-208)

**Hypothesis (verify FIRST).** 44% (90% CI 29–56%, cluster bootstrap) of BROKEN verdicts on repeat-BROKEN
tickets rest on crafted or synthetic input, or on scope the verifier added (SECOND-RATER). Each one buys a
fix round. If verifiers are told the declared threat model and must justify reachability, those findings
become residuals instead of rounds. **If a sample of new residuals shows the verifiers can't apply the
model (audit below), stop: the label is noise.**

#### The declared fact (ARCH-010: declared once by its owner, read everywhere)

- **Project default.** New `docs/bugs/threat-model.json` (schema `orchard-threat-model/1`):
  - `default: "careless-agent"`;
  - `profiles`:
    - `careless-agent`: ordinary use by the user, plus a careless or habitual, non-malicious agent.
      Excluded: hand-crafted inputs, fault injection, forged objects, and preconditions absent from the real
      store.
    - `adversarial`: a deliberate same-uid evader is in scope;
  - `source`: BUG-240's typed decision answer A (the user's 2026-10-08 words: *"NOT a security boundary
    against a deliberately malicious agent"*).

  The file is **pinned by sha256 in `scripts/lib/threat-model.mjs`**, as the frozen legacy snapshot is.
  `board:check` FAILs an unpinned file, so an agent edit to the user's declaration is loud. A board with no
  file, such as an onboarded project, has **no** declared model. There, reach tags are recorded but never
  convert a finding to a residual (safe default).
- **Ticket override.** An optional record key `threat_model: { profile, why, set_by, set_at }` (added to
  `OPTIONAL_KEYS`, as FEAT-191's `flow` is). It is written only by
  `board-tool update --threat-model <profile> --threat-why "…"`, which refuses an unknown profile or a
  missing `why`.
- **One reader.** New `scripts/lib/threat-model.mjs threatModelFor(boardDir, id)` returns
  `{ profile, text, source: 'ticket'|'project'|'none', residuals_enabled }`. Nothing else reads the file or
  the key.

#### Reachability on every finding

- **`scripts/lib/verdict-contract.mjs`**
  - New FINDING grammar in `CITATION_CONTRACT`:
    `FINDING: <defect> || REACH: REACHABLE|UNREACHABLE || WHY: <who or what produces this input in real use,
    or why nothing does>`.
  - `parseCitationReply` returns findings as `{ text, reach, why }`.
  - **Fail-safe parse:** a missing tag, or UNREACHABLE with a WHY under 20 characters, is parsed as
    **REACHABLE** with a `format-normalized` note. Omission can never create a residual.
  - The composed verdict emits `FINDING [REACHABLE]: …` / `FINDING [UNREACHABLE]: … — WHY: …`.
  - New export `parseComposedFindings(text)`, the ONE parser board-tool uses.
- **`scripts/independent-verify.mjs`**
  - With `--ticket` or `--candidate`, the harness calls `threatModelFor` before the room is built. Without a
    ticket, it takes `--threat-model <profile>` or the project default.
  - `composePrompt` gains a `=== THREAT MODEL (declared by the project owner; not yours to change) ===`
    block and the reach rule.
  - The final stderr adds `EFFECTIVE: HOLDS|BROKEN (raw <v>; R reachable, U unreachable)`.
  - Exit code follows the **effective** verdict: a raw BROKEN whose findings are all UNREACHABLE exits 0.
    Missing or unreadable threat-model JSON is fatal (exit 2), never silently omitted.

#### Residuals: typed, visible, countable, re-openable; no downgrade path

- **`scripts/board-tool.mjs verified`**
  - New `--verdict-file <composed verdict>`. It is **required** when the harness is independent-verify.
  - The verdict and residuals are DERIVED from the file via `parseComposedFindings`.
  - `--verdict`, if given, must equal the derived value; otherwise it is refused (`verdict-mismatch`).
  - Run id ≠ the file's run → refused.
  - There is **no** `--residual` flag or any other writer: a fixer cannot turn a REACHABLE finding into a
    residual.
- **Entry schema.** `scripts/lib/verification-source.mjs entryProblems` (and the `ticket-schema.mjs`
  per-entry checks) accept these new entry fields:
  - `raw_verdict: holds|broken`;
  - `reach: { reachable: n, unreachable: m }`;
  - `threat_model: { profile, source }`;
  - `residuals: [{ k, finding, why }]`.

  They enforce these rules:
  - residuals present ⇒ `raw_verdict: broken`;
  - `verdict: holds` with residuals ⇒ `reach.reachable === 0`;
  - every field is single-line.
- **Re-open.** New verb `board-tool residual-reopen --id T --run <run> --finding <k> --why "…" --author …`.
  - It appends `{ kind: 'residual-reopen', verdict: 'broken', reopens: '<run>#<k>', run_id: <that run>, … }`.
    Because it is a `broken` entry, the existing ONE rule (`outstandingBroken` / `isIndependentlyVerified`
    in `public/lib/ticket-record.js`) counts it with **no second rule**. The ticket is unverified until a
    later HOLDS.
  - `entryProblems` allows a duplicate run id only on that kind.
- **One residual-state reader.** `openResiduals(entries)` lives in `public/lib/ticket-record.js`, next to
  the proof rule, and is re-exported by verification-source.
- **Visible.**
  - `scripts/board.mjs` (INDEX generation) appends `· N residuals` to the row's status cell.
  - `scripts/board-status.mjs` lists open residuals.
  - The ticket view model (`ticketView`) exposes `residuals`.
- **Countable.** `board-tool query --residuals` lists open residuals board-wide.
- **Prose.** One sentence in WA §I "Generation must not verify itself", edited canonically in
  `~/projects/methodology` and then `sync:methodology`: the verifier receives the declared threat model, and
  findings carry reach. It also goes in `docs/prompts/patterns/VERIFY.md`.

#### Tests (new `scripts/verify-feat-208-reach-residuals.mjs`, registered via `gen-test-manifest`)

Must-FAIL on HEAD (each prints the observed value; WA §C):
1. `board-tool verified --verdict HOLDS --verdict-file <BROKEN, one REACHABLE>` → refused. HEAD has no such
   check: it records whatever `--verdict` says.
2. `independent-verify --ticket <fixture> --print-prompt` contains the THREAT MODEL block with the project
   text. With a ticket override, it contains the adversarial text. HEAD has no block.
3. A composed verdict whose findings are all UNREACHABLE → entry `verdict: holds`, `raw_verdict: broken`,
   `residuals.length === n`, and `board-status` prints `n open residual(s)`.
4. `residual-reopen` → `isIndependentlyVerified === false`. Only a HOLDS recorded after the reopen restores
   it.

Must-hold:

5. A FINDING with `UNREACHABLE` and an empty or short WHY, or with no tag, parses as REACHABLE.
6. A threat-model file that is missing or has a bad pin → independent-verify exits 2 and `board:check`
   FAILs.
7. A board with no threat-model file: tags are recorded, and zero residuals are created.
8. The frozen legacy pin and the existing ledger entries validate unchanged. `npm run board:check` is clean.
9. Existing suites re-run: `verify:independent-verify*`, `verdict-contract`, `board-tool`, and
   `verify-feat-191*` (shared files).

#### Harm class and rounds (WA §I table)

- **Harm class: False proof.** E1 changes what makes a ticket count as verified. Rounds: **≥1,
  cross-provider, highest priority**. Dispatch class `plan+review`: this plan is reviewed by the other
  provider before any build.
- **Parallel attack, one attacker per property:**
  - **P1 no downgrade:** no path records a REACHABLE finding as a residual or records a HOLDS over a
    reachable BROKEN.
  - **P2 residual lifecycle:** visible, countable, reopen restores BROKEN.
  - **P3 declared once:** override, pin, missing file.
  - **P4 legacy:** freeze and ledger byte-identical.

#### Kill criteria (read 2026-12-04; extension 12-18)

- **Safety, any time, immediate revert.** Any residual that later appears in real use: a user report, a
  ticket citing it, or a reopen backed by a real-use reproduction.
- **Label audit at the 12-04 read.** A blind, other-provider rater re-labels every new residual (all of
  them, if ≤30; else a seeded sample of 30). Kill if more than 20% are judged REACHABLE.
- **Engagement.**
  - Kill if `unreachable_finding_share` is under 10%: the mechanism is inert.
  - Over 60% triggers the full audit before continuing.
  - Any recorded verdict that disagrees with its verdict file is a bug: stop and fix.
- **Efficacy.** Kill if **both** of these hold versus the 14-day baseline:
  - $ per enrolled ticket is not at or below **$36.8** (−15% from $43.3);
  - fix lanes per enrolled ticket are not at or below **1.76** (−15% from 2.07).

  That outcome means a relabelling with no saving.
- **Power floor.** Fewer than 8 closures or 10 enrolled tickets is inconclusive. Extend once to 12-18 and
  compare with the 30-day baseline ($64.7, 3.97). No second extension.
- **Revert path.** Set `residuals_enabled: false` in threat-model.json (re-pinned). All findings then count
  as BROKEN again, and `residual-reopen` stays available for the residuals already recorded.

**Main risk.** A verifier over-applies "crafted" and labels a real, reachable defect UNREACHABLE, so it
ships as a residual. Mitigations:
- fail-safe parsing;
- the mandatory WHY;
- the blind audit;
- one-command reopen;
- the `adversarial` override for tickets where the user wants it.

### 4. Interaction, sequencing, attribution

- **Build order:** FEAT-191 lands → E1 → E2. Same files; serialize, or give each a worktree.
- **Go-live.** Both are script-level, so neither needs a service restart. Go-live is the build+verify date,
  recorded on each ticket.
- **Attribution.**
  - E1 is judged on all verified tickets.
  - E2 is judged only on its cohort, conditional on a 2nd **reachable** BROKEN.
  - The shared metrics (BROKEN/closure, post-HOLDS share) cannot separate the two. Say so in the 12-04
    report, and do not credit either with a shared-metric move.
- **Not done here.**
  - No concurrent control. Every ticket is enrolled, because the board is small.
  - Codex verifier spend is unmeasured.
  - The $ attribution is first-ticket-id (81% lane coverage).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-20 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-11-20 — fixing lane round 1
- **Fixing lane round 1:** Fixing lane round 1 (FEAT-208 E1 build, review must-fix C1-C7 applied). Built in worktree off f432a4b, then applied to the main tree; FEAT-191's uncommitted hunks proven byte-identical (reverse-applying the FEAT-208 patch to each shared file reproduces the 04:10 snapshot exactly; test-manifest minus the one feat-208 entry equals snapshot; ticket-schema untouched).
  WHAT: (1) docs/bugs/threat-model.json, the owner's declaration (default careless-agent per BUG-240 answer A, residuals enabled), pinned by sha256 in scripts/lib/threat-model.mjs. Per-ticket overrides exist ONLY in that file; a downgrade needs set_by "user"; an unpinned/edited file makes independent-verify exit 2 and FAILs board:check (C2). (2) scripts/lib/reach.mjs: the verifier tags every FINDING `|| REACH: REACHABLE` or `UNREACHABLE(<reason>) || WHY:`; fail-safe parse (no tag / typo / unknown reason / WHY<20 / out-of-scope / adversarial-coerced crafted|forged|fault-injection / absent-measured without a recorded `run <id>` = REACHABLE) (C3, C7). The harness composes the tag (`FINDING: [UNREACHABLE:crafted] ...`), so the label stays first and validateVerdict counts findings unchanged (C6 format). A raw BROKEN whose findings are ALL unreachable is EFFECTIVE HOLDS, exit 0. (3) scripts/lib/verdict-store.mjs: independent-verify seals every composed verdict (HMAC, 0600 key, exclusive create) in <git-common-dir>/orchard-verdicts/; board-tool verified DERIVES verifier_verdict/reach/residuals from it, refuses a --verdict that differs (verdict-mismatch), a HOLDS with no record (no-sealed-verdict), an edited record/text/reach (tampered-verdict), and a HOLDS sealed before a BROKEN already recorded (stale-verdict). No flag writes reach or a residual (C1). (4) public/lib/ticket-record.js: a HOLDS whose verifier answered BROKEN (residual-only) never clears an earlier BROKEN; openResiduals(); entry shape checks (C4). (5) board-tool residuals / residual-reopen (--all --cause=revert reopens every open residual as a typed BROKEN: the revert path, C5); residuals show in board-status and the INDEX row.
  PROOF: scripts/verify-feat-208-reach-residuals.mjs (npm run verify:feat-208, confined): 68/68 on the worktree and on the main tree; against HEAD (FEAT208_TREE=HEAD worktree) 13 pass / 55 fail, with 27 of 27 [must-fail] checks failing, including the three the charter names: fixer downgrade (B2, D6), residual-only HOLDS after a reachable BROKEN (A1, B8), verdict-file tamper (B4, B5). Anti-regressions vs HEAD, identical PASS/FAIL sets: verify-board-tool, bug-119, bug-125, bug-225 (94/1, the 1 pre-existing), feat-062, feat-097, independent-verification; mixed-state-verify + feat-170 crash identically in both trees at the same pre-M4 line (bad-ref, environment), so their verdict-record step is covered by this suite's B section instead. npm run gate exit 0 (main).
  FEAT-191 INTERACTION (needs action when FEAT-191 lands): its untracked verify-feat-191-land.mjs A6-A8 type `verified --verdict=HOLDS --branch-tip` with no verifier run, now refused no-sealed-verdict (correct under FEAT-208; its fixture needs a sealVerdict call as verify-mixed-state-verify got). The seal does not yet bind branch_tip; FEAT-191 should add it. Its other failures (branch-mode C1-C6/D2, lifecycle G2, land K4b/K7/ghost) are hook/ancestry/leak-gate refusals with no FEAT-208 signal, not baseline-compared.
  METRIC (C6): primary = BROKEN per closure plus residual counts and their later reachability, NOT $ (11-19 changes confound $; the $ success criteria above are secondary). Baseline (as-of 2026-11-20, 14 d): 37 BROKEN / 12 closures = 3.08; residual-only HOLDS 0; residuals 0; reopens 0. Go-live 2026-11-20. 12-04 read: cp -r ~/.local/state/claude-station/scratch/optimisation-effects-2026-11-20 ~/.local/state/claude-station/scratch/experiments-2026-12-04 && cd there && node --max-old-space-size=8000 extract.mjs && node --max-old-space-size=8000 experiments-baseline.mjs --as-of 2026-12-04 --days 14 --follow 7 --json > post-14d-f7.json (E1_primary block; baseline in baseline-14d-f7-e1.json).
  NAMED RESIDUALS: a deliberate same-uid forger (reads the seal key or calls sealVerdict; edits the JSON and the pin list) is out of scope (careless-agent model); `update --work-state` can still set a state the fold disagrees with (pre-existing; board:check NO INDEPENDENT VERIFICATION names it); WA/VERIFY.md prose, the UI ticketView and onboard are not updated (onboarded projects have no threat-model.json, so no residuals there). No service restart needed (scripts + a UI lib only read at render).

### 2026-11-20 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run ea97b196-4da3-48c1-8960-977951052db7 — VERDICT: BROKEN — mixed-state candidate 88f1369ec5c3. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-20 — board tool
- **Note:** @/tmp/f208r/log2.txt

### 2026-11-20 — board tool
- **Note:** (The note line above is a mistyped flag; the intended text follows.) **Independent verify round 1 — BROKEN (2 reachable, 0 unreachable).** Run ea97b196-4da3-48c1-8960-977951052db7 (anthropic/claude-opus-5-5, MIXED-STATE candidate 88f1369ec5c3; log /tmp/f208r/iv2.log). The requirement named the attack "try to get a real reachable defect closed as done". The verdict is recorded as a typed entry. Nothing was committed or pushed, as the charter requires on BROKEN.

  Findings (both REACHABLE under careless-agent):
  1. **Unbound HOLDS.** `sealedEntryFields` (scripts/lib/verdict-store.mjs) skips the ticket-binding check when `rec.ticket` is null, which is every `independent-verify --range` run. A careless agent can copy another lane's printed command, record that run's HOLDS on a ticket that carries a reachable BROKEN, and clear it to verified. Fix direction: refuse a HOLDS whose sealed record does not name this ticket. Possibly allow a --range record only when its candidate covers the ticket's files; a deny-by-default refusal is simpler.
  2. **Stale HOLDS against the store.** The stale-verdict refusal compares only against BROKENs already *recorded on the ticket*. A HOLDS sealed for the same ticket BEFORE a later sealed REACHABLE BROKEN can still be recorded if the agent never records the BROKEN. Fix direction: in `sealedEntryFields`, also scan the verdict store for any record with the same ticket and a later `sealed_at` whose effective verdict is broken, and refuse with stale-verdict.

  Both gaps are holes in C1 (the seal is the authority), not in the reach rule. The suite misses both: B9 covers only a recorded BROKEN, and no fixture uses a null-ticket record. Round 2 should add them as must-FAIL checks (B24 unbound null-ticket HOLDS, B25 newer sealed BROKEN left unrecorded) and then apply the fixes above.

  State: the work stays in the main working tree uncommitted (FEAT-191 hunks unchanged). Gate on main exited 0. FEAT-209 is closed not_a_bug.

### 2026-11-20 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 765c8510-e623-436a-affa-7e5f83da2253 — VERDICT: BROKEN — mixed-state candidate c06e77749897. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-20 — fixing lane round 2
- **Note:** @/tmp/f208r2/log-r2.txt

### 2026-11-20 — fixing lane round 2
- **Note:** (The note above is a literal @path; the intended text follows.) **Fixing lane round 2 (design review + build), then independent verify round 2: BROKEN (1 reachable).** The hypothesis held: "is this ticket verified" was decided from the ticket's own copy of its verdicts, with a separate write-time gate in board-tool. Neither read the harness's sealed store. Design choice: REDESIGN (§N 2), one decision over the store. `sealedProof` (public/lib/ticket-record.js), reached through `proofFor` / `ticketVerifications`, works like this: - A BROKEN counts if it is sealed for the ticket OR recorded on it (the union). - A HOLDS counts only if it is recorded on the ticket AND sealed for that ticket (the intersection). - A HOLDS clears only if it is clean and its store sequence number is strictly greater than every reachable BROKEN's. The number is reserved when the harness freezes its input, never taken from a clock. - An untrusted store record fails closed. - No writer can set verified/done while a BROKEN stands.  Round-2 verify run 765c8510-e623-436a-affa-7e5f83da2253 (anthropic/claude-opus-5-5, mixed candidate c06e77749897, log /tmp/f208r2/iv.log). It found that `board-tool verified` did not demote a verified ticket when the sealed BROKEN was recorded. The cause: `wasVerified` now came from the union, so it was already false. Classification: the two-break property (a HOLDS clears an earlier reachable BROKEN) HELD. No HOLDS was involved, and the decision read unverified. What broke was a different property: the stored `work_state` copy was not kept closed-consistent. It was a regression that round 2 itself introduced. So this is not a third break of that property.  Round-3 fixes: - Demotion now follows the record's stored state. - The harness records its own ticket-bound reachable BROKEN on the ticket, so an unrecorded BROKEN cannot leave the record closed. - A decision reopen never restores `verified` (owned-decision.mjs). This path was named untested by the verifier and takes effect at the next server restart. - The store path is memoized: board:check took 90 s without it, 1.6 s with it.  Suite: 94/94 (sections F and G plus D11 are new). The round-1 tree fails 16 of the 18 new must-fail F checks.

### 2026-11-20 — independent-verify (sealed BROKEN, auto-recorded)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 2cf1f572-2394-4165-a31e-b226110a1a15 — VERDICT: BROKEN — mixed-state candidate b4988e255251. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-20 — fixing lane round 2
- **Note:** **Independent verify round 3: BROKEN, THIRD break. STOPPED per the charter.** Run 2cf1f572-2394-4165-a31e-b226110a1a15 (anthropic/claude-opus-5-5, log /tmp/f208r2/iv3.log). The harness auto-recorded the typed BROKEN. Property: a HOLDS clears an earlier reachable BROKEN. New path: a verify retried on an OLDER, superseded candidate C1. The order number is reserved when the run starts, not when its candidate was frozen. So a HOLDS on C1 outranks a reachable BROKEN on the newer C2, and board-tool accepts it with --candidate=C1. Root cause: verify order is a proxy for what state was judged. Nothing binds a HOLDS to the ticket's CURRENT state. Needs independent design adjudication (WA §N, second two-break), not another round. Likely direction: a HOLDS counts only for the ticket's current candidate or tree, or order by candidate freeze time. Also open: verify-feat-164-release regresses (27 FAIL vs 17 on the round-1 tree). candidate-store ticketSatisfied now requires the sealed decision, and that suite's fixture HOLDS are unsealed. Nothing committed or pushed. Work stays uncommitted in the main tree; FEAT-191 hunks are byte-intact (/tmp/f208r2/commute.sh).

### 2026-11-20 — orchestrator
- **Rescope:** **RESCOPE to ADVISORY ONLY (orchestrator decision, WA §N after the third two-break; recorded by the round-3 fixing lane).** The goal was to MEASURE whether reachability labels could safely cut verify rounds. Letting labels change verdict state forced a redesign of the proof system; it broke 3 times and regressed verify-feat-164-release in the shared tree. Labels must prove they predict anything before they may change state. New scope: the verifier tags each finding REACHABLE or UNREACHABLE with a justification; the tag is stored with the verdict and counted; it NEVER changes HOLDS, BROKEN or closure semantics. The residual / sealed-store / threat-model-file design in the Plan above is superseded and not built. Decided by: orchestrator.

### 2026-11-20 — fixing lane round 3
- **Containment:** **Containment (round 3).** The whole round-1/2 FEAT-208 diff (13 existing files + 5 new files: docs/bugs/threat-model.json, scripts/lib/{reach,threat-model,verdict-store}.mjs, scripts/verify-feat-208-reach-residuals.mjs) is saved at ~/.local/state/claude-station/scratch/feat-208-redesign-r2r3.patch (git apply -R --check passed; after the reverse the forward patch re-applies). Every touched file is back to its pre-FEAT-208 bytes (base = /tmp/f208r2/base191, HEAD for owned-decision.mjs, test-manifest minus the feat-208 entry); the 5 new files are removed. FEAT-191 hunks identical: for all 8 files in the 04:10 snapshot, the +/- lines of git diff HEAD hash equal to the snapshot's .feat191.diff. verify-feat-164-release (confined): before 21 FAIL lines and a suite crash (TypeError at line 887); after 116 passed, 0 failed. npm run gate exit 0. Left in place as data: the sealed records under <git-common-dir>/orchard-verdicts/ and the reach/seal fields already in this ticket's verification[] (append-only; the pre-FEAT-208 validator ignores extra keys).

### 2026-11-20 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run c14e7ee5-0a0b-4ca3-83e8-6249a42ecdde — VERDICT: HOLDS — mixed-state candidate 20805d70342c. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-20 — fixing lane round 3
- **Round 3 verified:** **Round 3 build + verify (fixing lane round 3):** advisory-only reach tags, per the orchestrator rescope.

  - Built:
    - scripts/lib/reach-tags.mjs, which handles the tag grammar, the counts, an append-only log and a reader that tolerates torn lines.
    - scripts/reach-report.mjs, which gives per-ticket counts for the 2026-12-04 read.
    - scripts/verify-feat-208-advisory-reach.mjs, plus 3 real composed verdict fixtures.
  - Tiny hunks:
    - independent-verify.mjs: REACH_RULE is appended after the citation contract in both prompts. A best-effort append of the tag record runs after reportValidation, so the exit code is already fixed.
    - package.json (verify:feat-208, reach:report) and test-manifest.json.
  - verification-source, board-tool, verdict-state and closure logic were not touched.
  - Tests (confined):
    - verify:feat-208 passed 48/48.
    - The must-FAIL mutant (FEAT208_MUTANT=label-consuming) failed 6: C1-C4. Under the mutant, a tagged verdict changes ticket state.
    - Anti-regressions:
      - bug-097 PASS
      - mixed-state-verify 32/0
      - bug-225 95/0
      - feat-164-release 116/0
      - independent-verification and bug-125 (124/3) fail the same set with and without my hunks. Those failures are environment and corpus related.
  - Gate exit 0.
  - Independent verify: anthropic/claude-opus-5-5 run c14e7ee5-0a0b-4ca3-83e8-6249a42ecdde, HOLDS, mixed candidate 20805d70342c. The attack was "show that reach tags change any verification or closure outcome". The verifier's 2 adversarial runs passed with 0 failures: unusual tags through compose/validate/--check-only, and a live-append report read.
  - The verifier could not test: the real busy board, a live dispatch run end to end, and board:check/commit gate with tagged verdicts. This live run itself appended a real record to the reach log (reach:report shows FEAT-208 1 run).
  - Bucket: verification semantics, so an independent verify was warranted and was run.
