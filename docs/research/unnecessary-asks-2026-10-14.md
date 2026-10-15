# Why orchestrators keep asking you things that are theirs to decide

**Date:** 2026-10-14 · **Lane:** finding (round 1) · **Dispatch:** `phase=finding round=1 class=plan+review`
**Question owned (user):** *"my goal is to ask feature and simply wait until it is done, unless a
breaking change gets encountered or something is blocking if LLM can not decide what would be best
in situation … what to change about this, instructions or some architecture in orchard?"*

**Tickets:** BUG-256 (turn-end check), BUG-257 (answered-card briefing), FEAT-183 (Working
Agreement), FEAT-184 (adopt under delegation, filed with plan), FEAT-185 (self-restart, filed with plan).

---

## 0. Method and N

- **Source:** every top-level orchestrator transcript of this project in the Claude Code store
  (`~/.claude/projects/<this checkout>/*.jsonl`, the account overlays symlink into it): **371
  sessions, 2026-08-03 → 2026-10-13**. Sub-agent transcripts are excluded.
- **What counts as an ask:** a turn whose FINAL text (after any Stop-hook re-send) carries an
  `orchard-ask` block, a turn that called `AskUserQuestion`, or a turn whose last lines put a
  question to the user in prose ("want me to…", "shall I…", "say the word"). One turn = one ask,
  even if it bundles several questions.
- **N = 282 asks in 71 sessions** (286 extracted, 4 extraction false positives dropped):
  232 `orchard-ask`, 10 `AskUserQuestion`, 40 prose.
- **Classification:** every ask was read and labelled by hand against a fixed rubric (below), with
  the user's preceding request and next reply in view. `node scripts/ask-audit.mjs` (new) re-runs
  the extraction and the decider/reply counts; the labels themselves are judgement.
- **Board decisions:** 99 decision records on the board (current + history) were read for the
  adopt/delegation question.
- **Independent check:** OpenAI run `01a13949-5094-7161-bdee-4954fda87510` was given the data and the
  proposals, not the conclusions. It blind-classified a fixed random 40 before seeing the aggregate,
  then attacked each proposal (§4).

### Rubric

| Legit (the user's) | Not the user's |
|---|---|
| **live**: restart, deploy, or interrupt running sessions | **filefix**: "should I file/fix/build this in-scope problem?" |
| **git**: a git hand-off under the user's standing rule | **cont**: continue, one more round, or another verification of authorised work |
| **host**: sudo, global config, the user's other repos, deleting user data, real money, publishing | **impl**: implementation, sequencing, or which option when a clear recommendation exists |
| **fork**: a genuine taste, product-direction or methodology fork | **answered**: the user had already delegated or answered |
| **info**: a fact only the user has | **offer**: an optional "want me to?" |
| **blocked**: a permission or credential | **adopt**: an already-delegated decision that only needs a click |

---

## 1. Result

| Class | n | share of all asks |
|---|---:|---:|
| Legit | 135 | 47.9% |
| ↳ git hand-off | 45 | 16.0% |
| ↳ restart / live | 31 | 11.0% |
| ↳ host / outward / destructive | 30 | 10.6% |
| ↳ genuine fork | 20 | 7.1% |
| ↳ info + blocked | 9 | 3.2% |
| Gray | 21 | 7.4% |
| **Not the user's** | **126** | **44.7%** |

**Unnecessary asks by kind** (share of the 126):

| Kind | n | share | Example (paraphrased) |
|---|---:|---:|---|
| impl: implementation or sequencing | 40 | 31.7% | "Build 1 only, or 1 and 2?" (reply: "do whatever u recommend") |
| filefix: should I file or fix this? | 36 | 28.6% | "Should I file this and have it fixed now? decider: priority" (reply: "ye pls file and fix") |
| cont: continue or one more round | 29 | 23.0% | "I recommend one more round … decider: spend", asked after "fix effective immediately" |
| answered: already delegated | 14 | 11.1% | "Should I build it?", asked right after "do what u recommend" |
| offer: optional | 6 | 4.8% | "Want me to write a STATE.md handoff?" |
| adopt: delegated, needs a click | 1 | 0.8% | "FEAT-170: pick A. It's already built, only an answer clears the card" |

**Reply proxy.** For readable next replies, the user answered with a plain go or a delegation
("yes", "do it", "whatever you recommend", "autonomously"): **44 of 76 (58%) after unnecessary
asks**, against 23 of 61 (38%) after legitimate ones. Once, the user wrote *"my message applies and
will continue to apply: do what u recommend, pls stop asking unless its something breaking"*. The
asks continued in later sessions.

**Trend.** Unnecessary asks by month: Aug 35, Sep 61, Oct 30 (of 79 / 122 / 81). The `orchard-ask`
discipline (FEAT-137) did not reduce the share.

---

## 2. What produced them

| Cause | Evidence | Unnecessary asks it let through |
|---|---|---|
| **Turn-end check accepts any decider text** (`DECIDER_RE`, `\S.*`) | 71 of 126 unnecessary asks named a decider. Asks naming one were unnecessary at the same rate as asks that did not (71/160 = 44% vs 55/122 = 45%). `decider: none` passed. | 56% of the 126 passed the check *because* they named a decider |
| **Open decider vocabulary** in WA §A and RESPONSE_FORMAT ("taste, priority, spend, risk, direction") | Decider word on unnecessary asks: priority 25, risk 21, spend 10, direction 9, taste 6. On legit asks, `risk` (48) was mostly a restart or git hand-off, and `priority` was used 6 times. "priority (whether to spend on it now)" turned "should I fix the bug I found?" into a valid ask. | filefix + cont: 65 (52%) |
| **Interactive default** (WA §M) plus "Don't auto-chain — finish, then stop and report" (Scope) | Found defects and verification rounds were treated as new tasks needing a go. "One more round?" asks went out even inside an authorised fix. | cont 29 (23%), filefix 36 (29%) |
| **Standing delegation not carried** | 24 of 126 unnecessary asks came within 6 user messages after an explicit delegation. Delegation is chat-only: no request-level mode, nothing durable, nothing the hook reads. | answered 14 (11%) plus most of the 24 |
| **A self-written rule treated as a decider** | In the current session, an earlier adjudication said "a further break goes to the user", and that was applied mechanically against "fix effective immediately". | N = 1 visible (cannot be separated in the corpus) |
| **Injected "ask before you begin"** after the user answers a card (`board.ts`) | 35 such briefings in transcripts. FEAT-090's own question, start or wait, was never answered. Usually the next reply carried the go anyway, so the measured direct cost is small. | under 5 (not separable) |
| **No agent path to adopt a delegated decision** | 1 ask. FEAT-164's and FEAT-170's answers were written by an orchestrator through the API and recorded as `by: user`. | 1 (0.8%) plus 2 impersonated answers |

Legitimate, but structural: **git hand-offs (45) and restart hand-offs (31) are 27% of all asks**.
They are the user's under current policy. They stop work because an agent cannot commit, and a
restart kills its own turn.

---

## 3. Recommendations (as proposed to the refuter)

| # | Layer | Change |
|---|---|---|
| P1 | architecture (hook) | Closed hard-stop decider list instead of any text |
| P2 | instructions (WA) | Run-to-done default for a work request; in-request fixes and verification are the task; a self-written rule is not a decider; batch hand-offs |
| P3 | injected template | The answered-card briefing: the answer is the go |
| P4 | architecture (board) | `adopt` verb under a recorded delegation |
| P5 | architecture (mode) | Per-request "run until done" mode that defers even taste/direction asks |
| P6 | architecture (service) | Self-restart that drains and resumes the requester |

---

## 4. Refutation (OpenAI run 01a13949)

**Blind classification agreement.** On the 40-ask sample, the reviewer agreed with these labels on
29 of 40 at the coarse level (legit / not / gray; κ = 0.47). On the 33 that neither rater called
gray, it agreed on 29 (88%). It found 11 unnecessary against 12 here. The disagreements were mostly
gray-versus-decided (fragmentary prose extracts) and two scope calls: whether a research request
licenses a new UI surface, and whether "fix it if it's a bug" covers a found defect. **The
population estimate stands at ~45%. The honest band is roughly 40–52%, depending on how the gray
asks fall.**

**The reviewer's criticisms that stand:**
- *The unit is coarse.* One ask can bundle a legit hand-off with an unnecessary re-authorisation.
  Counting individual decisions would separate them.
- *Prose extraction is noisy.* Some prose "asks" are fragments.
- *"Yes" can be necessary consent.* The reply proxy is suggestive, not proof.
- *Git-only verification manufactures git hand-offs.* Removing that dependency is different from
  granting git authority.

**Verdicts on the proposals:**

| Proposal | Reviewer's removal estimate (of 126) | Verdict | What survived |
|---|---:|---|---|
| P3 answered-card briefing | 5–15 | **MODIFY → built** | A picked option authorises its scoped work. A question, a rejection or an explicit wait is not a go. |
| P2 WA wording | 35–65 | **MODIFY → built** | Bounded by acceptance criteria and budgets. Discovered constraints are kept apart from invented authority. Only non-blocking hand-offs are batched. |
| P4 adopt verb | 1–5 | **KEEP → filed with plan** | Source-linked, scoped, revocable delegation and a distinct actor. API writes may not impersonate the user. |
| P1 closed decider list | 10–30 | **MODIFY → built** | Require the concrete consequence. Keep `info` and `blocked` paths. Metadata alone cannot prove legitimacy. |
| P5 run-until-done mode | 40–75 (overlaps P2) | **REJECT as written** | Deferring real product forks yields unwanted features, and "override?" is not consent. Replaced by P2's reversible-defaults-in-scope. |
| P6 self-restart | 0 of 126 (15–25 of 31 restart asks) | **MODIFY → filed with plan** | Drain, durable checkpoint, idempotent resume, recovery tests. Ranked separately. |

The reviewer ranked by asks removed per unit of risk: **P3 → P2 → P4 → P1**. It also named gaps:
durable scoped authorisation across sessions (folded into FEAT-184), and a held-out evaluation that
counts unauthorised actions too (the §6 metric).

---

## 5. What was built

- **BUG-256 (P1, modified).** `scripts/lib/format-metrics.mjs` gains `HARD_STOPS` and `deciderOf()`.
  An ask whose decider is not on the list (`decider-not-hard-stop`), or that names no consequence of
  at least three words (`decider-no-consequence`), is blocked once by
  `scripts/hooks/response-format-gate.mjs`. The block message tells the agent to decide and
  continue. Telemetry records `deciderTokens`, `asksNotHardStop` and `asksNoConsequence`. The spec
  is updated in `docs/prompts/RESPONSE_FORMAT.md`, and the core stays under its 6200-byte budget
  (6185). New suite: `scripts/verify-bug-256-hard-stop-decider.mjs`, built from verbatim corpus asks:
  13 of 26 FAIL before the change, 26 of 26 PASS after. The FEAT-137 fixture that used a generic
  `risk` decider now names `outward`.
- **BUG-257 (P3, modified).** `src/server/board.ts`, in both the launch snapshot and the live
  `[station]` briefing: a picked option is the go; a question, rejection or wait is not. Nothing
  starts a turn. The FEAT-090 suites' wording assertions failed before the change and pass after.
- **FEAT-183 (P2, modified).** The canonical `~/projects/methodology/WORKING_AGREEMENT.v4.md` (§A
  closed hard-stop list, §M run-to-done default, a §N sentence, Scope) is reconciled in place with a
  CHANGELOG entry and mirrored by `npm run sync:methodology`.
- **`scripts/ask-audit.mjs`.** A read-only re-measurement tool for the share, decider tokens and
  reply delegations, with `--sample N` for blind relabelling.

**Replay of the corpus through the new check** (`orchard-ask` asks only). It now blocks 46 of the
126 unnecessary asks that the old check passed (37%). It also blocks 55 legit asks once, mostly
restarts labelled `risk`, which must re-send as `live — …`. That re-send is a transitional cost.
Sessions launched after the spec change are told the list up front, so the steady state should
re-send far less. This is not measured yet.

---

## 6. How we will know it failed

Re-run `node scripts/ask-audit.mjs --since 2026-10-15` once at least 10 new orchestrator sessions
exist, then relabel a blind `--sample 40` with an independent reviewer.

**It has failed if any of these holds:**
- the unnecessary share stays above ~30%;
- the `decider-not-hard-stop` blocks are simply relabelled, for example a "one more round?" ask
  under `taste` or `direction`;
- the user reports an action they did not authorise.

**Known residuals:**
- A model can ask in prose outside an `orchard-ask` block. The check does not see that.
- A model can relabel under a true-sounding hard stop. The consequence line makes this auditable but
  cannot prevent it.
- Sessions launched before the spec change get one block per old-style ask until they relaunch.

Independent verification is owed for BUG-256 and BUG-257. Both touch the Stop hook and the session
briefing, which have a regression history (BUG-192, FEAT-090).

---

## Appendix A — Needs-You card triage (BUG-259, 2026-10-14)

The chat-ask study above does not count decision CARDS filed with `board-tool decide`. This appendix triages the cards on the rail on 2026-10-14. The gate and the `own` verb planned in BUG-259 come from it.

Triage of the 24 cards on the Needs-You rail, 2026-10-14, read from `readBoard()` (the rail's own reader; `board:status` counts 28 owner cells, and 4 of those are answered and off the rail: BUG-240, FEAT-164, FEAT-170, FEAT-023). Labels are judgement against the BUG-256 closed list (`HARD_STOPS` in scripts/lib/format-metrics.mjs). A card is the user's only if the decision itself needs one of those stops. A clear recommendation, a reversible choice, or the ticket's own success criteria make it the agent's.

| Card | Owner | Kind | Why | Decision the agent should take |
|---|---|---|---|---|
| FEAT-178 distribution shape | user | direction | npm, binary or desktop app decides who can install Orchard and on which OS: product direction | stays with you |
| FEAT-182 risk-routed verification | user | direction | changes the methodology rule every project follows; FEAT-184's delegation path, not this ticket | stays with you (FEAT-184) |
| BUG-116 lazy container browser | user | access | the recommended option edits your other repo (~/random_projects/stealth-browser-mcp) | stays with you; B or C would need no ask |
| BUG-108 browser in container image | user (borderline) | taste | which cost lands on your machine: a much larger image, or a setup step before every container session can browse | stays with you |
| ARCH-013 adversarial rounds outside orchard | agent | impl | engineering options with a recommendation; C is local to dispatch.mjs and reversible | C |
| ARCH-019 auto-background env knob | agent | impl | engineering; recommendation is no change | A, no change |
| ARCH-021 git-write enforcement layer | agent | impl | your BUG-240 answer already set the threat model (accidental, not malicious; the shim covers it) | A, price the residual; hooks in other repos would come back to you |
| ARCH-023 push-gate scan scope | agent | impl | makes the gate stricter, not looser; recommendation A is destination-independent | A, with the allowlist in the same change |
| BUG-048 held-message status | agent | impl | reversible UI honesty fix with a recommendation | A |
| BUG-104 verifier methodology leak | agent | impl | four engineering approaches, no user value at stake | 4 as the standing check, fix what it flags with 1 and 2 |
| BUG-115 suspend-window inconclusive | agent | impl | engineering with a recommendation; touches no product path | A |
| BUG-121 record block out of position | agent | impl | parser strictness; B is the safe default | B |
| BUG-140 waits that outlive their work | agent | impl | four engineering options, no recommendation; nothing user-held | C, bound every wait |
| BUG-236 leak-gate code expressions | agent | impl | raises recall; the cost is a measured one-time allowlist | B, allowlist staged in the same change so the gate never goes red |
| FEAT-082 proof-card evidence source | agent | impl | recommendation C; visual review still applies before done | C |
| FEAT-088 where structure review runs | agent | impl | C is advisory, reversible and gathers the data to choose later | C |
| FEAT-086 cost view: rendered or CLI | agent | answered | its success criteria already require a rendered view | build the view |
| FEAT-087 rename ticket headings | agent | answered | its success criteria already assume the rename ("parse every ticket after the rename") | A |
| FEAT-092 per-turn amendment channel | agent | answered | its success criteria describe the channel (B) | B |
| FEAT-030 cross-project handoff | agent | sequencing | parking adds no new direction; only starting it would | A, keep parked |
| FEAT-033 close the tool-adoption ticket | agent | bookkeeping | open-or-closed is board housekeeping | A, close |
| FEAT-049 publish ticket open or closed | agent | bookkeeping | the question is bookkeeping; the publish itself stays an outward step for you, as a hand-off and not a decision | A, hold open with the publish as your hand-off |
| FEAT-124 Fable gate | agent | cont | the decision is resolved (A built, B shipped); what remains is an independent verify, then a git hand-off | dispatch the verify; batch the git hand-off |
| FEAT-135 git shim in subprocesses | agent | cont | the status says the only remaining gate is an independent verify; the decision is already resolved | dispatch the verify |

**Counts.** User-owned 4 of 24 (17%): direction 2, access 1, taste 1 (borderline). Agent-owned 20 of 24 (83%): impl 12, answered by the ticket's own criteria 3, sequencing or bookkeeping 3, cont (verify owed, card stale) 2. This is a stock count, not a rate. Cards the user answers leave the rail, so cards nobody answers pile up there. That biases the stock toward agent-owned cards, so 83% does not contradict the 45% flow rate in §1.

**Off the rail but still 👤 in INDEX (drift):** BUG-240, FEAT-164 and FEAT-170 are answered and followed, but their Owner cell was never flipped. FEAT-164 and FEAT-170 carry the two `by: user` answers that an orchestrator wrote (FEAT-184).

**Independent check.** OpenAI run `01a13969-1219-7580-bc71-3db571a52dd4` triaged the same 24 cards blind and gave 22 to the agent and 2 to the user. Agreement on owner: 22 of 24. Both disagreements are BUG-108 and FEAT-182, which this triage left with the user. So the honest range is **20 to 22 of 24 agent-owned**. Its plan verdict is MODIFY; the revised plan is in the BUG-259 Activity log.
