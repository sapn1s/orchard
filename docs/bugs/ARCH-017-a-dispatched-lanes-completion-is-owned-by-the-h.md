# ARCH-017 — A dispatched lane's completion is owned by the harness, not by Orchard

- **Status:** IN PROGRESS — round 11 (2026-09-22) closed all four failures from the SEVENTH cross-provider review (DO NOT LAND). **#1 (the core property, forged in every round): acknowledgement was still provable by ECHO** — `drainLanes.process()` returned `receipt.digest`, the exact value `acknowledge()` compares against, so a consumer could hand it straight back and mark a result collected without ever displaying or emitting the bundle (`CASE=ack`). The response now carries only the CHALLENGE (`nonce`, `channel`, `bytes`); the expected digest lives only on the record (`handoffEvidence`) and is never transmitted, and the refusal message no longer prints even a prefix of it — a consumer must COMPUTE the digest over the bytes it received (the real client already did). New check W33 + mutant W36 ("the test must fail if the echo defence is removed"). **#2 the session guard still accepted an ABSENT id and a changed `encodedDir`, and could not tell a recreated same-id context apart** — it now refuses unless there IS a session (`sessionId` non-null), `sessionId`+`projectId`+`encodedDir` all still equal the origin, AND `state.current` is the same object reference captured at the start (only navigation reassigns it, so a replaced reference is a re-open). New rail checks C11/absent·directory·recreated + mutant W39. **#3 seal ENTRIES were unvalidated** — `{"g":false}` bypassed sealing via truthiness; a groupId present but not a well-formed `{at,kind,why}` now FAILS CLOSED (`isDurableSeal`), W34 + W37. The invalid-JSON fail-closed recovery is human-only (repair/remove the file) and that is a DELIBERATE decision: the alternative (treat corruption as unsealed) reintroduces double-delivery. **#4 retention could evict the seal the instant it was written** (clock rollback made the fresh seal the "oldest"); the just-written groupId is now excluded from eviction, W35 + W38. And the retention "unguessability" argument rested on ~31 bits of `Math.random`; `newLaneId` now uses a CSPRNG (72-bit hex suffix) and the seal bound is re-documented as an HONEST recency limit, NOT defended by unguessability — caller-chosen ids stay the caller's responsibility (W35 entropy leg + W40). The two reviewer HOLDS (retry-after-sealed-EPIPE, legacy-upgrade-under-ENOSPC) reproduced green and are unbroken. Probe adopted verbatim at `scripts/reviewers/arch017-r10.cjs`. Mutation **59 killed / 0 survived / 3 unreachable (W1/W11/W4), twice** across 62 mutants (RAIL 20/0); suites drain 41/0 + 7/7, rail 32/0 + 18/18 (incl. C11), ledger 63/0 + must-fail, vacuity 24/0; `gate` PASS (exit 0, unpiped); `board:check` 5 pre-existing (BUG-169, FEAT-129/131/132, ARCH-007). **Independent clean-room verify still warranted** (the echo defence and the session guard are the load-bearing security properties; W33-W40/C11 written by the same lane). Prior-round context follows. — round 10 (2026-09-22) closed all five failures from the SIXTH cross-provider review (DO NOT LAND), and **corrected the record: the round-9 session-binding fix (#5/finding 1) was reported DONE with a happy-path screenshot and WAS NOT — it read `state.current.id`, a field session selection never stores (it stores `sessionId`), so the guard compared `undefined` to `undefined` and passed for EVERY destination (same/other/none). Now compares `sessionId`+`projectId`; the guard-delete mutant W26 is killed by the NEW negative-case check `C10` (a different session, and no session at all) and NOT by the old positive-case `C9` — the exact distinction that would have caught the false "fixed" a round earlier.** #2 the durable seal FAILED OPEN (every read error → `{}` → re-delivery); now ABSENT (`ENOENT`) is a fresh system, but unreadable/invalid/array/directory THROWS and `durableGroupSeal` FAILS CLOSED (W27→W30). #3 the broker sealed AFTER emitting and swallowed the failure; `terminal()` now runs `sealFirst` BEFORE `socket.end`, so a seal-write failure emits nothing (the rail path already sealed-then-stamped). #4 legacy generations derived from the reusable id (`legacy-${id}`) collided on reuse; `readAll` now assigns a unique RANDOM generation and PERSISTS it on the writer (W28→W31). #5 readiness was `stamp || waited>=thr`, so a failed stamp still exposed readiness and a restart reversed it; readiness is now the PERSISTED STAMP ALONE (W32). The `group-seals.json` growth flagged in round 9 is now bounded at `MAX_DURABLE_SEALS=50_000`, dropping the OLDEST first — a SILENT-DROP bound, not a refuse: a dropped seal DOES permit reuse of that (random, one-shot) groupId, accepted deliberately as far past any live group (stated in-code). Mutation **54 killed / 0 survived / 3 unreachable (W1/W11/W4), twice** (RAIL 19/0); suites drain 38/0 + 5/5, rail 29/0 + 15/15 (incl. C10 gone/other), ledger 63/0 + must-fail, vacuity 24/0; `gate` PASS (exit 0, unpiped); `board:check` 5 pre-existing (BUG-169, FEAT-129/131/132, ARCH-007). **Independent clean-room verify still warranted** (session-lifecycle + data-leak fix, and W26-W32/C10 written by the same lane). Prior-round context follows. — round 9 (2026-09-22) closed all five failures from the FIFTH cross-provider review (DO NOT LAND), all new angles. **#1 (5th round on reopen-after-drain), now with a DURABLE seal** — the seal lived in prunable rows, so pruning the delivered row let the group accept members and reusing the groupId drained again; it now lives in `group-seals.json` (written at handoff, consulted first by `groupSealFor`, untouched by pruning), verified to survive pruning + refuse reuse (W19). **Invariant:** *a group that has ever begun delivery is sealed against admission and re-open forever, stored durably enough to survive deletion of every row it was derived from.* **#3** the ledger could be swapped underneath a running drain (an old bundle acknowledged a replacement lane's unseen result); the drain now binds to an immutable per-record `generation` and `restampHandoff` refuses a swapped row (W20). **#4** `now+ttlMs` overflowed to `Infinity`→JSON `null`→open-forever (now `safeDeadline` clamps finite), and readiness regressed on a clock rollback (now monotonic via a persisted `starvationReleasedAt`) — W18. **#2** the sustained-readiness property moved into `releaseStarved`+stamp; the round-8 starvation mutant is now killable (W24). **#5 (most serious) cross-project leak** — a mid-drain session switch wrote A's result into B's composer and acknowledged it; delivery is now bound to the initiating session (refused on mismatch), CSS-computed visibility is checked (not just `hidden`), and a digest failure refuses instead of escaping — real-browser proof C9 + screenshot `.playwright-mcp/arch-017-r9-xproject.png` (W25). Probes adopted at `scripts/reviewers/arch017-r8*.cjs` and as mutants W21-W25 (W1/W11 now UNREACHABLE — the durable seal dominates their row-based clause). Mutation **51 killed / 0 survived / 3 unreachable** (non-browser 33/0 twice, RAIL 18/0); suites drain 35/0 + 5/5, rail 27/0 + 13/13, ledger 63/0 + must-fail, vacuity 23/0; `gate` PASS; `board:check` 5 pre-existing. **Independent clean-room verify still warranted.** Prior-round context follows. — round 8 (2026-09-22) closed all four failures + the two #5 assertions from the FOURTH cross-provider review (DO NOT LAND). #1 (fourth round for reopen-after-drain): `groupSeal` now makes the delivered state ABSORBING so closing cannot mask it, and `pending()` reads `groupState` so every readiness caller uses the one predicate — new drain leg W9 covers both, and a delivered+closed group now refuses re-open. #2: the socket client hashed a `'host broker failed'` substitute for an empty failure text while the broker hashes empty — fixed to `?? ''` (the broker path was already correct), client↔broker now agree 8/8 (leg W10). #3: `composerProblem` now walks ancestors (a hidden PARENT was unchecked) and the pre-ack re-check is wrapped so a throw is a refusal, not an escape — real-browser legs C7/C8. #4: **concluded the mechanism is wrong** — a static idiom-scanner cannot win the enumeration race (three rounds of new evasions), so it is now a conservative LINT (own-name, word-bounded, false-on-empty, outside any loop; assert-emptiness idioms dropped) and the MUTATION HARNESS is named as the authoritative anti-vacuity mechanism; all five scan-probe evasions now caught. #5: drain `afterBad`/ledger W4 `reports` each pin their own cardinality. Probes adopted at `scripts/reviewers/arch017-r7*.cjs` and as mutants W11-W17 (+W1/W5 re-pointed). Mutation **48 killed / 0 survived / 1 unreachable (W4), twice**; suites drain 32/0 + 5/5, rail 26/0 + 12/12, ledger 63/0 + must-fail, vacuity 23/0; `gate` PASS; `board:check` at the 5 pre-existing drifts. **Independent clean-room verify still warranted.** Prior-round context follows. — round 7 (2026-09-22) picked up an interrupted round whose fixes were left UNSTAGED and unverified, verified them, and **closed all five defects from the third cross-provider review — two of which the prior lane had NOT touched.** #1 groupSeal is now one predicate with a KIND, consulted by admission/readiness/reopening (proven: `openGroup` into a drained group throws). #2 receipt evidence is length-prefixed JSON (empty channel + `}` safe) — and checking the BROKER path as the reviewer asked found a **round-7-introduced regression**: the `receiptDigest` length-delimiter change was not applied to the real socket peer `dispatch-client.mjs`, so the broker would refuse every genuine live receipt (ledger C1/C4 via the real client + D15-D17 failed); fixed. #3 the composer is re-checked at the ACK instant (new real-browser leg C6 drives a composer torn during the async gap). #4 the vacuity scanner's three blind spots (zero-length guards, unreached assertion loops, unrelated-collection guards) are closed and it now flags them; closing them exposed **#5** — drain:867 looped over an asserted-empty set (zero assertions) and ledger D17 passed with the fd:99 case unreached (`>= 4` over 5 cases) — both fixed, and five further real blocks the strengthened scanner correctly flagged were given genuine same-collection guards. Mutation **41 killed / 0 survived / 1 unreachable (W4), twice** (M1/Y8/W5/W8 re-pointed after the round-7 edits moved their anchors); suites drain 30/0 + 5/5 must-FAIL, rail 24/0 + 10/10 must-FAIL, ledger 63/0 + must-FAIL exit 0, vacuity 27 guarded / 0 unguarded; `gate` PASS; `board:check` at the 5 pre-existing drifts. **Independent clean-room verify still warranted** (session-lifecycle + delivery + a regression fix). Prior-round context follows. — round 6 (2026-09-21) finished an interrupted round and **refuted a claim in the round-5 entry below.** Round 5 recorded "34 killed / 0 survived, twice"; it then edited source and landed without re-running the harness. Measured at the start of round 6, the mutation score was **27 killed / 7 SURVIVED** — all seven were `ANCHOR MISSING` errors where the round-5.5 edits had moved the code, so seven mutants had stopped asking their question and the harness scored the un-asked question as a survivor. Re-pointed, all seven kill again. Round 6 then did the part round 5 did not: **encoded the cross-provider reviewer's probes as mutants W1-W8 and measured them — ALL SEVEN ORIGINAL PROBES SURVIVED (34 killed / 7 survived).** Every round-5 fix was genuinely in the code and **not one of them was asserted by anything.** Closing that gap found a **live product defect**: `showPendingBundle` tested `node.prompt`, a reference cached once at boot, so with the composer removed from the DOM the client wrote into a detached node, read its own write back, and **sent the acknowledgement anyway** — "collected" for bytes no user can see, which is the exact failure the round-5 delivery-verdict change was written to prevent. Fixed with `isConnected`. Three further defects were found in round 5's own vacuity scanner, which had been reporting a clean sweep it never performed (see checkpoint 3). After: **41 killed / 0 survived, twice**, plus one mutant declared UNREACHABLE-by-construction with the argument written out. Suites: drain 30/0 + 5/5 must-FAIL; ledger 63/0 + 8/8 must-FAIL; rail 23/0 + 9/9 must-FAIL; vacuity 25 guarded / 0 unguarded; `gate` PASS. Earlier context: **the FIRST CROSS-PROVIDER review of step 2 (round 5) returned DO NOT LAND with five defects that three same-family verification rounds had all passed** (2026-09-19). That is the pattern this ticket demanded cross-provider review for seven times, and it recurred: same-family rounds 1-3 found real defects but never these. The five — a group that could deliver twice (late joiner into a closed group, duplicate id, and a dismissed running member hanging the group FOREVER), a decorative nonce with no replay or destination binding on the drain path, a skipped lane's result still shipped inside the bundle, a missing result file silently replaced by its truncated excerpt and then acknowledged as complete, and an acknowledgement sent BEFORE the composer received the bytes — are all reproduced and fixed. Fix 2 REUSES the ledger's own `receiptDigest(nonce, channel, bytes)` rather than adding a second implementation. Fix 3 was decided deliberately: REFUSE to ship an excerpt in place of a missing authoritative file. Its probes are adopted as X1-X7/X5b/C5 and as mutants Y1-Y8; **against the reviewer's own probes the score went 0 of 8 covered → 8 killed / 0 survived**, and two of them survived even after the fixes and exposed further coverage gaps I then closed. Standing mutation check: **34 killed / 0 survived, twice**. Suites: drain 27/0 + 5/5 must-FAIL; ledger 63/0 + must-FAIL exit 0; rail 22/0 + 8/8 must-FAIL; `gate` PASS. **Prior rounds' claims stand but were incomplete** — see the round-5 entry, and the residual untested list, which still includes automatic wakeup/starvation scheduling and any real provider turn.
- **Severity:** high (cost of leaving as-is: the per-completion wake is the dominant avoidable turn cost of every fan-out, and the escape hatch the user asked for is unbuildable on today's shape)
- **Area:** dispatch primitive / session lifecycle / rail surfaces — spans `agent-bridge`, `dispatch-broker`, the rail, and the dispatch contract in the Working Agreement
- **Reported:** 2026-09-08 by a dispatched plan+review lane (finding round 1), from two read-only scoping lanes (server + client) and the user's own report of N wakeups per fan-out
- **Recurrence evidence:** BUG-159 (§3: lane-completion turns are CLI-native self-woken turns, no Orchard re-send is involved), FEAT-057 (deaths had to be recorded server-side precisely because a notification needs a model turn to be read), ARCH-016 (lane result prose replayed as parent context — the same fan-out, priced), FEAT-064/FEAT-065 (both had to invent their own delivery-into-parent path because no completion record exists), ARCH-001 / ARCH-010 (a fact no owner writes down is re-derived by every reader)
- **Verification-class:** arch  ⟶ independent verification REQUIRED before VERIFIED. This ticket itself is design only; no code changed. Every file:line below was read in this round, not inherited.

## Violated invariant

**A dispatched lane's completion is a fact that Orchard owns, records once, and every surface reads; and no lane's result text enters the orchestrator's context except through the one function that stamps the record as delivered.**

*(**Round-5 correction — the claim is now named after what is proven.** On the step-1 blocking
transport, nothing in the Orchard process can observe whether a consumer emitted the bytes anywhere:
no process can inspect another's file descriptors, and a peer that holds the bytes and writes them
nowhere returns a valid receipt (measured). So the ledger's field is **`acknowledgedAt`**, stamped by
**`markAcknowledged()`**, and it means: Orchard's own write completed AND the consumer proved
possession of exactly those bytes and named the channel it says it wrote them to (the qualifier is
`deliveryProof: possession-digest-fd1|fd2`). **DELIVERY — the result text actually entering the
parent's context — is a fact only step 2's `drainLanes()` can stamp, because only it does the
injecting.** The invariant's second clause is therefore about acknowledgement on this transport and
about delivery on that one; `acknowledgedBy` is what tells the two apart. The old name `deliveredAt`
asserted the stronger fact and the evidence never supported it — which is the exact false-proof class
this ticket has failed on in every round, so the name was changed rather than annotated.)*

*(Round-2 correction. The first clause of round 1 said "and no surface learns of it by any other route", which is not enforceable and would be false on day one: the orchestrator can legitimately learn a lane finished by reading a file the lane wrote, curling the rail, or running `harvest-agent`. Knowing THAT a lane finished is not the fact being owned. The owned fact is **delivery** — whether this result has entered the parent's context — and the enforceable form is a single writer plus a join key: `drainLanes()` is the only writer, and it stamps the lane id as a literal token in the message it composes, so "did this lane's result reach the parent, and when" is greppable rather than judged.)*

Today the negation is true and provable in one line: for a background Task-tool lane, Orchard has no record of the completion at all. It observes the *consequence* — the CLI self-wakes a new turn and emits an `init` frame, which `#markForegroundTurnLive()` (`src/server/agent-bridge.ts:2883`) reads as "a turn opened". The completion itself is generated by the SDK's background-task manager inside the orchestrator's own CLI process. Orchard's only injection seams are stdin writes (`send()` → runtime InputQueue, `agent-bridge.ts:1571`; `survivor-delivery.ts`; the autonomous nudge at `agent-bridge.ts:498`), and none of them is on the completion→wake path. Subagents reach the dashboard as read-only reconstructions from the parent's transcript after the fact (`GET /api/sessions/:id/subagents` → `index.ts:2512`, backed by `subagents.ts`).

So the fact exists in exactly one place — inside a process Orchard does not control — and is delivered to exactly one reader, immediately, unconditionally.

## The design that produces this class

The dispatch primitive is the harness's, so the lifecycle is the harness's. Everything downstream follows:

- **No hold is possible.** There is no code path that decides "inject this completion now", so there is nothing to gate. This is not a missing policy flag; it is a missing owner.
- **No queue is possible.** FEAT-064's "drain" is the session-host *shutdown* drain (`commitDrain` in the broker), and FEAT-065 delivers a *user's typed message* into a survivor's held-open stdin. Both are delivery-INTO-parent plumbing. Neither is a completion queue, and the scoping lane confirmed no completion queue exists anywhere.
- **No standing item is possible.** Client-side, `state.agents` (`public/app.js:113`) is purely event-derived; `agent-completed` (`app.js:8947`) sets `settled=true` and *retires* the strip row — `scripts/verify-stale-agent-cards.mjs` (BUG-030) enforces that retirement as design intent. A completed lane's result is folded into the transcript and nothing durable survives a reload to hang a "process" button on.
- **Therefore N lanes = N wakes.** Each completion opens a full-context turn; ARCH-016 already priced what each of those turns carries.

The ownership boundary that is missing: **who owns the sentence "lane L finished, here is its result"**. Nobody does. The user's ask — one wake for a batch, plus "give me this one lane's result now" — is a question addressed to that owner, and there is no one to ask.

## Why local patches did not hold

- **Prompt-layer batching** (tell the orchestrator to acknowledge briefly on a woken turn and defer the summary) does not remove the turn. N turns, N context loads, N token bills — it only shortens the visible reply. It also cannot produce the escape hatch, since there is nothing to pull from.
- **UI-layer suppression** (hide the partial replies) treats the symptom the user did not complain about and leaves the one they did.
- **BUG-159** deliberately declined to touch this: its non-goal is "do NOT bound the notification chain". It fixed the user-send path (hold+push at send time) and the phantom liveness read. Its thrust is anti-starvation, which is the constraint any hold must respect, not a patch of this class.
- **FEAT-057** is the shape of the answer applied to a different fact: it records deaths server-side because a harness notification needs a model turn to be read, and it proves the property this design needs — *the server can hold a lane-lifecycle fact and the client can render it with no model in the loop* (`refreshOutcomes()` `app.js:5404` → `GET /api/agent-outcomes`, polled by `pollRail()` `app.js:6355`). It stops at deaths by explicit policy ("only DEATHS are stored", `outcomes.ts` header), so completions were left to the harness.

## Verified answer to the hypothesis this round was sent to test

The charter's hypothesis — *Orchard-owned child sessions cost nothing dispatched lanes actually depend on* — **survives, with four priced exceptions and one that changes the migration order.** It is not free, and one item is load-bearing rather than incidental.

Grounding facts checked this round:
- Orchard sessions are already full `claude` CLI processes: the Agent SDK spawns the CLI and talks stream-json over its stdio, and Orchard supplies its own `spawnProcess` (`agent-bridge.ts:1226-1311`), model / effort / permissionMode / allowedTools / disallowedTools (`agent-bridge.ts:1060`, `:1478-1482`). A child session is therefore a *top-level* CLI session with the full tool surface, not a reduced one.
- An out-of-harness child can be given an agent definition: `claude --agents <json>`, `--append-system-prompt`, `--model`, `--allowedTools/--disallowedTools`, `--permission-mode`, `--permission-prompts`, `--resume`, `--fork-session` all exist on the installed CLI (checked via `claude --help` this round).
- An Orchard-owned dispatch socket exists and is advertised to every session: `src/server/dispatch-broker.ts` (unix socket per project, `PROJECT_CAP=2` / `GLOBAL_CAP=6`, `MAX_TIMEOUT_MIN=60`, spawns `scripts/dispatch.mjs`), note appended at `agent-bridge.ts:1007`. `scripts/dispatch.mjs` already supports `--provider anthropic`, `--resume`, `--meta-out`, `--prompt-stdin`, timeout enforcement and the BUG-031 failure taxonomy.
  **CORRECTION (round 2, from the adversarial review — round 1 got this wrong and the wrong version reached the migration plan).** That socket is **provider-locked to OpenAI by design and by security review**, and it is NOT the seam this feature extends: `validate()` refuses anything but `provider === 'openai'`; `runDispatch()` hardcodes `'--provider','openai'`; `op:'capabilities'` advertises `providers:['openai']`; the file header states the purpose ("Host-side OpenAI dispatch broker. Credentials and Codex never cross into a project"); it is gated off by `toolSettingsOf(project).openaiDispatch` (`agent-bridge.ts:1005`); and `runDispatch()` spawns **on the host at `project.hostPath`**, which for a container-isolated project means a session inside the container causes host-side execution. That is deliberate and reviewed for a read-only Codex run. Routing the project's own **agentic Claude lanes** through it — at `workspace-write` if asked — would turn it into a general-purpose "run agentic work outside my container" primitive. **That is a security-class change and this ticket does not make it.** The transport is redesigned in the Design section below. What survives from round 1 is only the narrower true claim: `scripts/dispatch.mjs` is a working out-of-harness child-lane contract, and the broker is a worked example of a per-project socket with caps and a declaration line — a template to copy, not a socket to reuse.

### What is LOST by owning the lifecycle

1. **The synchronous await — and this one reorders the migration.** A native lane returns its final message as a `tool_result`: the orchestrator can *wait inside one turn* for N lanes and get N results in one wake. That is the half of the user's fix that is already free today, and an Orchard-owned lane cannot reproduce it — a blocking Bash call caps at 10 minutes (harness tool timeout) while lanes routinely run longer, and holding a broker connection open for an hour occupies a tool slot with no progress visibility. **Replacement:** the group-settle drain (one synthesized wake when the last lane in a dispatch group settles) is not polish, it is the substitute for foreground fan-out. Consequence for sequencing: **migrating dispatch before the drain exists makes the system strictly worse.** Round 1 stated that rule and then violated it by shipping non-blocking dispatch in step 1 and the drain in step 2, guarded only by a prompt-layer "the orchestrator opts in" — the exact mechanism class this ticket disqualifies. The review's worked sequence is correct and is now fixed by construction: the drain ships **in the same step as non-blocking dispatch** (see Migration).
2. **Server-initiated session creation does not exist.** Sessions are started by an attached WebSocket client (`index.ts:3526` `case 'start'`, guarded by "this socket already has a session", with re-attach/liveness logic written around a tab). Detached *operation* exists (sessions survive a tab looking away), but *creation* has no clientless owner. Cost: a real new lifecycle path — an internal launcher, a client-less event sink, and detach/reap semantics for a session no tab ever owned. This is the single largest build item in the final step, and the reason the first step uses a one-shot child process rather than a full session.
3. **Worktree isolation is a harness freebie with no Orchard equivalent.** `isolation: "worktree"` gives a native lane its own git worktree, auto-cleaned. Orchard has `src/server/fork.ts` (transcript forking across store dirs) and nothing that provisions a worktree per lane; the only worktree mentions in `src/` are registry warnings that a worktree is a *separate project row*. Cost: either build per-lane worktree provisioning + cleanup, or accept that concurrent same-tree lanes must be serialized by the orchestrator as they are today outside worktrees. **Honest answer: not replaced in this plan.** Recommend keeping native lanes for worktree-isolated work until someone wants to pay for it (this is one input to the residual fork).
4. **Live per-lane progress, on the first migration step only.** The anthropic path of `dispatch.mjs` runs `claude -p --output-format json` — one blob per turn, no streaming (a limitation the script documents itself). A lane dispatched that way shows no ◐ progress; the user sees "running" and then a result. Restored in the final step, when children become real AgentSessions with their own live transcripts. Cost: a known regression in visibility for the duration of the migration, which must be stated on the rail rather than hidden.
5. **Mid-lane permission escalation routes to the parent's UI today.** A native subagent's approval prompt surfaces in the orchestrator's session. A headless child must either pre-declare its mode or relay `can_use_tool` to the dashboard. Cost: real but bounded and already prototyped — `survivor-delivery.ts` does exactly this relay (with a bounded wait and an honest deny on timeout), and `--permission-prompts` gives the CLI-side seam. Reuse it; do not invent a second one.
6. **Concurrency caps are far below current fan-out, and this is step-1 work, not step-4 work.** `PROJECT_CAP=2` / `GLOBAL_CAP=6` versus the 5–8 lane fan-outs this project actually dispatches. Round 1 deferred this to step 4 on the assumption that lanes would share the broker's counters; since they no longer do (they get their own runner), the lane runner needs its own cap decided at the moment it is built. Cost: a deliberate limit justified against machine load — not a silent bump, and not a number inherited from a socket built for two concurrent read-only reviews.
7. **Round-2 correction — restart survival is a gain over the orchestrator's CLI and a LOSS against the server.** Round 1 listed "a child survives the orchestrator's CLI restarting" as a strict gain. Half of it is wrong: a lane spawned by the Orchard server is a child of the *server*, and the server restarts routinely here. Until the lane runner spawns under the FEAT-015 survival scope (systemd, the same mechanism sessions already use), a lane trades death-with-the-CLI for death-with-the-server, plus an orphaned child and a ledger row frozen at `running`. The design below closes the ledger half with boot reconciliation; the process half is closed only when the runner adopts the survival spawn, and until then it must be stated on the rail rather than assumed away.

**Not lost, contrary to expectation** (each checked, so the next reader does not re-litigate): context inheritance (native lanes start fresh too, and Orchard already composes CLAUDE.md + WA + CONVENTIONS at launch, `agent-bridge.ts:985-1010`); model routing and agent definitions (`--agents` / `--model`, plus the frontmatter is already a file Orchard can read); continuing a lane with its context intact (`dispatch.mjs --resume`, and `send()` for a real child session); result harvesting (`scripts/harvest-agent.mjs` re-points at a child transcript). **One thing is strictly gained:** an Orchard-owned child can itself dispatch (native subagents cannot nest) — with the matching hazard that recursion must be capped. The second claimed gain (surviving the orchestrator's CLI restart) is conditional, not strict — see loss 7.

## Design

**One record, one owner, one reader path.**

- **The record — a lane ledger, sibling to `outcomes.ts`, not an extension of it.** A new store `src/server/lanes.ts`, same construction (JSON under `dataDir()`, atomic write) : `LaneRecord { id, projectId, parentSessionId, groupId, label, charter, provider, model, dispatchedAt, state: 'running'|'settled'|'failed'|'cut', settledAt, resultPointer, resultExcerpt, failureKind, usage, deliveredAt, deliveredBy: 'group-settle'|'user'|'orchestrator'|'timeout', dismissedAt }`. Separate store because `outcomes.ts` states as policy that it holds deaths only and that storing normal completions would blow it up; folding both in would make one file answer two questions with two retention rules — the ARCH-010 defect in miniature. They stay siblings, and `running-set.ts` carries both, as it already does for outcomes.
- **Retention — the one place round 1 copied a template into a data-loss bug.** `outcomes.ts` prunes unconditionally (`MAX_RECORDS = 200`, `records.slice(records.length - MAX_RECORDS)`, `outcomes.ts:119`/`:138`). Copied as round 1 specified, a busy period silently deletes the oldest **settled, undelivered** lane — precisely the failure this ticket calls the worst available. Rule: **pruning skips any record with `deliveredAt === null` and `dismissedAt === null`**; only delivered/dismissed records age out. If undelivered records alone exceed the bound, the store does not prune, it **refuses new dispatches** and says why — backpressure, never deletion. Authority: `resultPointer` (a file path under the lane's own directory) is authoritative; `resultExcerpt` is a bounded excerpt for the rail only. A lane result is orders of magnitude larger than a death record, which is exactly why `outcomes.ts` can afford 200 inline rows and this store cannot.
- **`deliveredAt` is the whole feature.** A settled lane with `deliveredAt: null` is a result Orchard is holding. Nothing else in the system needs to define "pending" — every surface reads that field. That is the testable form of the invariant.
- **Dispatch — a lane runner, NOT the OpenAI broker socket.** New `src/server/lane-runner.ts`, modelled on the broker (per-project unix socket, request validation table, caps, the FEAT-100 `Dispatch:` declaration) but with its own name, its own tool-settings switch, and — the point — **its own spawn path: the project's own isolation routing, the same one `AgentSession` uses** (`agent-bridge.ts:1214-1311`: direct, `docker exec` for `isolation:'container'`, or the FEAT-015 survival scope). A container-isolated project's lane runs INSIDE its container. This is the round-2 correction to the security hole the review found in reusing the broker, and it is not optional: the broker's host-side `cwd: project.hostPath` spawn is safe for a read-only Codex review and is a container escape for an agentic `workspace-write` Claude lane. `dispatch-broker.ts` is untouched by this ticket.
- **The dispatcher declares the group; nobody derives it.** `op:'start'` carries `{ groupId, groupSize }` — or `{ groupId, groupOpen: true }` followed by an explicit `op:'closeGroup'` when the count is not known up front. A group is **settled** when it is CLOSED and every declared member has reached a terminal state. Round 1 said "when the last lane of a groupId settles" and left "last" to be derived from the running set, which the review correctly showed produces a drain per lane for sequential dispatches — N wakes, the feature delivering nothing, with every specified test still passing. Per ARCH-010 the cardinality is the dispatcher's fact and it is declared at dispatch. Three hardening rules the declaration alone does not give: a declared member that never spawns is recorded `failed` immediately (a wrong count must not freeze a group); an open group carries a **close deadline** (default 30 min from last member) after which it closes itself and drains what it has, marked as such; and a lane arriving for a closed group starts a NEW group rather than reopening one — reopening is how a drain races a dispatch.
- **The hold.** Settlement writes the ledger and emits a station event for the rail. It does **not** call `send()`. That is the entire suppression mechanism, and it is suppression-by-construction rather than by policy: there is no wake to suppress, because Orchard is now the one who would have to cause it.
- **The drain — one function, four callers.** `drainLanes(parentSessionId, laneIds)`: reads the named settled-undelivered lanes, composes ONE message (per-lane: **the lane id as a literal token**, label, verdict line, durable pointer — ARCH-016's contract, not the full prose), calls the parent session's `send()` (BUG-159 hold+push: delivered now if idle, queued at the next turn boundary if busy, never refused), and stamps `deliveredAt` + `deliveredBy` **only after `send()` returns**. Callers: (a) automatic on group settle — the default, and the replacement for foreground fan-out; (b) automatic on **age**, see starvation below; (c) the user, from the rail, for any subset; (d) the orchestrator itself, pulling early. It is the only writer of lane result text into a parent's context, which is what makes the invariant testable.
- **Starvation is closed by a mechanism, not by a badge.** Round 1 asserted a pending lane "must be surfaced rather than sitting quietly" and gave the rail an age stamp — visibility, not delivery: a user who is not looking never gets the result. Rule: a settled-undelivered lane older than `LANE_HOLD_MAX_MS` (default 30 min, per project) is drained automatically with `deliveredBy:'timeout'`, together with any other pending lane for the same parent (one wake, not one per lane). The bound exists so that the worst case of this design is *late*, never *never*. The knob is a project setting because a user who wants strict accumulate-until-I-say can set it high and accept the consequence explicitly.
- **Boot reconciliation — a `running` record is a claim, not a fact.** The settle write happens in the Orchard server process; if the server restarts mid-lane the record is stuck `running` forever, the child is orphaned, and the group can never settle — silently holding every already-finished sibling. At server start, every `running` lane record is re-checked against ground truth (the child's pid / survival-scope status, the same liveness discipline ARCH-001 and BUG-033 already impose on sessions): still alive → re-adopt; proven dead → mark `cut` with an honest reason, which lets the group settle and drain. Never guess, never leave the claim standing. A lane record must never outlive the evidence for its own state.
- **Cost attribution.** Each lane record carries `usage` (tokens/cost from the child's own run metadata — `dispatch.mjs --meta-out` already emits the machine-readable channel), keyed by lane id and rolled up per group and per parent session. Without it the fan-out cost this ticket exists to reduce becomes unmeasurable exactly when it is migrated, and the falsification clause below cannot be evaluated. `scripts/cost-collect.mjs` reads it through the same `Dispatch:` grammar (FEAT-100) it already uses.
- **The other reader of this fact, folded in.** `src/server/subagents.ts` + `GET /api/sessions/:id/subagents` (`index.ts:2577`) reconstruct lane existence and completion from the CLI-written `subagents/agent-*.jsonl` transcripts. An Orchard-owned child writes no such transcript, so after this lands that route and the ledger answer "did lane L complete" from different sources and disagree by construction — the subagent panel showing an empty fan-out while the rail shows five settled lanes. Round 1 ruled out the strip and the decisions rail and never mentioned the one surface that actually re-derives the fact. Rule: that route becomes a **merged reader** — ledger records for owned lanes, transcript reconstruction for native ones, one list, each row stating which it is. It is a read-side union over two disjoint populations, not two answers to one question. If the merge is judged too large for the first step, then the invariant is scoped honestly in the same commit ("owned lanes only") and the panel says so on its face; silence is the ARCH-010 defect.
- **The surface.** A new rail sub-section `#railPending`, sibling to `#railStopped` (`public/index.html:480`), cloned from `renderOutcomes()` (`app.js:5577`): section header with a **process all** link (mirroring `dismiss all`, `app.js:5591`), one row per pending lane with **process** and **discard** (mirroring per-item `dismiss`, `app.js:5631`), optimistic local mutation then server write with refetch-on-fail (`dismissOutcomeIds` pattern, `app.js:5560`). Polled inside `pollRail()` next to `refreshOutcomes()`. API helpers `pendingLanes()` / `processLanes(ids|'*')` in `public/lib/api.js` copy-shaped from `agentOutcomes`/`dismissOutcomes` (`api.js:738`), capability-gated through `optional()` so an older server simply hides the section. A passive count chip in `renderRailSummary()` for the default path, which otherwise needs no control at all.
- **Where the prior art does NOT fit, stated plainly.** `decisions.ts` and the Needs-You rail are the wrong host: a decision is an *inert record answered by a human*, and its rail path (`renderRail()` `app.js:5677` → `boardRow()`) is hardwired to board tickets keyed by ticket id. A pending lane is neither a question nor a ticket, and carrying it there means faking ticket rows. Reuse the *pattern* (server record + user action + deliver back to the raising session, as in `POST /api/sessions/:sid/needs-you`, `index.ts:2158`); do not reuse the store or the rail section. The agent strip is also the wrong host, for the reason BUG-030 exists.

## What must be true before the first line is written

- The parent may be dead when a drain is requested. `send()` throws on a closed session (`agent-bridge.ts:1571`). The drain must resume-then-deliver, or refuse with an honest message that says the result is still held — it must never mark `deliveredAt` on a send that did not happen.
- Delivery is stamped after `send()` returns, never before, and a lane whose stamp write fails stays pending — a duplicate delivery is a nuisance, a lost result is the failure this ticket exists to prevent.
- Pruning never deletes an undelivered result; at the bound the store refuses new dispatches instead.
- No Claude lane crosses the OpenAI dispatch socket. The lane runner spawns through the project's own isolation routing.

## Is the cost the WAKES or the PAYLOAD?

The reviewer flagged this as the shared blind spot: both rounds assume the user's cost is the number of wakes, while ARCH-016 argues it is what each wake carries. The measured split says **both, and they are separable — this ticket buys down the half ARCH-016 cannot reach.**

From the orchestrator's own `cost-collect` figures for one session: 641 completion wakeups cost **$509**, and the floor cost of a wake that only reads and speaks — no lane payload at all — is about **$0.33** of pure context replay. So roughly **$211 of that $509 is the wake floor**: it is paid because a turn opened, whatever the completion carried, and no payload-side fix can touch it. The remaining ~$298 is payload-shaped and is exactly ARCH-016's lever. This design collapses N wakes per fan-out into one, attacking the floor; it also composes the drain message as verdict + pointer rather than N full results, so it takes a second bite at the payload half — but that second bite is ARCH-016's contract doing the work, not this ticket's, and it should not be counted twice.

A payload-only fix would be cheaper to build and would leave the $211 floor and, decisively, **cannot deliver the escape hatch at all**: "give me this one lane's result now, and hold the rest" is a statement about *when a turn happens*, which is the wake axis by definition. Honest limits on the number: $0.33 × N is a lower bound on a floor that scales with the parent's context size (it grows as the session does), the 641 wakes include lanes this design would not own, and the saving realised depends on the group-size distribution — a fan-out of 1 saves nothing. **Falsifiable form:** with per-lane `usage` recorded (see Design), measure wake count and cost per fan-out before and after. If the post-change wake count per group is not ~1, or if total cost per fan-out does not fall by roughly the wake floor it removed, the premise was wrong and the money was all in the payload.

## Decision — should every dispatched lane become Orchard-owned, or only background lanes

The architecture (Orchard owns dispatched-lane completions) is already chosen and is not re-opened here. The one genuinely open question is **scope**, and it needs project-direction knowledge no lane has: whether the dashboard must be the single lifecycle authority for *every* lane including two-minute helpers, or whether fast in-turn helpers may stay in the harness.

- **A — Background lanes only (recommended).** Orchard owns every lane dispatched as background work; short foreground helpers (`Explore`, a quick read, anything worktree-isolated) stay native Task-tool lanes. Buys: the whole feature, at a fraction of the build, with no regression on the two things Orchard cannot replace (worktree isolation, in-turn synchronous await). Costs: two dispatch mechanisms coexist. **Why this does not violate ARCH-010:** the fact "a lane completed and is awaiting delivery" has exactly ONE owner and one record — a native foreground lane never produces that fact, because it is consumed inside the turn that asked for it. Two *transports*, one *fact*. The rule that is violated is two places able to hold a different answer to the same question, and this is not that. **It becomes that the moment a native lane runs in the background, and the boundary is a call-time parameter (`run_in_background`), not a property of the lane — so it cannot be honour-system.** Round 1 guarded it with a sentence in the Working Agreement, which this ticket's own "why local patches did not hold" disqualifies. Round-2 fix, and it is cheap: a `PreToolUse` deny on `Agent` with `run_in_background === true`, on the same in-process callback that already carries the git-write block and the tool profile (`claude-runtime.ts:750`, `decide()`), reading a field Orchard's hook layer already reads today (`scripts/hooks/orchestrator-surface-log.mjs:125` records `background: i.run_in_background === true`). The deny message names the lane runner as the route. This rides the highest-stakes hook in the system, so it ships with the same independent-verify requirement ARCH-016 put on the Fable gate, and it fails **open** (allow) if the field is absent — a missed deny is a wake, a wrong deny is a blocked orchestrator.
- **B — All lanes Orchard-owned.** One dispatch primitive, no exceptions, the harness Task tool retired for this project. Buys: one mechanism, unarguable. Costs: must rebuild worktree isolation and accept that in-turn synchronous helpers become ledger round-trips, adding latency to the cheapest, most frequent lanes for no gain on the problem being solved.
- **C — Do nothing / keep patching.** Every fan-out keeps costing N full-context turns, the escape hatch stays unbuildable, and the next attempt re-derives this whole finding. Price of it: the measurable one is in ARCH-016 (lane replay is the largest reducible context category); the unmeasured one is that the user's stated need has no path at all.

## Migration path

Each step lands on its own, leaves the system working, and is verifiable without the next one. **Round-2 change, and it is the most important one on this ticket: the automatic drain moved OUT of step 2 and INTO step 1.** Round 1 shipped non-blocking dispatch first and the drain second, guarded only by a prompt-layer opt-in. The review's worked sequence is right: in that window a 5-lane fan-out returns no `tool_result`, the orchestrator has nothing to summarise and either idles or polls, and the per-item pull then costs 5 `send()` wakes plus human clicking — an automatic N-wake fan-out converted into a manual N-wake fan-out, reachable without anyone doing anything wrong. Splitting the one function across two releases bought no rollback safety either, because step 1's *normal* state was step 2's *degraded* state. They are one step now.

**Step 1 — the ledger, written from the existing blocking path. Nothing reads it.** Add `lanes.ts` (with the undelivered-exempt prune rule, which lands with the store and not later) and write records from the *existing* blocking `op:'dispatch'` on the OpenAI broker — read-only observation of a path that already runs, no new spawn, no new provider, no security surface. Verifiable: run a real cross-provider dispatch, assert one `settled` record with pointer, usage and declared group fields. Rollback: delete the file.

**Step 2 — the lane runner, the automatic drain, and the rail, together. ← this is the step that first gives the user the visible escape hatch.** All of: `lane-runner.ts` with `op:'start'` (returns a lane id immediately) spawning through the project's own isolation routing; dispatcher-declared `groupId`/`groupSize` + `closeGroup`; `drainLanes()` with the automatic group-settle caller AND the age-bounded caller; boot reconciliation of `running` records; the `#railPending` section with per-item **process**, **process all** and **discard**; the `PreToolUse` deny on background `Agent` calls; and the WA change naming the runner as the route for background work. The default path is fully automatic — one wake per fan-out, no clicking — and the manual pull is the increment on top of a system that already behaves correctly if the user never touches it. Rollback: disable the runner (the deny hook falls back to native lanes, which behave exactly as today) — the rail section is capability-gated and hides itself. This is the only step whose rollback is a real fallback rather than a degraded state, which is the point of merging.

**Step 3 — children become real Orchard sessions.** Replace the `dispatch.mjs` child with a server-initiated `AgentSession` (the clientless launch owner from loss 2), restoring live per-lane progress, `send()`-based continuation, and true restart survival (closing the process half of loss 7). The ledger, the rail, the drain and the orchestrator's contract are all unchanged — this step swaps the transport under a stable record, which is the whole reason the ledger comes first. Rollback: keep both transports behind one field on the lane record for one release; the reader never learns which one ran.

**Step 4 — the subagents panel merge, and worktrees.** `GET /api/sessions/:id/subagents` becomes a merged reader (ledger + transcript reconstruction, each row stating its source). Worktree isolation either built for owned lanes or documented as native-only, which settles the residual half of option A. If the merge is not done here it must have been scoped into the invariant in step 2, not left silent.

**Caps** are decided in step 2, with the runner, not deferred — see loss 6.

## Proof bar — what must be true, and what would falsify this

Each item names the failure it catches; anything that could have passed before the redesign is marked as such and does not count on its own.

1. **The invariant, mechanically — with a join key.** `drainLanes()` stamps the lane id as a literal token in the message it composes. Assertion: for every settled lane, exactly one record exists, and that token appears in the parent's transcript **at or after `deliveredAt` and nowhere before it**; and every occurrence of the token in the parent's transcript corresponds to a record with a non-null `deliveredAt`. Catches a result reaching the parent by any route other than the drain. Round 1 said "a turn *attributable* to that lane", which is human judgement — the re-derivation ARCH-010 forbids — and the review was right to reject it.
2. **Must-FAIL first.** The same assertion run against today's native background dispatch must FAIL (there is no record at all). If it passes before the change, the test is vacuous.
3. **Completion while the orchestrator is mid-turn.** Settle a lane while the parent is `busy`. Expected: the ledger is written, no wake, and a subsequent drain queues through the BUG-159 InputQueue path and runs at the next boundary. Catches: reintroducing the refusal BUG-159 removed, and a race where `busy` is stale.
4. **Held result whose session dies.** Settle a lane, kill the parent CLI, then drain. Expected: either resume-then-deliver, or an honest refusal — and in **both** cases `deliveredAt` stays null and the result stays pullable after a server restart. Catches the data-loss case, which is the worst failure available here.
5. **Drain racing a new dispatch.** Fire a group-settle drain and a new `op:'start'` for the same parent concurrently, repeatedly. Expected: the new lane is never folded into the in-flight drain's message, never silently dropped from a later one, and — because a lane arriving for a closed group opens a new one — never reopens a group that has drained. Catches the membership race and lost-update on the ledger.
6. **Group closure, the case every round-1 test passed.** Dispatch N lanes **sequentially**, each settling before the next starts, all in one declared group. Expected: exactly ONE drain, at declared-count completion. Round 1's design fires N. Also: a declared member that never spawns (expected: recorded `failed`, group still settles, no freeze); an open group whose close deadline expires (expected: self-closes, drains what it has, marked `deliveredBy:'timeout'` with an honest reason). Catches the hole the review found — every one of these is well-formed under the round-1 spec and delivers nothing.
7. **Exactly-once under concurrency.** Two clients press **process** on the same lane simultaneously; and `send()` succeeds but the stamp write fails. Expected: one delivery, or (in the stamp-failure case) a second delivery of a still-pending lane — never a lane marked delivered that was not sent.
8. **Writer death — the server restarts mid-lane.** Start a group, kill the Orchard server with lanes `running`, restart. Expected: boot reconciliation resolves every `running` record against ground truth (re-adopt if alive, `cut` with a reason if proven dead), the group settles, the drain fires, and no already-settled sibling is held. Catches the silent freeze — one no rail badge would ever show, because the group's other lanes look correctly "waiting".
9. **Starvation, with a mechanism behind it.** A settled, undelivered lane must be visible with no model in the loop (the FEAT-057 property) **and** must be delivered automatically once older than `LANE_HOLD_MAX_MS` with nobody looking at the dashboard. Assert delivery with no client attached at all. Catches the failure this design most naturally introduces: replacing "too many wakes" with "a result nobody ever collects". Round 1 tested only visibility, which is not delivery.
10. **Prune never eats an undelivered result.** Drive the store past its bound with undelivered records. Expected: nothing is deleted, and new dispatches are refused with a reason. Must-FAIL leg: the same test against a store using `outcomes.ts`'s unconditional `slice()` loses the oldest result — this is a real bug the round-1 spec would have shipped.
11. **Truncated/partial reads.** The runner writes the ledger while the API reads it; grade reads truncated at several plausible points against the real record, per WA. Catches a shape-correct fixture hiding a timing bug.
12. **Isolation.** For a container-isolated project, assert the lane's process runs INSIDE the container — no host-side execution, and no Claude request accepted on the OpenAI dispatch socket. Catches the escape the review found in the round-1 transport.
13. **The boundary hook.** With the deny in place, a background `Agent` call is refused with a message naming the runner; a foreground one is untouched; a malformed/absent field allows (fails open). Catches both an unenforced boundary and a hook that blocks the orchestrator.
14. **Attribution.** Every lane record carries usage, and per-group cost is readable by `cost-collect`. Without this, item 15 cannot be evaluated at all.
15. **The user's reality, not the mechanism.** Drive the real rail in a headless browser over a **busy-state** fixture — several groups, some lanes running, some settled-undelivered, some delivered, some failed, one group frozen by a killed writer — and pull one lane early. A clean single-lane fixture does not count; that is the exact shape that has passed here before and been wrong in use.

**What would falsify the redesign:** if, after step 2, a fan-out still produces more than one orchestrator turn per group; or if measured cost per fan-out does not fall by roughly the wake floor removed (see the wakes-vs-payload section — that would mean the money was in the payload and ARCH-016 was the whole answer); or if lane throughput has to be capped so low that the fan-out the user actually runs no longer fits; or if the age-bounded auto-drain has to be set so short that the hold is not a hold. Any of those means the ownership move did not buy what it claims.

**High-stakes, WA §N.** This is session-lifecycle plus concurrent state plus a data-loss surface (a held result) plus, in step 2, both an isolation boundary and the `PreToolUse` hook. Self-verification is not the last word at any step: each of steps 2, 3 and 4 needs an independent clean-room dispatch (`scripts/independent-verify.mjs`), and step 2 touches the same `send()`/InputQueue path BUG-159 fixed — run that ticket's suite as an anti-regression and record `regressed-from:` if anything there moves. The round-1 plan was reviewed and came back not-safe-to-build; that review is in the Activity log and its four broken axes are what this revision closes.

## Context pack (grows — the "where to look", so no agent cold-starts)

- **Server:** `src/server/dispatch-broker.ts` (whole file, 157 lines — the TEMPLATE to copy, provider-locked and NOT to be extended: `validate()` provider check, `runDispatch()` host-side `cwd: project.hostPath`, `dispatchBinds()`); `src/server/outcomes.ts` (the ledger template — and `:119`/`:138`, the unconditional prune that must NOT be copied); `src/server/container-manager.ts` + `agent-bridge.ts:1214-1311` (the isolation routing the lane runner must spawn through); `src/server/runtime/claude-runtime.ts:750` + `decide()` (the `PreToolUse` seam for the boundary deny); `scripts/hooks/orchestrator-surface-log.mjs:125` (proof the `run_in_background` field is already visible to Orchard's hook layer); `src/server/agent-bridge.ts:498` (autonomous nudge), `:985-1010` (instruction composition + the dispatch note appended to every session's system prompt), `:1060` + `:1226-1311` + `:1478-1482` (spawn config), `:1571` (`send()` hold+push), `:2883` (`#markForegroundTurnLive`); `src/server/index.ts:2158` (needs-you raise — the record/action/deliver-back pattern), `:2512` (read-only subagents route), `:3526` (`case 'start'` — why server-initiated sessions are new work); `src/server/survivor-delivery.ts` (approval relay to reuse); `src/server/running-set.ts`; `scripts/dispatch.mjs` (child process contract, `--resume`, `--meta-out`, `--prompt-stdin`, timeout, failure taxonomy).
- **Client:** `public/index.html:480` (`#railStopped`, the sibling anchor); `public/app.js:5404` `refreshOutcomes`, `:5560` `dismissOutcomeIds`, `:5577` `renderOutcomes`, `:5591`/`:5631` (drain-all + per-item actions), `:6355` `pollRail`, `:113`/`:8947` (why the strip cannot host this); `public/lib/api.js:23`/`:45`/`:738` (`api`/`optional`/`dismissOutcomes`).
- **Related tickets:** BUG-159 (the delivery path and the anti-starvation constraint), FEAT-057 (record server-side, render with no model in the loop), FEAT-064/065 (drain and stdin injection — neither is a completion queue), ARCH-016 (what a lane's return payload may contain), ARCH-010 / `docs/CONVENTIONS.md` (the decision procedure the scope fork is argued against), BUG-030 (`scripts/verify-stale-agent-cards.mjs`, the strip's retirement rule), FEAT-100 (the `Dispatch:` declaration the broker already forwards), FEAT-015 (survival).
- **Repro test:** none exists. Step 0 must add `npm run verify:lane-ledger`; the must-FAIL leg of proof item 2 is the first thing it should contain.
- **Known dependencies / blockers:** the scope fork below needs the user. Nothing else blocks step 0.

## Decision record (filled in once an option above is chosen)

- **Chosen option:** …
- **Explicitly rejected:** routing only escape-hatch lanes through `scripts/dispatch.mjs` as an END STATE — rejected by the user before this ticket was written, under ARCH-010: it leaves two mechanisms able to hold different answers about what a completed lane is. It survives here only as the *transport* of migration steps 1–2, under a single ledger that owns the fact, and is replaced in step 3.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — dispatched plan+review lane (finding round 1)

- **Understood:** the user's fan-out costs N wakes because the completion is generated inside the orchestrator's own CLI and Orchard never sees it as an event. Two prior scoping lanes (`_scratch-drain-scoping-server.md`, `_scratch-drain-scoping-ui.md`) established that independently; I re-checked their pivotal claims against the code rather than inheriting them, and both hold.
- **Changed:** this ticket only. No code. `docs/bugs/INDEX.md` regenerated.
- **Verified:** the hypothesis I was sent to test (owning the lifecycle costs nothing lanes depend on) SURVIVES with four priced exceptions and one sequencing consequence, all listed under "What is LOST". Method: read `dispatch-broker.ts` end to end; `claude --help` on the installed CLI for `--agents`/`--permission-prompts`/`--model`/`--resume`; `agent-bridge.ts` spawn and send paths; `index.ts` `case 'start'` for whether a server can create a session without a client (it cannot today); `grep -rn worktree src/` for whether worktree isolation has any Orchard equivalent (it does not). No test was run — this ticket is design only, and the proof bar above is written to be run by the engineer, not claimed here.
- **Still open / handoff:** the scope fork (option A vs B) needs the user. Step 0 is safe to start regardless: the ledger is identical under either option. The engineer should start there and must NOT start step 3 before step 2, for the reason in loss #1 — migrating dispatch before the group-settle drain exists removes the free half of today's behaviour and makes fan-outs worse.
- **Symptom of a deeper design flaw?** This ticket IS the ARCH ticket; the class it names is ARCH-010's, applied to lane lifetime rather than to a display fact.

### 2026-09-08 — independent adversarial review of the plan (finding round 1, plan+review)

Reviewer did not write the plan and implemented nothing; no code or config changed, only this
log appended. **Provider caveat, stated up front:** this review was chartered to run
cross-provider (OpenAI) for decorrelated blind spots; that quota window is exhausted, so it ran
SAME-PROVIDER. Treat shared-prior blind spots as under-tested — in particular, both author and
reviewer accept without argument that "one wake per group" is the right unit, and neither
attacked the premise that the user's cost problem is wakes rather than what each wake carries
(ARCH-016 already claims the latter, and the plan's own falsification clause concedes the win
may live there). A genuinely decorrelated reviewer should be pointed at that premise first.

Method: read the ticket in full, then re-derived its pivotal code claims rather than inheriting
them — `src/server/dispatch-broker.ts` end to end (157 lines), `src/server/outcomes.ts`
construction + prune, `scripts/dispatch.mjs` option surface, `agent-bridge.ts:1000-1010`
(dispatch note composition + its gate), `index.ts:2168`/`:2577-2637` (subagents route),
`src/server/subagents.ts` header, `docs/CONVENTIONS.md` ARCH-010 decision procedure. Two of the
plan's grounding facts do not survive that re-check (F1, F2 below). Verdicts follow the five
attack axes in the charter.

**F1 — the broker is not the seam the plan says it is; it is provider-locked to OpenAI, by
design and by security review.** `validate()` (`dispatch-broker.ts`) rejects anything but
`provider === 'openai'` with `invalid-provider`; `op:'capabilities'` advertises
`providers:['openai']`; `runDispatch()` hardcodes `'--provider','openai'` into the child argv;
the file header states its whole purpose — "Host-side OpenAI dispatch broker. Credentials and
Codex never cross into a project." The plan's claim that "`scripts/dispatch.mjs` already
supports `--provider anthropic`" is true of the SCRIPT and false of the BROKER, and the ticket
carries that conflation into step 1 ("same validation table, same caps"). Step 1 is therefore
not "add `op:'start'` to an existing seam": it is *also* opening a second provider on a socket
whose isolation posture was designed around exactly one. Unpriced consequences:
- **Container escape, for container-isolated projects.** `runDispatch()` spawns the child with
  `cwd: project.hostPath` on the HOST and reports `cwdForced`. For an `isolation:'container'`
  project the socket dir is bind-mounted in (`dispatchBinds()`), so a session inside the
  container can already cause host-side execution — deliberate and reviewed for a read-only
  Codex run. Routing the project's OWN agentic Claude lanes through it makes the broker a
  general-purpose "run agentic work outside my container" primitive, at `workspace-write` if
  asked. That is a security-class change and it appears nowhere in the ticket.
- **The transport is behind an off-switch named after the other provider.**
  `toolSettingsOf(project).openaiDispatch` (`agent-bridge.ts:1005`) gates whether a session is
  even told the socket exists. A project with it off gets no lanes at all in steps 1–2.
- **Caps are wrong either way.** `PROJECT_CAP=2`/`GLOBAL_CAP=6` are in-memory counters
  (`activeByProject`, `activeGlobal`) shared with today's cross-provider review dispatches. If
  Claude lanes share them, one 5-lane fan-out starves the OpenAI escape hatch this socket exists
  for; if they don't, "same caps" is false and the re-pricing is step-1 work, not step-4 work.

**F2 — no crash/restart recovery for the ledger, and the one place the plan gets survival
backwards.** The `settled` write the plan assigns to the broker happens in `finish()`, inside
the Orchard SERVER process. A lane spawned by `op:'start'` is a child of that server. If the
server restarts mid-lane (routine here), `finish()` never runs, the record is stuck `running`
forever, the child is orphaned, and the in-memory cap counters reset while it still consumes
CPU. Two live consequences the plan does not name: (a) group-settle can NEVER fire for that
group, so every already-settled sibling result in it is held indefinitely — a *silent* variant
of the starvation the plan says it most fears, and one no ageing badge on a rail catches because
the group's other lanes look correctly "waiting"; (b) the plan lists "a child survives the
orchestrator's CLI restarting" as a strict GAIN over native lanes, which is true of the
orchestrator's CLI and false of the server — in steps 1–2 the lane's lifetime is bound to the
server process, i.e. it trades one death for a different one rather than gaining survival.
Nothing in the design or the proof bar performs a boot-time reconciliation of `running` records.

---

**1. Migration ordering (plan's own headline risk) — BREAKS.**
The plan states the rule ("migrating dispatch before the drain exists makes the system strictly
worse") and then violates it in its own step list. Step 1 ships `op:'start'` — non-blocking
dispatch, the migration — and step 2 ships the drain. The only thing standing between them is
the sentence "the orchestrator opts in per dispatch", i.e. a PROMPT-LAYER convention, which this
same ticket rejects as a mechanism three sections earlier ("Why local patches did not hold").
Concrete sequence where the user is worse off than today, entirely within shipped step 1:
1. Orchestrator issues a 5-lane fan-out via `op:'start'` (it is the newest, most-advertised
   path, and the WA change that would have told it not to is step 2's).
2. Each call returns a lane id immediately, so the turn ends with no results. The orchestrator
   has nothing to summarise and no await; the natural degenerate behaviours are to sit idle
   (user waits, believing work is being reported) or to poll with sleep/loop turns — burning
   more turns than the 5 wakes it replaced.
3. Five results land in the ledger, waking nobody. The user must notice the rail.
4. Per-item **process** — the feature step 1 exists to deliver — calls `send()` once per lane:
   **5 wakes, plus manual clicking**, versus 5 wakes automatic today. "Process all" recovers one
   wake only if the user knows to wait for all five and to prefer it.
Net: step 1 alone converts an automatic N-wake fan-out into a manual N-wake fan-out that also
requires human attention. That is strictly worse on both axes the user complained about, and it
is reachable without anyone doing anything wrong. The plan's rollback story does not help — it
is written for step 2 ("disabling the auto-drain leaves everything pending and pullable"), which
is precisely the degraded state step 1 ships as its *normal* state.

**2. Group-settle timing — one CLOSED, three NAMED-not-closed.**
- *Lane settles while the orchestrator is mid-turn* — **CLOSED.** Hold-by-construction plus the
  BUG-159 hold+push InputQueue is a real mechanism, and proof item 3 tests the right thing.
- *Drain racing a new dispatch* — **NAMED ONLY, and the naming misses the actual hole.** Proof
  item 5 tests message *contents* (a new lane must not be folded in, must not be dropped later).
  The unaddressed question is prior: **nobody owns group membership or group CLOSURE.** The
  design says "the last lane of a `groupId` settles" but never says who assigns `groupId`, when
  a group stops accepting members, or how "last" is known. Derived-by-observation, "last" means
  "no other member is currently running", which produces: (i) a lane that settles before its
  siblings are dispatched fires a drain of size 1, then again at the real end — 2+ wakes; (ii)
  lanes dispatched sequentially within a turn (each settling before the next starts) fire N
  drains — N wakes, i.e. the feature silently delivers nothing, and no test in the bar would
  notice because each individual drain is well-formed. This is ARCH-010 applied to the plan
  itself: group cardinality is a fact the DISPATCHER owns and must declare at `op:'start'`
  (group id + expected member count, or an explicit `closeGroup`), and the plan leaves every
  reader to work it out from the running set.
- *Held result whose session dies* — **CLOSED for the parent's death, OPEN for the writer's.**
  "Resume-then-deliver or honest refusal, never stamp a send that did not happen" is correct and
  well-specified; proof item 4 tests it. But it covers the reader/parent only. F2 above is the
  same class on the writer side and is unhandled and untested.
- *Starvation* — **NAMED ONLY.** Proof item 7 asserts a pending lane "must be surfaced rather
  than sitting quietly" — that is a test with no mechanism behind it in the Design section. The
  only automatic drain caller is group-settle. Age-stamping is *visibility*, not delivery: if
  the user is not looking at the dashboard, a held result is held forever. In-process, the
  broker's `MAX_TIMEOUT_MIN=60` kill timer bounds it; across a server restart (F2) it is
  unbounded. The design needs a time-based or count-based auto-drain fallback — the plan
  replaces "too many wakes" with "possibly zero wakes" and closes only the first half.

**3. The invariant — BREAKS as written; the operational half is sound.**
Two different statements are doing duty as "the invariant" and only one is testable.
- The headline ("...and no surface, including the orchestrator's own model turn, learns of it by
  any other route") is **not testable and not enforceable.** The orchestrator can learn a lane
  finished by a dozen legitimate routes: `curl` the rail from Bash, notice files the lane wrote,
  read `harvest-agent.mjs`, see a commit, or — under option A — receive a native lane's
  `tool_result`. Stated absolutely, the invariant is false the day it ships.
- `deliveredAt: null` as the single definition of "pending" is genuinely good and is the ARCH-010
  -shaped part: one owner, one field, every surface reads it.
- Proof item 1 is **not mechanically decidable**: "the parent's transcript contains a turn
  *attributable to that lane*" has no key to join on — there is no lane-id token in the parent's
  transcript. A human judging attribution is exactly the re-derivation ARCH-010 forbids.
  Fixable: have `drainLanes()` stamp a machine-greppable lane-id marker in the composed message,
  and restate the invariant in enforceable form — *no lane result text enters the parent's
  context except via `drainLanes()`* — which IS testable, because `drainLanes` is then the only
  writer and the marker is the join key.
- **A second place able to hold a different answer is left standing, unmentioned.**
  `src/server/subagents.ts` + `GET /api/sessions/:id/subagents` (`index.ts:2168`, `:2577`)
  reconstruct lane existence and completion from the CLI-written `subagents/agent-*.jsonl`
  transcripts. After this design lands, the ledger and that route answer "did lane L complete"
  from different sources — and they will DISAGREE by construction, because an Orchard-owned
  child writes no `subagents/` transcript at all, so the subagent panel shows an empty or
  partial fan-out while the rail shows five settled lanes. The plan carefully rules the agent
  strip out (BUG-030) and the decisions rail out, and never mentions the one surface that
  actually re-derives the fact it is claiming to own. Either that route becomes a reader of the
  ledger or it is retired for owned lanes; silence is the ARCH-010 defect.

**4. Scope boundary (option A) — HOLDS as an ownership argument, BREAKS as an enforceable
boundary.** The distinction is real and the plan defends it correctly: a foreground native lane
is consumed inside the turn that asked for it and never produces the fact "settled and awaiting
delivery", so two transports over one fact is not two answers to one question. Grant that. What
fails is enforcement. The boundary is not a property of a lane TYPE — it is a parameter the
caller picks at call time (`run_in_background`), so it cannot be validated from the lane's
identity, and the plan's entire guard is "background dispatch via the Task tool must be
forbidden in the WA, not merely discouraged". A WA sentence is the prompt layer; this ticket's
own §"Why local patches did not hold" disqualifies exactly that. The moment one background Task
lane slips through — and the model reaches for `run_in_background` by default — there ARE two
places holding different answers, which the plan concedes in the same paragraph ("it becomes
that the moment a native lane is allowed to run in background"). The fix is available and
cheap and should be named in the plan rather than assumed: a PreToolUse deny on Task with
`run_in_background: true` (the harness hook surface Orchard already configures), so the boundary
is enforced by the same mechanism class as the rest of the design instead of by exhortation.
Without that, option A is honour-system and the plan should say so in the decision record.

**5. Replaceability and omissions — BREAKS (one mis-priced replacement, four omissions).**
- **The broker as transport is mis-priced** — F1 above. Not "the seam step 1 extends"; a
  provider-locked, security-reviewed, off-by-default, container-escaping socket.
- **Bounded oldest-first prune will delete undelivered results.** The plan specifies `lanes.ts`
  as "same construction as `outcomes.ts` (JSON under `dataDir()`, atomic write, bounded,
  oldest-first prune)". `outcomes.ts` prunes unconditionally: `MAX_RECORDS = 200`,
  `records.slice(records.length - MAX_RECORDS)`. Copied as written, a busy period silently
  deletes the oldest **settled, undelivered** lane — the exact data-loss failure the ticket
  names as "the worst failure available here", introduced by its own template. Pruning must
  exempt `deliveredAt === null`, and the plan must say whether `resultText` or `resultPointer`
  is authoritative (a full lane result is orders of magnitude larger than a death record, which
  is *why* `outcomes.ts` could afford 200 rows).
- **No boot-time reconciliation of `running` records** — F2. Omitted from Design and from the
  proof bar.
- **No group closure declaration** — attack 2. Omitted.
- **Cost/usage attribution for owned lanes is omitted.** Orchard accounts per session; a
  `dispatch.mjs` child's tokens land nowhere the dashboard reads, so the very fan-out cost this
  ticket exists to reduce becomes unmeasurable at the moment it is migrated — and the
  falsification clause ("if the drain's composed message costs materially more context than the
  N native completions it replaces") cannot be evaluated without it.
- Correctly priced and honestly left unreplaced: worktree isolation (loss 3) and the in-turn
  await (loss 1). No objection to either; the objection is only to the step order that follows
  from loss 1.

**Single change that most improves the plan:** merge the automatic group-settle drain into step
1 — ship `op:'start'` and `drainLanes()`'s automatic caller together, with the group's expected
membership declared by the dispatcher at start, and make the manual per-lane pull the increment
on top. It is the same one function the plan already describes ("one function, three callers");
splitting it across two releases buys no rollback safety (step 1's normal state IS step 2's
degraded state) and creates the strictly-worse window the ticket itself identifies as its
headline risk.

**Verdict:** not safe to build as ordered. Safe with (a) that step merge, (b) an
undelivered-exempt prune rule, (c) a decision on the broker's provider lock and the container
case before any Claude lane crosses that socket. Step 0 (write-only ledger from the existing
blocking path) remains safe to start today under either scope option, provided the prune rule
lands with it. **Independent clean-room verification is warranted** at each of steps 1–3 as the
plan already says, and this review does not substitute for it.

### 2026-09-08 — plan lane, round 2 (revision after the adversarial review above)

- **Understood:** the review's verdict (not safe to build as ordered) is accepted on every substantive point but one, and its "single change that most improves the plan" is accepted as stated. I re-checked its two grounding refutations against the code myself rather than taking them: `dispatch-broker.ts` `validate()` does refuse `provider !== 'openai'`, `runDispatch()` does hardcode `'--provider','openai'` and does spawn host-side at `project.hostPath`, the gate is `toolSettingsOf().openaiDispatch` (`agent-bridge.ts:1005`), and `outcomes.ts:119`/`:138` does prune unconditionally with `slice()`. Both refutations HOLD. Round 1's "same validation table, same caps" was a genuine error of mine and it had reached the migration plan.
- **Changed (ticket only, no code):** invariant restated in enforceable form (single writer + lane-id join key, and the honest admission that "learns by no other route" was neither testable nor true); Design gained the undelivered-exempt prune rule, dispatcher-declared group membership with an explicit close and a close deadline, a lane runner spawning through the project's own isolation routing instead of the OpenAI socket, boot reconciliation of `running` records, an age-bounded auto-drain so starvation is closed by delivery rather than by a badge, cost attribution per lane, and the subagents-route merge; the migration merged the drain into the dispatch step and re-sequenced around a write-only-ledger first step; the proof bar went from 9 items to 15, with must-FAIL legs on the prune and on sequential-group closure; a new section answers the wakes-vs-payload premise.
- **Where I disagree with the review, and why (one point).** Its attack-3 claim that a second answer is "left standing, unmentioned" is right about the omission and slightly wrong about the class: the subagents route and the ledger cover **disjoint populations** (an owned lane writes no `subagents/` transcript; a native lane writes no ledger record), so this is a missing read-side union, not two sources answering one question. The practical consequence is the same and I have specified the merge — but the distinction matters for sequencing, which is why it is step 4 rather than a blocker on step 2, with the alternative (scope the invariant honestly in the same commit) named. I also note the review's provider caveat: it ran same-provider, so the wakes-vs-payload premise it flagged has still not had a decorrelated attacker. My paragraph on it is an argument from the orchestrator's cost figures, not an independent check of them.
- **Verified:** nothing executed beyond re-reading the four files above and `npm run board:check` (DRIFT — 5 problems, all pre-existing: BUG-169, FEAT-129, FEAT-131, FEAT-132 unmappable status words, ARCH-007 unreachable; none is this ticket). This ticket remains design only; the proof bar is written to be run by the engineer, and nothing here claims a passing test.
- **Still open / handoff:** step 1 (write-only ledger, with the prune rule, from the existing blocking dispatch path) is safe to start today under either scope option. Step 2 must not be split — that split is exactly what the review broke. The scope fork (A vs B) still needs the user. An independent clean-room verify is warranted at steps 2, 3 and 4, and a decorrelated (cross-provider) attacker should be pointed first at the wakes-vs-payload premise, which two same-provider rounds have now both accepted.

### 2026-09-08 — build lane, step 1 (the write-only lane ledger)

- **Understood:** built **step 1 only** — `src/server/lanes.ts` plus the ledger writes from the
  EXISTING blocking `op:'dispatch'` path, with the undelivered-exempt prune rule and boot
  reconciliation. Explicitly NOT built: `op:'start'`, the drain, `#railPending`, group settle, the
  `subagents.ts` read-side union. Step 1 stood alone: nothing in it required step 2, and the
  ledger is identical under scope option A or B.
- **Hypothesis (step 1 is additive; nothing that works today can regress) — SURVIVES, with one
  design question the ticket did not answer and one grounding fact that was wrong.**
  - *The question:* is a record written from the BLOCKING path delivered or held? Decided
    **delivered** (`deliveredBy:'blocking-dispatch'`, a new member of the ticket's enum): the
    blocking dispatch returns its result text to the caller's `tool_result`, i.e. it really does
    enter the parent's context, and the stamp is written only AFTER the terminal frame goes to a
    LIVE peer. This matters: had step-1 records been born undelivered, the undelivered-exempt rule
    would fill the store and then apply backpressure to the OpenAI escape hatch — step 1 would have
    changed existing behaviour, which the plan says it must not. A peer that dies before the frame
    leaves the record HELD, which exercises the exempt rule for real rather than as dead code.
  - *The wrong fact:* the Design says per-lane `usage` needs nothing new because "`dispatch.mjs
    --meta-out` already emits the machine-readable channel". It did not emit usage at all
    (`writeMeta` carried provider/model/sessionId/exitCode/failureKind/resumed/ts/dispatch). Added
    `usage` (verbatim from the engine's result frame, `null` when the engine reported none), which
    is step 1's own acceptance criterion ("assert one settled record with pointer, usage and
    declared group fields"), not step-2 work.
  - *Behaviour proof, not assertion:* every ledger call in the broker is best-effort and wrapped;
    with the ledger deliberately FULL, a real dispatch still succeeds and the store is not
    force-written (test "a refused ledger write never refuses the dispatch"). The broker's frames,
    caps, argv and failure taxonomy are untouched.
- **Changed:** `src/server/lanes.ts` (new), `src/server/dispatch-broker.ts` (record at dispatch,
  attach pid+argv token after spawn, settle after the terminal frame), `src/server/index.ts`
  (boot reconciliation, logging only), `scripts/dispatch.mjs` (`usage` into `--meta-out`),
  `scripts/verify-lane-ledger.mjs` + `scripts/fixtures/fake-dispatch-lane.mjs` (new),
  `package.json` (`verify:lane-ledger`). No client code, no route, no reader — nothing reads the
  ledger, exactly as step 1 specifies.
- **Deltas from the ticket, stated so the next reader does not think they are drift:**
  1. `deliveredBy` gains `'blocking-dispatch'` (above).
  2. Boot reconciliation of an ALIVE orphan: the ticket says "still alive → re-adopt". On this
     transport re-adoption is impossible — the socket that would have carried the result died with
     the server — so it is `cut` with `failureKind:'server-restart-orphan-alive'` and a detail
     NAMING the still-running pid. Real re-adoption arrives in step 3 with the survival spawn.
     A record whose writing server is still alive is left running (two servers, one data dir).
  3. New rule the ticket does not have: **a corrupt ledger is not an empty ledger.** `outcomes.ts`
     returns `[]` for an unreadable file; here that would let the next write overwrite every held
     result with `[]`. `readAll()` throws (preserving the bytes as `.corrupt-<ts>`).
  4. `MAX_RECORDS = 60`, not `outcomes.ts`'s 200 — a lane record carries a result excerpt and owns
     a result file, so it is heavy where a death record is light.
- **Verified — the exact commands and their real output.**
  - `node scripts/verify-lane-ledger.mjs --must-fail-proof` → exit 0, two legs:
    - leg 1 drives the **HEAD (pre-change) broker**, fetched with `git show
      HEAD:src/server/dispatch-broker.ts`, over the same real dispatch: `dispatch ok=true;
      lanes.json exists=false` — today's path leaves no record of the completion at all, so the
      main suite is not vacuous.
    - leg 2: `held ids ["lane-0","lane-1","lane-2"]`; deleted by the `outcomes.ts`-style
      unconditional `slice()` the round-1 plan specified: **all three**; deleted by
      `lanes.prune()`: **none**.
  - `node scripts/verify-lane-ledger.mjs` → **RESULT 24 PASS / 0 FAIL** (exit 0). Every check
    asserts its precondition and prints the observed VALUE. Selected real output:
    - one real socket dispatch → one `settled` record; `resultPointer`
      `…/lanes/lane-…/result.txt` whose bytes are IDENTICAL to the terminal frame the caller got
      (the pointer is the authority, the excerpt is not); declared group
      `{groupId:<lane id>, groupSize:1, groupClosed:true}`; declaration
      `{ticket:'ARCH-017',phase:'fixing',round:'1',laneClass:'fix',model:'gpt-5'}`; usage
      `{input_tokens:1234,output_tokens:567,cache_read_input_tokens:89}` carried verbatim.
    - **join key, not judgement:** the lane id is a literal token in the REAL child's argv (the
      `--meta-out` path), asserted against the argv the child itself echoed back —
      `lane id present in the child's own reported argv: true`.
    - peer destroyed before the result → `{state:'settled', deliveredAt:null, held:true}` and the
      result file still on disk, pullable.
    - two concurrent dispatches → two records, no lost update.
    - prune over a busy store (73 records, bound 60): `held survivors 10/10`, `delivered survivors
      47/60`; dropped records' result FILES are removed (11/11) while a held lane's file is intact.
    - backpressure: `admit() → {ok:false, held:62, bound:60, reason:"…undelivered results are never
      deleted to make room."}`, `recordDispatch → store-full`, `records still on disk: 62`.
    - truncated reads of the REAL store at 1B/25%/50%/90%/len-1: **all five threw `corrupt`**
      (never "0 records"), the real bytes restored intact, and a write attempted on a corrupt store
      threw without replacing it (`bytes still on disk: 1982`).
    - **real server restart:** a separate node process booted the broker, started a hanging lane and
      was SIGKILLed; the claim left behind was `{pid:3313839, serverPid:3313832}` with the orphan
      confirmed alive, and `reconcileBoot()` returned `{checked:1, cut:1, leftRunning:0}` with
      `state:'cut'`, `failureKind:'server-restart-orphan-alive'` and a detail naming pid 3313839.
      No already-settled sibling was touched. Also covered: dead-server + proven-dead child →
      `server-restart`; a live process whose argv lacks the token → `pid-reused` (pid reuse cannot
      be mistaken for our child); a claim owned by this live process → left running.
    - `scripts/dispatch.mjs` run for real against a shimmed `claude` on PATH → `meta.usage
      {input_tokens:11, output_tokens:22}`.
  - **Anti-regressions run:** `verify-dispatch.mjs` 24/24, `verify-feat-100-declared-dispatch.mjs`
    31/31, `verify-feat-102-dispatch-broker.mjs` 25/25, `verify-feat-102-static.mjs` 10/10 — all
    exit 0. `verify-agent-outcomes.mjs` fails 7 checks (32/39) — **pre-existing**: the identical
    7 failures reproduce at HEAD in a clean `git archive HEAD` export, so it is not this change.
    `npm run gate` → **PASS, exit 0** (leak-gate + check-nul + typecheck).
- **What I could NOT test (a work queue for the verifier, not a disclaimer):**
  - **Cross-PROCESS writes are not serialised.** All ledger mutations are synchronous
    read-modify-write, so two callers inside ONE server cannot lose an update (tested). TWO servers
    sharing a data dir can. Not handled and not tested; step 2 adds writers and should decide
    whether a lock is needed.
  - **No live provider run.** Usage/settle were proven with a fixture child and a shimmed `claude`,
    not a real OpenAI/Anthropic turn (no quota in this lane). The shapes are the real ones the
    scripts write, but a live cross-provider dispatch has not been observed end to end.
  - **Container-isolated projects untested.** The broker's spawn path is unchanged by this step, so
    nothing new crosses it, but I did not run a containerised dispatch.
  - **No performance measurement** of the ledger write against a near-bound store.
  - **The `resultExcerpt`/charter excerpts are not redacted** — they land under `dataDir()` (host
    only, same place transcripts already live), never in the repo. Not a leak-gate finding.
- **Still open / handoff:** the scope fork (A vs B) still needs the user; step 1 is neutral to it.
  Step 2 must not be split. **High-stakes:** this is a data-loss surface (a held result) plus boot
  reconciliation on a session-lifecycle path — an independent clean-room verify pass is warranted
  even though step 1 is write-only, and the cross-process write race above is the first thing to
  aim it at.
- **Symptom of a deeper design flaw?** No new one. It confirms the ticket's own: the fact was
  cheap to record once someone owned it, and the only reason it was hard was that no writer existed.

### 2026-09-08 — build lane, step 1 round 2 (fixes for the independent verify)

- **Understood:** an independent verifier attacked the round-1 ledger and broke 5 properties with
  working reproducers (`docs/bugs/_scratch-lane-ledger-verify.md`, `scripts/scratch-a17-*.mjs`).
  I re-ran every reproducer myself BEFORE changing anything and **all five reproduced**; none is
  refuted. My own 24-test suite was green throughout, which is the point: it was single-process
  and could not reach any of this. Verdict accepted in full.
- **Fixed, worst first — each with the reproducer's own before/after number.**
  1. **Cross-process lost updates (silent result loss).** `writeAtomic` makes each WRITE atomic;
     nothing made the read→modify→WRITE sequence atomic, and `reconcileBoot()` exists precisely
     because two servers can share a data dir. Added `withLock()` — an O_EXCL lock file with
     dead-holder and staleness breaking — around every mutation. A write that cannot take the lock
     THROWS `lock-timeout`; it never proceeds unserialised. `scratch-a17-attack1.mjs`:
     **50 claimed / 25 on disk / 25 lost → 50 claimed / 50 on disk / 0 lost.**
     `scratch-a17-attack1b.mjs`: **12 settled results on disk with no record → 0**, "settle saw
     record gone" **11 → 0**. `scratch-a17-attack37.mjs` orphan lane dirs **73 → 0**.
  2. **`settle()` failed silently.** It wrote the result file first and RETURNED NULL when the
     record had vanished, so the broker's `try/catch` never fired. Now it checks the record FIRST
     (no orphan file is created) and THROWS `record-missing`; the broker logs at ERROR level and
     quarantines the text to `lanes/_unrecorded/<lane>.txt` so a lost record can never mean a lost
     result.
  3. **The delivery stamp lied — and the obvious fix was not enough, which is the finding.**
     Round 1 read `!socket.destroyed` BEFORE the send: **2 of 45** records stamped delivered whose
     peer provably never got the text. I first tried transport-level confirmation (flush callback +
     clean close): the same sweep still produced **1 of 45**, because on an AF_UNIX socket a frame
     sitting in a dead peer's receive buffer is indistinguishable from one it read. No transport
     signal can answer this, so the peer is now ASKED: the request carries `ack:true`, the client
     writes the result to its own stdout **synchronously** (`fs.writeSync`, which `process.exit`
     cannot truncate) and only then sends `{"op":"ack"}`; the ledger stamps `deliveredAt` on that
     receipt and on nothing else. Every other outcome — no ack, error, close, timeout, a peer that
     never opted in — leaves the record HELD. Result: **0 of 45**, then **0 of 24** in the suite's
     permanent sweep with both controls firing. Cost, stated plainly: a peer that does not opt in
     (any non-Orchard client) now yields a HELD record rather than a delivered one. That is the
     honest direction to be wrong in — a held result that was delivered costs a duplicate; the
     converse loses it.
  4. **A recycled `serverPid` pinned a claim forever** (`running` is `isHeld`, so it was
     prune-exempt and ate an admit slot permanently). The owner now gets the same identity proof
     the child already had: pid + its own `/proc` start time + the machine's boot id, and a
     non-positive pid is never "alive" (`kill(0,·)`/`kill(-1,·)` signal process GROUPS).
     `scratch-a17-attack2.mjs` 4a: **`leftRunning:1`, state `running` → `cut:1`**, detail naming
     the recycle; 4b: `serverPid` 0 and -1 **`running` → `cut`**.
  5. **Corrupt store copied itself unboundedly** — one full `.corrupt-*` copy per READ, and
     `admit()` runs per dispatch (~200 KB of junk per dispatch at real size). Preserved ONCE now:
     **40 reads → 40 copies became 40 reads → 1 copy.** Deliberately still no self-heal, and the
     error now says why and how to recover: healing means discarding the file, and the file is
     where undelivered results live — that is a human's call, never this code's.
  6. **Malformed records threw raw `TypeError`s** past the "loud and non-destructive" contract.
     `readAll()` now validates record SHAPE, not just JSON syntax: `list`/`admit`/`reconcileBoot`
     all raise `LaneStoreError/corrupt`.
- **Refuted: nothing.** Every finding held on re-run. The verifier's two "weaker than their name"
  criticisms of my own greens are also accepted and both tests are now real: the concurrency test
  has a genuine two-PROCESS version (R1), and the live-owner test has a recycled-pid counterpart
  (R5).
- **Changed:** `src/server/lanes.ts` (lock, shape validation, once-only preservation, loud settle,
  owner identity), `src/server/dispatch-broker.ts` (ack-based delivery verdict, `ack` request
  field, quarantine-on-failure), `src/server/dispatch-client.mjs` (sync stdout write, then the
  receipt), `scripts/verify-lane-ledger.mjs` + `scripts/fixtures/fake-dispatch-lane.mjs`.
- **Verified — the commands and their real output.**
  - `node scripts/verify-lane-ledger.mjs` → **RESULT 34 PASS / 0 FAIL** (exit 0), up from 24.
    The ten new checks are R1 (two-process concurrency: `claimed/on disk [50,50]`, missing 0),
    R2 (`settle` throws `record-missing`, `orphan result dir created: false`), R3 (`40 reads → 1
    copy`), R4 (`list/admit/reconcileBoot: LaneStoreError/corrupt`), R5 (recycled owner → `cut`),
    R6 (`serverPid` 0/-1 → `cut`, `sameProcess → [false,false]`), R7 (no-ack peer → `{state:
    settled, deliveredAt: null, held: true}` with the dispatch still `ok:true`), R8 (kill swept
    from t−40 ms to t+6 ms around the calibrated 303 ms landing instant: **24 trials, 5 delivered,
    19 correctly held, 0 false stamps**), R9 (dead holder's lock broken; a LIVE holder makes the
    write throw `lock-timeout` after 5005 ms rather than proceed), R10 (**the real
    `src/server/dispatch-client.mjs`**, not a double — prints the result and its receipt marks the
    lane delivered).
  - `node scripts/verify-lane-ledger.mjs --must-fail-proof` → exit 0, now THREE legs. Leg 3 is new
    and is the must-FAIL for the delivery fix: on a real socket whose peer was just SIGKILLed, the
    round-1 signal read in the same tick says `DELIVERABLE — would stamp` while the round-2 receipt
    says held.
  - **Anti-regressions:** `verify-feat-102-dispatch-broker.mjs` 25/25 (it covers the wire protocol
    I extended), `verify-feat-102-static.mjs` 10/10, `verify-feat-102-entitlement.mjs` pass,
    `verify-dispatch.mjs` 24/24, `verify-feat-100-declared-dispatch.mjs` 31/31 — all exit 0.
    `npm run gate` → **PASS, exit 0**.
- **Still untestable, and why (the queue the verifier left, with what I closed).** Closed: the real
  dispatch client is now exercised end to end (R10). Still open: **a real provider dispatch**
  (every lane here is a fixture child; no quota); **the live server and real data dir** (all runs
  use scratch `CLAUDE_STATION_DATA` and free unix sockets — port 4317 and the systemd unit were
  never touched, so "two servers on one data dir" is proven UNSAFE-before/SAFE-after but its real
  frequency in this deployment is unmeasured); **non-local filesystems** (NFS/overlay, where
  `rename` atomicity, O_EXCL and `kill(pid,0)` semantics differ — the lock assumes a local fs);
  **real ENOSPC/EIO mid-write**; **any consumer**, since step 1 is still write-only. New and mine:
  the ack is proof the CLIENT PROCESS received the text, not that the harness turned it into a
  tool_result — the last hop is unobservable from the broker, and closing it belongs to step 2's
  runner, which owns both ends.
- **Still open / handoff:** unchanged — the A/B scope fork needs the user, step 2 must not be
  split. **A second independent clean-room pass is warranted on this round**, aimed at the lock
  (stale-break window, non-local fs) and at the ack protocol, since round 1's lesson is exactly
  that this lane's self-verification could not see its own blind spot.
- **Symptom of a deeper design flaw?** One worth naming: both the round-1 defects and their first
  fix came from trusting a LOCAL signal for a REMOTE fact — `sync fs` for cross-process ordering,
  `socket.destroyed` for what a peer read, `kill(pid,0)` for process identity. Each needed evidence
  from the other side (a lock, an ack, a start time). That is the same class as this ticket's own
  invariant, one level down.

### 2026-09-09 — plan lane, step 2 lane-runner (finding, class plan+review, ARCH-017+FEAT-140)

Decision recorded (NOT re-opened): the user greenlit the build and chose **option A** — Orchard
owns *background* lanes; short foreground helpers (Explore, quick reads, worktree-isolated) stay
native. This plan is for A. **A is workable** — nothing in the isolation routing, the survival
scope, or the boundary hook blocks it, and every mechanism A needs already exists in some form
(checked, see below). No stop condition hit. This entry is the implementation PLAN for the
lane-runner (step 2's single largest item); it builds nothing — only this log was appended.

**Scope note:** the group-settle *barrier* (`maybeSettleGroup`/`drainLanes`/`rearmGroups`/timeout)
is FEAT-140's deliverable and is planned in that ticket. This plan owns the *primitive it rides
on* — the non-blocking, multi-member, isolation-routed Claude dispatch — plus points 3/4/5 (group
declaration, caps, boot re-arm of groups) and the exact seam FEAT-140 calls (point 6).

#### 1. The invariant (one testable sentence)
A `lane-runner` `op:'start'` returns a lane id and ends the caller's turn WITHOUT blocking the
parent model, having recorded exactly one `running` ledger record whose `parentSessionId`,
`groupId` and `groupSize` were **declared in the request** (never derived), whose child runs
under the *same isolation the project's own AgentSession would have used*, and whose eventual
settle is written by this server and — after any restart — reconciled from the ledger alone.

Enforceable form: for every `op:'start'`, (a) the caller's turn boundary closes before the child
exits (no foreground block — proof item A1 asserts the parent is idle/interjectable while the
child runs), and (b) exactly one record exists with the declared `parentSessionId`/`groupId`/
`groupSize`, its `argvToken` present in the child's real `/proc/<pid>/cmdline`, and its child
process's cgroup/exec-target matching the project's isolation (direct→host cgroup or survival
scope; container→inside the container).

#### 2. Isolation-routing spawn — the load-bearing item, and the one real tension with the charter
- **New `src/server/lane-runner.ts`**, modelled on `dispatch-broker.ts` (per-project unix socket,
  `validate()` table, its own caps, the FEAT-100 `Dispatch:` declaration) but with its OWN name,
  its OWN tool-settings switch (`settings.tools.laneRunner`, NOT `openaiDispatch`), and its OWN
  spawn path. **`dispatch-broker.ts` is untouched.** This closes F1: no Claude lane crosses the
  OpenAI socket, which is provider-locked, off by a differently-named switch, and — decisively —
  spawns host-side at `cwd: project.hostPath`, a container escape for an agentic lane.
- **The tension (state it bluntly, per charter):** the ticket says the runner spawns "through the
  project's own isolation routing, the same one `AgentSession` uses (`agent-bridge.ts:1214-1311`)".
  That routing is **not a reusable function** — it is a `spawnProcess` override consumed by the
  Agent SDK's `query()` *inside a full AgentSession*, built out of two primitives:
  `execInContainer(project, …)` (agent-bridge :1262) for `container`, and `spawnSurvivable(…)`
  (:1311) for `direct`+survival. And `scripts/dispatch.mjs --provider anthropic` runs `claude -p
  --output-format json` **on the host cwd, confined only by Claude's permission mode, NOT by
  container isolation** (dispatch.mjs header lines 51-55, 88-93 — verified). So a lane-runner that
  merely shells `dispatch.mjs` gives a container project a **host-side** child = the same F1
  escape, one socket over. The runner CANNOT literally reuse AgentSession's routing and MUST NOT
  reuse dispatch.mjs's host spawn for a container project.
- **Resolution (the riskiest design decision — see handoff):** extract a standalone
  `spawnInIsolation(project, {command,args,env,cwd}) → ChildProcess` from the AgentSession branch,
  sharing `execInContainer`/`spawnSurvivable`/`containerWorkdir`/`CONTAINER_CLAUDE_BIN` with it so
  there is ONE isolation authority (ARCH-010), and have the runner compose the child argv:
  - `direct`: `node scripts/dispatch.mjs --provider anthropic …` under the survival scope when
    `survivalEnabled()` (so the lane survives a server restart — closes loss 7's process half
    early for direct projects), else a plain child.
  - `container`: exec **inside the container** via `execInContainer`, running the container's
    `CONTAINER_CLAUDE_BIN` `-p --output-format json` directly (dispatch.mjs is a host script; the
    repo is bind-mounted, but running the container binary directly avoids a host-node dependency).
    `--meta-out` must land on a path readable from the host (a bind-mounted lane dir) — a real
    step-2 subtlety, called out here so it is not discovered late.
  - `worktree` isolation: **not built** (loss 3). Under option A worktree-isolated work stays a
    native foreground lane, so the runner never receives it. The boundary hook (point 6) denies
    only `run_in_background:true`; a foreground worktree Agent call is untouched.
- Ack-based delivery (round-3 `ack:true` + byte-count receipt) carries over unchanged: the runner
  is a new producer on the same evidence contract.

#### 3. Group declaration at dispatch (ARCH-010)
`op:'start'` request carries `{ parentSessionId, groupId, groupSize }` — or `{ groupId,
groupOpen:true }` + a later explicit `op:'closeGroup'` when N is not known up front. The runner
passes them verbatim to `lanes.recordDispatch({ parentSessionId, groupId, groupSize, groupClosed,
… })`. **Nobody derives membership.** Three hardening rules the store already or newly enforces:
a declared member that never spawns is `settle(id,{state:'failed',failureKind:'never-spawned'})`
immediately (a wrong count must not freeze a group); an open group carries a close deadline
(default 30 min from last member) after which `closeGroup` self-fires; a lane arriving for a
CLOSED group starts a NEW group (a reader must never reopen — that is how a drain races a
dispatch). "A group is settled" = `groupClosed===true` AND every declared member terminal — this
predicate lives in FEAT-140's `groupTerminal(groupId)`, computed from the ledger only.

#### 4. Concurrency caps (decided here, not deferred — loss 6)
The runner gets its OWN counters, NOT the broker's `PROJECT_CAP=2/GLOBAL_CAP=6` (those exist for
two read-only Codex reviews and would starve a 5-8 lane fan-out, or be starved by it). Proposed:
`LANE_PROJECT_CAP=6`, `LANE_GLOBAL_CAP=10`, both project-overridable, justified against machine
load (each lane is a full `claude` process). **Overflow is backpressure, never silent queueing or
deletion:** at cap, `op:'start'` returns `{ok:false, kind:'lane-concurrency-cap', cap, running}`;
the caller (orchestrator) sees the refusal in its `tool_result` and can retry or dispatch fewer.
This composes with the ledger's *retention* backpressure (`capacity()`): admission is refused for
running-count OR held-undelivered-over-bound, each with its own honest reason. A refused member of
a declared group is `failed('cap-refused')` so the group can still settle.

#### 5. Boot reconciliation — re-arm GROUPS, from the ledger alone
`lanes.reconcileBoot()` (index.ts:4268) already resolves individual `running` records against pid+
argv-token ground truth. Step 2 adds, **immediately after it**, FEAT-140's `rearmGroups()` (call
site is this plan's; the function is FEAT-140's): for every group with ≥1 undelivered member, read
the ledger and — if now complete → `drainLanes()` once; if still-running members remain → re-arm
its timeout from `dispatchedAt`. Because the barrier holds NO state the ledger does not, re-arm is
a pure function of the ledger and cannot disagree with it (the ARCH-010 payoff). The runner itself
holds only ephemeral in-memory cap counters, rebuilt at boot by counting ledger `running` records
for live children — never a second source of truth for membership or completion.

#### 6. The seam to FEAT-140 (so the barrier is a small build on top)
FEAT-140 observes/calls exactly four ledger-level things the runner produces:
- **produces** one `running` record per member with declared `parentSessionId/groupId/groupSize`
  (point 3), then `lanes.settle(id, {state,resultText,usage})` as each child exits;
- **the runner calls `maybeSettleGroup(groupId)` (FEAT-140) synchronously after every `settle`** —
  this is the single wire between the two tickets; the runner imports and calls it, nothing else;
- **`drainLanes(parentSessionId, memberIds, 'group-settle')` (FEAT-140)** delivers via the parent
  session's `send()` — the BUG-159 hold+push seam: `agent-bridge send()` (:1571) → `ClaudeRuntime.
  send()` (claude-runtime.ts:953, `#holding`→`#heldSends` else `#input.push`), idle→now, busy→next
  boundary, never refused; survivor branch is `deliverIntoSurvivor()` (survivor-delivery.ts:244).
  The runner does NOT implement delivery — it only exposes `parentSessionId` on the record and the
  post-settle hook call.
- **`rearmGroups()` call site** (point 5). Everything else (composition, timeout registry, the
  exactly-once stamp) is FEAT-140's. This keeps FEAT-140 a small module over a stable primitive.

#### 7. Landable steps (each ships alone, leaves the system working; rough size)
1. **Extract `spawnInIsolation()` from the AgentSession routing** (refactor only, no behaviour
   change; AgentSession keeps working through it). Proves: one isolation authority, a container
   child still runs in-container. ~M.
2. **`lane-runner.ts` socket + `op:'start'`/`op:'closeGroup'` + its own caps, spawning via
   `spawnInIsolation`; writes declared records; settles on child exit.** No delivery yet (records
   born HELD). Proves: non-blocking dispatch, isolation routed, group declared, cap backpressure,
   `argvToken` in real cmdline. ~L. (This is the bulk.)
3. **The boundary hook** — `PreToolUse` deny on `Agent` with `run_in_background===true` on the
   existing in-process callback (claude-runtime.ts:751+, beside the git-write block and the Fable
   gate), reading `i.run_in_background` (already surfaced to the hook layer, orchestrator-surface-
   log.mjs), message names the runner, **fails OPEN if the field is absent**. Proves: the option-A
   boundary is a mechanism not honour-system (BUG-174-adjacent care: a deny message must read as a
   route, never as a user rejection). ~S. Ships with independent-verify per WA §N.
4. **Wire FEAT-140** — `maybeSettleGroup` after settle + `rearmGroups()` after `reconcileBoot`;
   the `#railPending` surface and WA change land with/after FEAT-140. Proves: one wake per group.
   ~S from the runner side (the barrier body is FEAT-140's).
Steps 1-3 are the lane-runner; step 4 is the join with FEAT-140. Rollback of the whole: disable
the runner switch → the deny hook falls back to native lanes (today's behaviour exactly), the rail
section is capability-gated and hides itself.

#### 8. Proof bar (what must be observed; what falsifies)
- **A1 non-blocking (must-FAIL first):** the same assertion against today's foreground `Agent`
  fan-out must FAIL (the parent model IS blocked). With the runner: dispatch N via `op:'start'`,
  assert the parent turn boundary closes and a user `send()` delivers WHILE children run.
- **A2 isolation (proof item 12):** container project → child pid runs inside the container
  (`execInContainer` target), zero host-side execution, and no Claude request accepted on the
  OpenAI socket. Falsifier: a host-cwd child for a container project.
- **A3 group declaration (proof item 6):** N members dispatched SEQUENTIALLY in one declared group
  → the ledger shows `groupSize=N` on each from birth; a never-spawned member is `failed`
  immediately; an open group's deadline self-closes. (The "exactly one drain" half is FEAT-140's.)
- **A4 caps:** at cap, `op:'start'` refuses with an honest kind; a refused group member is
  `failed('cap-refused')` and does not freeze its group.
- **A5 boot re-arm (proof item 8):** kill the server with a group half-settled, restart →
  `reconcileBoot` + `rearmGroups` resolve every `running` claim and no already-settled sibling is
  stranded.
- **A6 truncated reads (proof item 11):** runner writes the ledger while the API reads it; grade
  reads truncated at several points against the REAL record.
- **BUG-159 anti-regression (MANDATORY):** run BUG-159's suite; the parent must read **idle /
  interjectable** while lanes are merely running/HELD (no phantom-busy behind a quiet lane), and a
  mid-batch user `send()` must hold+push, never be refused. Record `regressed-from: BUG-159` if
  anything there moves.
- **BUG-174 anti-regression:** the boundary-hook deny and any lane-cut notice must be phrased as
  *interrupted/route-through-the-runner*, never "you rejected"/"you cancelled" — a stopped or
  denied lane is reported as interrupted (global CLAUDE.md; BUG-174). Assert the deny message
  contains the runner route and contains no rejection wording.
- **Falsifiers:** a fan-out that still blocks the parent model; a container lane running host-side;
  a group whose membership was derived rather than declared; a cap set so low the real fan-out no
  longer fits; a restart that strands a settled sibling.

#### 9. Failure modes DESIGNED for (not just listed)
- **A lane that never settles:** the timeout consults `liveWithToken(pid, argvToken)` (lanes.ts:696)
  — proven-dead → `cut` (group can settle); **proven-alive → extend once, never cut a live child**
  (the exact discipline FEAT-140 failure (a) specifies). A slow-but-live lane is never guillotined
  by a clock alone.
- **User interjects mid-batch:** the hold lives in the LEDGER, not in a turn's control flow, so an
  interjection turn cannot consume/cancel it. The group's `send()` late-delivers at the next
  boundary (BUG-159 hold+push) — exactly once, after the interjection. Never dropped.
- **Restart mid-group:** point 5 — `reconcileBoot` + `rearmGroups` from the ledger; an alive orphan
  on the *direct+survival* transport is re-adopted (survival scope outlives the server), a
  non-survivable orphan is `cut` with a pid-naming reason; either way the group settles and no
  sibling is held forever.

**High-stakes (WA §N):** session-lifecycle + concurrent state + data-loss (held result) + an
isolation boundary + the `PreToolUse` hook. Each of steps 1-4 warrants an independent clean-room
verify (`scripts/independent-verify.mjs`); step 2/3 touch isolation and the boundary hook, step 4
touches the BUG-159 `send()`/InputQueue path — generation is not its own only verifier.

- **Changed:** this ticket only (Activity log append). No source. INDEX regenerated via `board:gen`.
- **Verified:** read `lanes.ts`, `dispatch-broker.ts`, `survivor-delivery.ts`, `agent-bridge.ts`
  isolation routing (:1214-1324), `claude-runtime.ts` hook chain (:751+) and send/InputQueue
  (:100-124, :953), `index.ts` boot (:4268), `scripts/dispatch.mjs` header, README + CONVENTIONS
  in full, and FEAT-140 in full. No code executed — this is design only.
- **Still open / handoff:** the riskiest decision is step 1 — whether to EXTRACT
  `spawnInIsolation()` (recommended; keeps one isolation authority and defers the clientless-launch
  cost of loss 2 to step 3) or to make step-2 children real AgentSessions immediately (collapses
  step 3 up, pays loss 2 now). I chose extraction. The A/B *scope* fork is already answered (A).
  FEAT-140 is buildable now against the ledger with synthesized records; it wires to this runner at
  step 4's single call site.
- **Symptom of a deeper design flaw?** No new one — same class as the parent (ARCH-010 on lane
  lifetime). It surfaces one concrete instance: "the project's isolation" had no single owner
  callable outside AgentSession, which is exactly why step 1 extracts it.

### 2026-09-09 — cross-provider adversarial review of the step-2 lane-runner plan (plan+review)

Reviewer did NOT write the plan and changed no code — only this log was appended. **Provider:
OpenAI (Codex), genuinely cross-provider** (dispatched via `src/server/dispatch-client.mjs
--provider openai`, read-only sandbox), so its blind spots are decorrelated from the Claude plan
lane. It re-derived every pivotal claim against the repo rather than trusting the plan's quotes,
and ran one executed predicate check. Transcript under the station transcripts dir:
`…/transcripts/openai/<project>/01a08673-410e-78b0-ac80-f0bbe9c254cc.jsonl`.
This dispatch lane independently confirmed the two most load-bearing findings (axis 2b and axis 4)
against ground truth before relaying — noted inline.

**Verdict: NOT SAFE TO BUILD.** Four of six attack axes BREAK, one is NAMED-ONLY, one CLOSED.

**AXIS 1 — Isolation — NAMED-ONLY.** Container routing correction is sound (`execInContainer`
runs inside, no host fallback; `agent-bridge.ts:1280`), and a direct-mode lane lacking a filesystem
jail is not a *new* regression (AgentSession already runs direct on the host). BUT sharing process
*placement* does not share execution *policy*: standalone `dispatch.mjs` does not inherit
AgentSession's permission callbacks/runtime hooks — it picks `plan`/`acceptEdits` itself
(`claude-runtime.ts:589`, `dispatch.mjs:313`). And the container output contract is missing:
`--meta-out` is implemented by `dispatch.mjs` (`:253`), which the container branch bypasses, and its
metadata does not carry result text; a writable bind of the authoritative lane dir lets a
workspace-write lane replace a result with a symlink to a host-only file that an ordinary host read
follows. Keep authoritative storage server-owned; define a separate untrusted output channel.

**AXIS 2 — Boundary hook — BREAK (the top finding).** Two bypasses. (a) The plan reads
`i.run_in_background`, but the hook input `i` is `{ tool_name, tool_input, agent_id }` — the flag is
at `i.tool_input.run_in_background` (`claude-runtime.ts:759`); the plan-text path reads `undefined`.
(b) DECISIVE and confirmed by this lane against the installed SDK: `sdk-tools.d.ts:502` documents
"Agents run in the background by default … Set to false to run this agent synchronously." So a strict
`run_in_background === true` check that fails OPEN when absent lets through the **most common** case —
the flag omitted, which IS background — and any denied call is trivially retried by dropping the flag.
The option-A boundary as specified does not enforce option A at all. `isolation:"remote"` is also
always-background (`:518`). Also: the callback is conditionally installed and the Fable rewrite
returns early with `allow` (`:751`, `:798`) — ordering must be checked. On UX: BUG-174's probes were
about `canUseTool`/interruption, NOT an ordinary `PreToolUse` deny — so the model-visible text of
this deny is UNVERIFIED, not known-safe; naming a runner supplies no guaranteed reroute. **My
judgement: real and severe — the single most important objection. The fix is "classify effective
execution mode (default = background)", not "check `=== true`".**

**AXIS 3 — Barrier seam / membership — BREAK.** `recordDispatch()` creates only individual rows,
defaults `groupClosed` true, and does not validate against existing group members (`lanes.ts:511`).
Declare size 3, submit one start, lose the parent before the other two: the missing members have NO
rows, so `never-spawned` has nothing to settle — counting terminal rows closes prematurely, requiring
3 waits forever. Contradiction: if a fixed-size group is closed to declarations at birth, "a lane
arriving for a CLOSED group starts a NEW group" splits later intended members into a different group
and rewrites their declared groupId (violating verbatim attribution). Repeated settle of ONE id is
already safe (first wins, `:610`), but a retry allocating a NEW id after a cap-refusal double-counts.
Open-group deadlines, empty-group representation, closure timestamps and extension state are absent
from the schema. Missing pieces: durable member identity + an idempotent delivery protocol.

**AXIS 4 — Boot reconciliation — BREAK (confirmed by this lane).** The plan's step-5 claim that "an
alive orphan on direct+survival is re-adopted" contradicts the CURRENT code: `reconcileBoot`
(`lanes.ts:779`) marks EVERY non-owned `running` record `cut` — including one whose child is proven
`status==='alive'` (`failureKind:'server-restart-orphan-alive'`, verified `lanes.ts:781`). It does
not re-adopt; `rearmGroups` afterward cannot restore ownership and `settle()` ignores an already-cut
row. So re-adoption is unimplemented and the plan does not flag that lanes.ts must change. Further:
dispatch writes `pid:null, argvToken:null` first, attaching them in a separate write (`:550`,`:565`),
so a crash before spawn vs after-spawn-before-attach are indistinguishable in the ledger. The
`ChildProcess` abstraction hides identity: survival returns a synthetic pid-less process
(`survival.ts:450`), container returns the host Docker client whose death does not prove the inner
process died (`container-manager.ts:1274`). Token check is substring match with a 6-char
`Math.random()` id (`:501`,`:714`) — not collision-proof.

**AXIS 5 — Phantom-busy (BUG-159) — CLOSED for the proposed separation.** Running snapshots consume
liveness; their rows do not feed back into parent `busy` (`running-set.ts:205`), so adding ledger
rows alone does not create phantom-busy. Caveat: "never refused" needs qualifying — a closed or
budget-stopped parent already throws (`agent-bridge.ts:1572`).

**AXIS 6 — Landable steps — BREAK.** Step 2 shipped alone permits successful background dispatch with
results born HELD and NOTHING to drain them (no barrier until step 4, no rail, hook only at step 3).
An invoked step 2 strands results; an unused step 2 changes nothing. This is exactly the round-1
rejected window (`ARCH-017:103` requires runner + drain + rail + hook TOGETHER). Steps are safe to
split only behind an activation gate that requires the complete path.

**Reviewer's extra findings beyond the six axes:** (6) the invariant "the caller's turn boundary
closes before the child exits" is not a guarantee the design can make — a child that exits
immediately can finish before the parent processes the returned id; define non-blocking dispatch
without that ordering claim. (7) contradictory timeout policy — `dispatch.mjs:348` already kills its
process group on timeout, which conflicts with FEAT-140's "never cut a live child" unless *execution*
deadlines and *barrier-wait* deadlines are explicitly separated.

**Ranked objections to resolve before build:** (1) replace the explicit-`true` boundary rule with
effective-mode classification (default = background), covering omitted flag, remote isolation, hook
install/order, and the actual model-visible denial + a real reroute; (2) specify durable launch and
completion recovery — crash windows, transport-specific identity, output capture independent of the
dying server, transport-aware reconciliation (and fix reconcileBoot to re-adopt proven-alive
orphans); (3) define a durable group state machine — member identity, retry semantics, declaration
closure, missing submissions, persisted deadlines, delivery dedup; (4) make activation atomic across
runner + drain + recovery + user access (a separate FEAT-140 ticket does not license shipping an
incomplete completion path); (5) complete execution-policy + output-boundary contracts (raw CLI
bypasses runtime hooks; a writable output dir must not become trusted host authority); (6) correct
the turn-boundary invariant; (7) separate execution vs barrier-wait deadlines.

**Not run (reviewer's own caveat):** live CLI denial behaviour, container harvesting, restart
adoption, and the BUG-159 regression suite were not executed — source review + one predicate check
only. Those remain the highest-value things for an implementer's independent-verify pass.

**Disposition:** the step-2 lane-runner plan does NOT survive — it needs a rewrite before build,
minimally on axes 2, 3, 4 and 6 (the boundary hook's effective-mode gap is the load-bearing one and
by itself defeats option A). Axis 5 holds; axis 1's narrow container fix holds but its
execution-policy/output-boundary half is open. Per WA §N this is a high-stakes surface (isolation
boundary + PreToolUse hook + data-loss + session-lifecycle); an independent clean-room verify remains
required at build time regardless.

### 2026-09-09 — plan lane, step-2 lane-runner REWRITE (round 2, plan+review, after the cross-provider NOT-SAFE verdict)

This entry REPLACES the step-2 plan from the 2026-09-09 finding above (which the OpenAI/Codex
review rejected). No source changed — only this log was appended. The four BREAK axes (2, 3, 4, 6)
are each re-resolved below with a file+mechanism; axes 1 and 5 are carried forward. Every code
claim was re-derived against the tree this round (`lanes.ts` recordDispatch `:511`, attachProcess
`:565`, settle `:599`, markDelivered `:643`, liveWithToken `:696`, reconcileBoot `:759-790`;
`claude-runtime.ts` PreToolUse hook chain `:751-868` and the `i.tool_input`/`decideFableTier`
shape `:759`,`:799`; `sdk-tools.d.ts:502` background-default + `:518` remote-always-background;
`dispatch.mjs:308-355` permission-mode + process-group kill; `running-set.ts:205`; CONVENTIONS
ARCH-010 `:7-51`), not inherited.

#### 0. The corrected invariant (one testable sentence)
A `lane-runner` `op:'start'` records exactly ONE `running` ledger row whose `parentSessionId`,
`groupId` and `groupSize` were **declared in the request** (never derived) and whose deterministic
`argvToken` is written AT BIRTH, and returns a lane id to the caller without the parent model
blocking on the child; the child runs under the *same isolation the project's own AgentSession
would use*, writes its authoritative result to a **server-owned lane file** (not a live socket),
and its settle + delivery survive a server restart because both are reconciled from the ledger and
that file alone. (Dropped from the prior invariant: the "turn boundary closes before the child
exits" ordering clause — extra-finding 6 is right, a child can exit before the caller processes the
returned id, so non-blocking is defined as "the parent model is not held for the child's duration",
not as an ordering guarantee.)

#### AXIS 2 (top break) — the boundary hook: classify EFFECTIVE mode, default background
Root cause confirmed: the hook input is `{ tool_name, tool_input, agent_id }`, so the flag lives at
`i.tool_input.run_in_background` (the prior text read `i.run_in_background` → always `undefined`),
AND `sdk-tools.d.ts:502` makes background the DEFAULT (flag omitted === background), with
`isolation:"remote"` always-background (`:518`). A `=== true` + fail-open test therefore lets the
common case straight through and is bypassed by dropping the flag. **Resolution — new
`decideAgentBackground({toolName, toolInput})` beside `decideFableTier`, called in the same
`i.tool_name === 'Agent'` block (`claude-runtime.ts:798`), reading `i.tool_input`:**
- effective mode = background UNLESS `tool_input.run_in_background === false`; `isolation:"remote"`
  is background regardless; `isolation:"worktree"` + explicit `run_in_background:false` is the only
  foreground-worktree case and is allowed (option A keeps it native).
- background ⟹ **deny** with a message that reads as a ROUTE ("dispatch background work through
  the Orchard lane-runner …"), never as a user rejection (BUG-174). Ordering: this runs AFTER the
  Fable reroute early-return (`:800-808`) — a rerouted Fable call already returned, so re-check:
  the deny must sit so a background Agent is caught whether or not Fable rewrote its model. Place
  it as its own branch after the Fable block and before `decide()`.
- **fail-open is now only for a genuinely unparseable `tool_input`** (not "flag absent"), because
  absent-flag is a KNOWN background and must deny. This inverts the prior dangerous default.
- Gated on the runner being active (settings switch), so with the runner off the hook is not
  installed and native background lanes behave exactly as today (rollback = the switch).
Proof: an Agent call with the flag omitted is denied; `run_in_background:false` is allowed;
`isolation:"remote"` denied; a malformed `tool_input` allows; the deny text contains the runner
route and NO rejection wording (BUG-174 assertion). Independent-verify required (highest-stakes
hook).

#### AXIS 3 — durable group state machine: rows for every declared member at birth
Root cause confirmed: `recordDispatch()` (`lanes.ts:511`) writes only the ONE submitted row and
defaults `groupClosed:true`/`groupSize:1`; the schema has `groupId/groupSize/groupClosed` but NO
open-group flag, close deadline, closure timestamp, or extension state (grep confirmed absent). So
a never-spawned declared member has no row to settle, and a completeness reader counting terminal
rows either closes early or waits forever. **Resolution — membership is materialised, not counted:**
- New `lanes.openGroup({groupId, groupSize, parentSessionId, members:[{laneId,label}...]})` writes
  ALL N member rows atomically at group birth in state `pending` (a new `LaneState`), each carrying
  the declared `groupId/groupSize` and its deterministic `argvToken`. `op:'start'` then transitions
  a `pending` row to `running` when its child actually spawns. A member that never spawns is
  `settle(id,{state:'failed',failureKind:'never-spawned'})` on its EXISTING row — it always has one.
- Schema additions to `LaneRecord`: `groupOpen:boolean` (size not known up front),
  `groupCloseDeadline:number|null` (persisted, survives restart), `groupClosedAt:number|null`,
  `groupExtendedAt:number|null`. These are the state the reviewer found missing; without persisting
  the deadline, restart re-arm (axis 4/FEAT-140-c) has nothing to re-arm from. **This is a schema
  add on a store with archived records — per ARCH-010's "does not license a migration" clause the
  build lane must confirm existing rows tolerate the new optional fields (they default null/false)
  and NOT rewrite old records.**
- Completeness = `groupClosed===true && every member row terminal` — computed ONLY in FEAT-140's
  `groupTerminal(groupId)` over `list({groupId})`. One owner, materialised members, no derivation.
- Idempotent delivery / retry: a cap-refused or crashed member is `failed` on its OWN row and never
  re-allocated a NEW id (a new id is the double-count the reviewer found); retry reuses the member's
  declared lane id. A lane arriving with a groupId whose row is already `groupClosed` is REJECTED at
  `op:'start'` (`{ok:false,kind:'group-closed'}`) rather than silently starting a new group — the
  prior "starts a NEW group" rule rewrote declared groupIds and is dropped.

#### AXIS 4 — boot reconciliation: re-adopt proven-alive orphans; single-write identity; server-independent result
Root cause confirmed: `reconcileBoot` (`lanes.ts:759-781`) cuts EVERY non-owned `running` row —
including a proven `status==='alive'` child (`failureKind:'server-restart-orphan-alive'`, `:781`);
re-adoption is unimplemented; `pid`/`argvToken` are written by a SEPARATE `attachProcess()`
(`:565`) after `recordDispatch()` wrote them null (`:550-551`), so crash-before-spawn and
crash-after-spawn-before-attach are indistinguishable. **The plan's step-5 "alive orphan is
re-adopted" was FALSE against the code — the reviewer is right. Resolutions, each a real lanes.ts
change the build must make (named so it is not discovered late):**
- **Write `argvToken` at BIRTH, not via `attachProcess`.** The token is deterministic (derived from
  the lane id, known before spawn via `newLaneId`), so `recordDispatch` writes it immediately; only
  `pid` is attached post-spawn. Boot can then resolve a `pid:null` row by SCANNING `/proc` for the
  token (a child that spawned but crashed before pid-attach is found; one that never spawned is
  not) — closing the torn-write ambiguity without a second write to make atomic.
- **Re-adopt, don't cut, a proven-alive orphan — but ONLY where a server-independent completion
  channel exists.** Re-adoption is not "leave the row running"; the NEW server must re-establish the
  exit/result watch. That is possible only if the child writes its authoritative result to a
  **server-owned lane file** (`lanes/<id>/result.txt`, already the `resultPointer` authority) rather
  than streaming over the socket that died with the old server. So the runner's transport MUST use
  the file as the result channel (this also resolves half of axis 1's output-boundary gap). Then
  boot re-adoption = re-attach a watcher on that file + the child pid; on completion, `settle` from
  the file. Under the direct+survival transport the child outlives the server (survival scope), so
  this is reachable; a non-survivable direct child or a dead child is still `cut` with a pid-naming
  reason. `reconcileBoot` gains an `adopt` outcome alongside `cut`/`leftRunning`.
- **Transport-specific identity, honestly.** The reviewer is right that `ChildProcess` hides
  identity: survival returns a pid-less synthetic process, container returns the host docker client
  whose death ≠ inner-process death. So the ledger stores the transport's OWN liveness handle
  (survival scope unit name / container+inner-pid), and `liveWithToken` is generalised to consult
  the right one per `transport`. The 6-char `Math.random()` token is widened / combined with the
  lane id so substring collision is not load-bearing.

#### AXIS 6 — landability: an ATOMIC activation gate, not four independently-live steps
Root cause confirmed: a live step-2 runner with results born HELD and nothing to drain them until
step 4 strands results — exactly the round-1 window `ARCH-017:103` forbids. **Resolution — the
completion path (runner + group-settle drain + rail surface + boundary hook) activates ATOMICALLY
behind one `settings.tools.laneRunner` switch that stays OFF until all four are present.** The
intermediate commits ship DARK (code present, switch off, zero behaviour change — the runner socket
is not advertised, the hook is not installed, the rail section is capability-gated and hidden). A
separate FEAT-140 ticket does NOT license flipping the switch before its drain exists — the switch
is the gate. Honest between-state: with the switch OFF at every intermediate commit, background
`Agent` calls remain native (today's behaviour, N wakes) — nothing is stranded because nothing is
diverted. The build order below is commit order; NONE of them changes user-visible behaviour until
the final flip.

#### Carried forward
- **AXIS 1 (NAMED-ONLY).** Container placement is sound (`execInContainer` runs inside, no host
  fallback), but (a) standalone `dispatch.mjs` picks its own permission mode (`:308-315`) and does
  NOT inherit AgentSession's in-process hooks — so a raw-CLI background lane in steps 2-3 runs
  WITHOUT the git-write block / file-lock foreground lanes get; (b) `--meta-out` carries no result
  text and the container branch bypasses it; a writable bind of the lane dir lets a workspace-write
  lane swap `result.txt` for a symlink to a host file an ordinary read follows. **Mitigations in
  this plan:** authoritative result is server-owned and read with `O_NOFOLLOW` (never follow a
  symlink out of the lane dir); the child's output dir is untrusted and separate from the
  authoritative store; the runner passes an explicit conservative permission mode. The execution-
  policy gap (raw CLI bypasses the hooks) is the one residual that is genuinely the USER's call —
  see fork below.
- **AXIS 5 (CLOSED).** Ledger rows do not feed parent `busy` (`running-set.ts:205` carries
  attribution onto the snapshot but liveness is separate; BUG-178's `background` fact is declared by
  the bridge just below), so adding rows creates no phantom-busy. The build MUST keep this holding:
  a HELD group reads the parent as idle/interjectable. BUG-159 suite is the anti-regression.
  Qualify "never refused": a closed/budget-stopped parent DOES throw (`agent-bridge.ts:1572`) — the
  drain must resume-then-deliver or hold, never stamp a send that did not happen.

#### Landable steps (commit order; each ships DARK behind the switch; rough size)
1. **Extract `spawnInIsolation(project,{command,args,env,cwd})`** from the AgentSession routing
   (`agent-bridge.ts:1214-1311`), sharing `execInContainer`/`spawnSurvivable` so there is ONE
   isolation authority (ARCH-010). Pure refactor; AgentSession keeps working through it. ~M.
2. **Ledger schema + membership materialisation** — `openGroup()`, `pending` state, `argvToken` at
   birth, the four new group-state fields, transport-aware liveness handle, and `reconcileBoot`'s
   `adopt` outcome (re-adopt proven-alive survival orphans, `/proc` token scan for `pid:null`). This
   is the axis-3 + axis-4 core and lands with its own verify legs. ~L.
3. **`lane-runner.ts`** — per-project socket, own caps (`LANE_PROJECT_CAP≈6`/`LANE_GLOBAL_CAP≈10`,
   overridable; overflow = backpressure `{ok:false,kind:'lane-concurrency-cap'}`), `op:'start'`/
   `op:'openGroup'`/`op:'closeGroup'`, spawning via `spawnInIsolation`, result → server-owned file,
   settle on exit, `maybeSettleGroup` hook call. ~L (the bulk). Switch still OFF.
4. **Boundary hook** (axis 2) — `decideAgentBackground` effective-mode deny, installed only when the
   switch is on. Ships with independent-verify. ~S.
5. **Wire FEAT-140 drain + `#railPending` rail + WA change, then FLIP the switch.** This is the
   atomic activation (axis 6). The prior four commits become live together. ~S from the runner side
   (barrier body is FEAT-140's).

#### Proof bar (adds to items 1-15 in the Design; new/changed legs)
- **Axis-2 must-FAIL first:** the round-1 `=== true`-and-fail-open hook, run against an Agent call
  with the flag OMITTED, ALLOWS (the bypass) — the new hook DENIES. Plus: `run_in_background:false`
  allowed; `remote` denied; malformed input allowed; deny text has the runner route and no rejection
  wording (BUG-174).
- **Axis-3:** declare a size-3 group, spawn one member, lose the parent before the other two —
  assert the two never-spawned members have `failed('never-spawned')` rows and the group settles
  once (no freeze, no premature close). A cap-refused member reuses its declared id (no double-count).
- **Axis-4:** kill the server with a survival-transport child provably alive → boot `adopt`s it,
  re-attaches the file watch, and on child exit `settle`s from the file; a `pid:null` row whose
  token is found in `/proc` is adopted, one whose token is absent is `failed`; a dead child is
  `cut`. No already-settled sibling touched.
- **Axis-6:** with the switch OFF at each intermediate commit, a background `Agent` fan-out behaves
  byte-identically to HEAD (native, N wakes) — nothing stranded; only the final flip changes it.
- **BUG-159 anti-regression (MANDATORY):** parent reads idle/interjectable while lanes run/HELD; a
  mid-batch user `send()` holds+pushes, never refused. `regressed-from: BUG-159` if anything moves.
- **BUG-174 anti-regression:** every deny/cut notice phrased as interrupted/route-through-the-runner.
- **Truncated reads** of the ledger written concurrently (WA); container-isolation placement; the
  busy-state headless-rail fixture (proof item 15) — all carried.

#### Designed failure behaviour (unchanged in intent, now backed by the mechanisms above)
- **Never-settles:** group timeout consults `liveWithToken` GROUND TRUTH — proven-dead → `cut`,
  proven-alive → `groupExtendedAt` re-arm ONCE, never guillotine a live child. Execution-deadline
  (`dispatch.mjs:348` process-group kill) and barrier-wait deadline are SEPARATE (extra-finding 7):
  the barrier never kills; only the runner's own execution timeout kills, and it kills the child not
  the group.
- **User interjects mid-batch:** the hold lives in the LEDGER, so an interjection turn cannot
  consume it; the drain late-delivers at the next boundary (BUG-159 hold+push), exactly once.
- **Restart mid-group:** `reconcileBoot` (with `adopt`) + FEAT-140 `rearmGroups()` from the ledger
  and the persisted `groupCloseDeadline`; a survival orphan is re-adopted, a non-survivable one
  `cut`; the group settles once, no sibling stranded.

**Changed:** this ticket only (Activity-log append). No source. INDEX regenerated via `board:gen`.
**Verified:** re-derived every axis against the code cited above; no code executed (design only).
**High-stakes (WA §N):** isolation boundary + PreToolUse hook + data-loss + session-lifecycle —
independent clean-room verify required at build for steps 2, 3, 4; the boundary hook (axis 2) and
the boot re-adoption (axis 4) are the two to aim it at first.

**Where I judge the reviewer WRONG (stated bluntly).** Nothing in the six-axis verdict is wrong on
the merits — I re-checked axis 2b (`tool_input` shape + background-default) and axis 4 (reconcileBoot
cuts alive orphans) against ground truth myself and both HOLD exactly as stated. My one disagreement
is with the framing of ranked-objection #4 ("a separate FEAT-140 ticket does not license shipping an
incomplete completion path"): it is right that the split as-DESCRIBED stranded results, but the fix
is not "fold FEAT-140 into ARCH-017" — it is the atomic activation gate above. The tickets can stay
separate; what must be atomic is the SWITCH FLIP, not the commit history. Keeping FEAT-140 a distinct
buildable slice over the ledger (its own verify suite against synthesized records) is still correct
and the reviewer's own axis-6 wording ("safe to split behind an activation gate that requires the
complete path") agrees once "path" is read as runtime-active rather than committed.

**Residual that is genuinely the USER's (one fork, per charter).** NOT one of the four breaks — it
is the axis-1 execution-policy carry-forward: a raw-CLI background lane in migration steps 2-3
bypasses the in-process git-write block and file-lock that foreground lanes get. **Fork:** either
(a) restrict background lanes to read-only/plan until step 3 makes them real AgentSessions that
inherit the hooks (recommended — conservative, and step 3 closes it), or (b) replicate the git-write
block into the runner's spawn path now. This is a security-posture call, not a code detail.

### 2026-09-09 — round-2 cross-provider re-review ATTEMPTED, BLOCKED (no verdict obtained)

The rewritten step-2 plan (entry above) was queued for a second OpenAI/Codex adversarial review
(the reviewer that rejected round 1), attacking the four claimed resolutions (axes 2/3/4/6). The
review COULD NOT be completed: the dispatch transport is currently wedged. `dispatch-client
--check` answers instantly (broker event loop alive), but two separate `op:'dispatch'` requests for
this project (read-only sandbox) each held an ESTABLISHED broker socket for the full attempt with
NO `scripts/dispatch.mjs` child ever spawned, no `--meta-out` scratch file, no lane-ledger row, and
zero output — i.e. the broker accepts the connection but never spawns the reviewer child. Corroborating
symptom: an UNRELATED `codex` job (cwd in a different, non-Orchard project; session `01a08305…`)
had by then run >50 min, far past the broker's 15-min default `--timeout-min`, so its
`killTimer`/`finish` never
fired — the broker's spawn+reap path appears degraded this session, not just slow. Repair requires
touching the host broker / `claude-station` service, which is out of bounds for a worker lane (the
user has live sessions on it). Both of my own dispatch clients were killed (by pid) so nothing is
orphaned; the unrelated other-project codex was left untouched.

**Verdict this round: NONE — cross-provider review blocked on infrastructure.** Per WA and the
dispatch charter I did NOT substitute a same-provider (Claude) reviewer and pass it off as
cross-provider; a Claude self-review of a Claude-authored plan has correlated blind spots and is
explicitly not what "the OTHER provider re-reviews it" asks for. The round-1 NOT-SAFE-TO-BUILD
verdict therefore still stands unrefuted; the rewrite remains UNVERIFIED by the other provider.
**Next step is an orchestrator/user decision:** retry the OpenAI review once the dispatch broker is
healthy (or the user restarts/repairs it), or explicitly accept a labelled-weaker same-provider
review as a stopgap. No source changed; this is an append-only log entry.

### 2026-09-16 — DURABLE HANDOFF: step-1 redesign is MID-FLIGHT, INCOMPLETE, UNVERIFIED — DO NOT LAND

Written for a future session with no memory of this one. A round-3 build lane's tooling went
down mid-edit (every Bash/Read/Edit failed ~10 min with "PreToolUse hook did not respond") and
left the working tree in a partial, uncompiling state. This entry records that state; the code
was NOT touched by this recording pass (append-only, no source changed).

**1. Status in one line.** Step 1 of the ARCH-017 redesign is mid-redesign, INCOMPLETE and
UNVERIFIED — the tree does NOT compile. DO NOT commit or land it as-is.

**2. Why the redesign happened.** Two independent verification rounds (evidence in the scratch
files below) broke the hand-rolled cross-process file lock and the hand-rolled delivery ack
repeatedly. The load-bearing finding: EVERY ledger writer is inside the server process, so the
cross-process lock protected no legitimate participant while itself causing four of the five
round-2 defects. So step 1 (a) deletes the cross-process file lock, replacing it with a
single-writer claim arbitrated by the kernel via a unix socket (a second writer is refused loudly
with `not-writer` rather than silently racing); and (b) moves DELIVERY from a peer's self-report
to a SENDER-SIDE fact — the receipt must carry the byte count the peer wrote to its own stdout,
and the server stamps `delivered` only if that count equals the bytes it sent.

**3. Exactly which files are changed and how far (verified against the real tree this pass).**
All four are UNTRACKED/`M` and unstaged:
  - `src/server/lanes.ts` (NEW/untracked) — DONE as designed and VERIFIED present: no `file-lock`
    / `acquireLock` references remain (cross-process lock deleted); single-writer claim via
    `net.createServer()` on a unix socket with a `not-writer` refusal (~L211/259/299); the bricking
    capacity bound is gone, replaced by an advisory `capacity()` (L468); `markDelivered()` (L643)
    is split out of `settle()` (L599), separated deliberately (L632).
  - `src/server/dispatch-broker.ts` (`M`) — PARTIAL, and it is the compile break. The byte-count
    receipt logic IS present and correct (`terminal()` L92-122: it compares the peer's claimed
    `bytes` to `payloadBytes` and only reports delivered on an exact match). BUT `settleLane()`
    (L171-180) still calls `lanes.settle(..., { delivered, deliveredBy })` — and post-redesign
    `SettleInput` no longer HAS a `delivered` field (it moved to `markDelivered()`). This is the
    single typecheck error: `dispatch-broker.ts(178,7): TS2353 'delivered' does not exist in type
    'SettleInput'`. DISCREPANCY vs the earlier chat report, which framed the broker as done and
    only the client as unfinished: the broker is ALSO unfinished — it must be migrated to the split
    settle()/markDelivered() API (call settle() without delivery fields, then markDelivered() with
    the byte-count evidence).
  - `src/server/dispatch-client.mjs` (`M`) — NOT updated, as reported. `ackAndExit()` (L26-32)
    still sends a bare `{"op":"ack"}` with NO `bytes` field. The broker reads `f.bytes` (L120),
    gets none, treats claimed=-1, and marks the record HELD (L122). So as it stands EVERY lane
    resolves to held. Confirmed.
  - `scripts/verify-lane-ledger.mjs` (NEW/untracked) — still asserts the OLD `admit()`/`delivered`
    semantics, so it is expected to fail and does (see item 5). Must be rewritten for the new
    semantics.

**4. Precise remaining work, ordered, for a fresh engineer.**
  1. Finish `dispatch-client.mjs`: in `ackAndExit()`, count the bytes actually written to stdout
     and send them as `{"op":"ack","bytes":<n>}` so the broker's L120-122 match can succeed.
  2. Fix `dispatch-broker.ts` `settleLane()`: stop passing `delivered`/`deliveredBy` to `settle()`;
     call `settle()` for the record, then `markDelivered()` with the byte-count evidence. This is
     what makes the tree compile.
  3. Rewrite `scripts/verify-lane-ledger.mjs` for the new API (no `admit()`, delivery via
     `markDelivered()` + byte count, claim via the unix socket / `not-writer`).
  4. Rebuild the fixtures with realistic POPULATED state, MULTIPLE contenders, and a peer that can
     FAIL to write — the round-2 verifier's core diagnosis was that the old fixtures were
     "fixture-blind" (built only from final/clean state), which is why 24/... passed while real
     truncation/partial-write cases broke.
  5. Re-run INDEPENDENT verification (cross-provider — see item 6 weakness).

**5. Gate/typecheck/suite status measured this pass (2026-09-16).**
  - `npm run gate` → FAIL (exit 1). Two causes: (a) typecheck FAIL — the single
    `dispatch-broker.ts(178,7) TS2353 'delivered'` error above; (b) leak-gate FAIL — 10 home-path
    hits in three UNRELATED scratch files (`scripts/scratch-bug178-expand.mjs`,
    `scratch-bug178-realstate.mjs`, `scratch-bug178-verify.mjs`), not ARCH-017's. Either one alone
    blocks committing the whole tree.
  - `node scripts/verify-lane-ledger.mjs` → 24 PASS / 10 FAIL (exit 1), as expected for the old
    suite against the new code (fails include R3 corrupt-copy-per-read, R4 admit()/TypeError,
    R9 live-holder lock). This suite is to be REPLACED, not repaired.
  - `npm run board:check` → 5 drift problems, ALL pre-existing and unrelated (BUG-169,
    FEAT-129/131/132 unmappable-status; ARCH-007 unreachable). ARCH-017 itself is NOT in drift.

**6. Open work queue the verifiers left UNTESTED (known weaknesses of both verdicts).**
  - Non-local filesystems: the `O_EXCL` correctness caveat is ARGUED, not tested.
  - Real cross-boot PID recycling (only simulated).
  - Real NTP step / suspend-resume clock jump (only simulated).
  - The harness→`tool_result` delivery gap: the round-2 verifier judged it WIDER than the author
    stated; unresolved.
  - **Cross-provider weakness (record this against BOTH verdicts):** OpenAI quota was exhausted the
    entire session, so BOTH verification rounds ran SAME-PROVIDER (Claude reviewing Claude), never
    the intended cross-provider adversarial review. The round-1 NOT-SAFE-TO-BUILD verdict stands
    unrefuted; the rewrite remains unverified by the other provider. Treat both verdicts as
    correlated-blind-spot-limited until a real OpenAI/Codex dispatch re-runs the attack.

**7. Pointers (not prose).**
  - Evidence: `docs/bugs/_scratch-lane-ledger-verify.md` (round 1) and
    `docs/bugs/_scratch-lane-ledger-verify-r2.md` (round 2).
  - Round-2 attack scripts: originally in `/tmp/atk17/` (now GONE — did not survive), but they are
    already DURABLE in two places, so nothing was lost: inlined in `_scratch-lane-ledger-verify-r2.md`
    (17 references), and present as untracked repo files `scripts/scratch-a17-*.mjs`
    (attack1, attack1b, attack2, attack37, attack6, holder, lanewriter, peer, xproc-worker). No
    rescue copy was needed.

Recorded by a durable-handoff recording lane (no source changed; append-only). This entry is the
canonical state of step 1 — trust it over any older chat summary.

### 2026-09-16 — build lane, round 3 (finish the redesign): the tree compiles, the suite is green, and the landed writer claim was VACUOUS

Picked up the mid-flight state recorded in the durable-handoff entry above and finished it. The
charter's hypothesis — *the redesign is sound and what remains is completion, not rethinking* —
**survives, with one correction that matters more than the compile break it was sent to fix.**

**1. THE HOLE: the single-writer claim, as landed, protected nothing.** `claimWriter()` called
`net.Server.listen(name)` inside a `try` and read "it did not throw" as success. `listen()` does
not throw for `EADDRINUSE` — it EMITS the error on a later tick, and the draft's own
"never crash the owner" handler swallowed it; the `_errorEmitted` field it then consulted is not a
Node API and is always `undefined`. Measured before touching anything, two processes, one data dir:

```
A claim: {"ok":true,"name":"<NUL>orchard-lanes-794798e75af5855a"} isWriter: true   A wrote OK
B claim: {"ok":true,"name":"<NUL>orchard-lanes-794798e75af5855a"} isWriter: true   B wrote OK
```

Both writers, both writing, `not-writer` unreachable — i.e. the mechanism that justified deleting
the lock was inert, and every unserialised-write failure it replaced was still live. This is a
defect in the IMPLEMENTATION, not in the design (the kernel really does arbitrate; the code just
never asked it), so per the charter I finished rather than stopping: `claimWriter()` is now `async`
and awaits `listening`/`error`. Measured after: the second claimant is refused `EADDRINUSE` in 1 ms.
`regressed-from:` this ticket's own round-3 draft, whose handoff entry recorded `lanes.ts` as
"DONE as designed and VERIFIED present" — present it was; working it was not. **Generation must not
be its own only verifier**, and this is the third round in a row on this ticket where that held.

Consequence, deliberately: claiming is an explicit awaited STARTUP act (`dispatch-broker.start()`,
the server boot path, a test's own setup) and mutation time is a cheap synchronous check. A process
that never claimed does not write — it throws `not-writer`. Callers updated: `dispatch-broker.start()`
claims and warns if refused; `index.ts` claims before `reconcileBoot()` and skips reconciliation
(with a named reason) if another process owns the dir.

**2. The second defect, found while wiring the broker to the split API.** `finish()` passed the
ledger write as `terminal()`'s outcome callback, so SETTLEMENT waited for the delivery verdict —
up to `DELIVERY_RECEIPT_MS` (120 s). For that whole window the record says `running`, a state it
knows to be false, **and the result file has not been written yet**: a server restart inside the
window would have `reconcileBoot()` cut the lane and the result would be gone. Order is now settle
(result file first, it is the authority) → send → stamp, and only on matching byte counts. This is
exactly what splitting `markDelivered()` out of `settle()` was for; the broker had not been moved
onto it. Standing regression: **D5**.

**3. The client receipt (the remaining piece the handoff named).** `ackAndExit()` now writes the
payload with a `fs.writeSync` loop that counts bytes, and sends `{"op":"ack","bytes":<n>}` only when
`n === Buffer.byteLength(text)`. A throw (ENOSPC, EPIPE) or a short write sends NO ack and exits
non-zero, so the record stays HELD and the caller is not told the lane succeeded. For a failed
lane the decoration (`dispatch failed [kind] `, the trailing newline) is written separately and not
counted, so the number stays honest.

**4. Changed files** (all unstaged, no git writes): `src/server/lanes.ts` (async claim, honest
`assertWriter`, header corrected), `src/server/dispatch-broker.ts` (claim at start; `settleLane()`
→ settle only; new `stampDelivered()`; ordering), `src/server/dispatch-client.mjs` (byte-counted
receipt), `src/server/index.ts` (await the claim before reconciling),
`scripts/verify-lane-ledger.mjs` (rewritten for the new semantics),
`scripts/fixtures/fake-dispatch-lane.mjs` (`size=N` for a multi-MB result),
`scripts/scratch-a17-{attack1,xproc-worker,holder}.mjs` (the round-2 reproducers, taught to take
the claim so their verdict lines stay truthful). Unrelated housekeeping the user's commit was
blocked on: 10 home-path leak hits redacted in `scripts/scratch-bug178-{expand,verify,realstate}.mjs`
(`$HOME`-relative / `import.meta.url`-relative; no fact, count, logic or file reference changed).

**5. Measured results, commands and real output.**

```
$ npx tsc --noEmit                        → clean (was: dispatch-broker.ts(178,7) TS2353)
$ npm run gate                            → GATE: PASS — safe to commit. (exit 0)
$ node scripts/verify-lane-ledger.mjs     → RESULT 45 PASS / 0 FAIL   (exit 0, 42 s)
$ node scripts/verify-lane-ledger.mjs --must-fail-proof → 5/5 legs PASS (exit 0)
$ npm run verify:dispatch                 → 24 passed, 0 failed
$ npm run verify:feat-100                 → 31 passed, 0 failed
$ npm run verify:feat-141                 → 43 passed, 0 failed
$ npm run verify:bug-158                  → ALL PASSED   (boot path, index.ts change)
$ npm run verify:bug-040-boot-isolation   → 11 passed, 0 failed
$ npm run board:check                     → DRIFT 5 problems — the SAME five as before
                                            (BUG-169, FEAT-129/131/132 unmappable; ARCH-007
                                            unreachable). No new drift.
```

Sample observed values, since a count is not evidence:

```
C1  evidence: "the peer reported writing 295 bytes to its own stdout, matching the 295 bytes sent"
C2  client stderr: dispatch failed [output-write-failed] wrote 0 of 324 bytes to fd 1: ENOSPC …
    record: {"state":"settled","deliveredAt":null,"held":true,"resultOnDisk":true}
C3  client stderr: … wrote 0 of 313 bytes to fd 1: EPIPE …   record held:true
C4  2 000 000 bytes read by the parent; evidence names 2000000/2000000; delivered
W1  intruder: {"claimOk":false,"claimReason":"EADDRINUSE","wrote":0,"refused":25,"codes":["not-writer"]}
    ledger bytes before/after the intruder: [100126,100126]; held records intact 20/20
W2  8 contenders → ["C:WRITER wrote=12","A:refused 12","B:refused 12",…]; claimed/on disk [12,12]; orphan dirs 0
W3  live writer: claim {"ok":false,"reason":"EADDRINUSE"} → after SIGKILL: {"ok":true,"waitedMs":1}; 6/6 results intact
W4  60 record+settle on a 55-record ledger under 4 contenders: 60 of ~65 timer ticks, worst gap 12 ms
D7  24 swept kills: 2 delivered-and-received, 22 correctly held, 0 FALSE stamps
```

The must-FAIL legs are what make those non-decorative: leg 1 (pre-change broker at HEAD records
nothing), leg 2 (`outcomes.ts`-style `slice()` deletes 3 undelivered results where `prune()` deletes
0), leg 3 (`!socket.destroyed` says DELIVERABLE for a peer killed before the frame), leg 4 (**new** —
a bare ack, the round-2 rule's entire evidence, would stamp; the byte-count rule holds), leg 5
(**new** — the unawaited claim admits a second writer; the awaited one is refused).

**6. Fixtures: rebuilt where round 2 said they were blind.** The old suite's diagnosis was "not
vacuous but fixture-blind exactly where I broke it" — empty stores, one contender, a cooperative
mock peer that never writes stdout. Now: W1 runs against a 100 KB populated ledger (20 fat held +
10 delivered + 3 running); W2 runs EIGHT simultaneous contenders; W4 runs four contenders against a
55-record store while timing the event loop; the peer that "cannot write" is the REAL
`dispatch-client.mjs` with its stdout on `/dev/full` and on a closed pipe. The round-2 reproducers
themselves were re-run against this code: `scratch-a17-attack6` (45-trial kill sweep) → 0 false
stamps, 46 held; `attack1` → 1 writer / 1 refused, 25 claimed / 25 on disk, 0 lost; `attack1b` → 0
held results erased, 0 orphaned result files. (`attack2`/`attack37` are NOT re-run: they exercise
`admit()` and the lock, neither of which exists; their successors are P4 and W1–W5.)

**7. Round-2 findings: which are now structurally impossible, and which need a test.**

- **F1 false delivery stamp (ENOSPC/EPIPE swallow, and the blind acker)** — NOT structural; it is a
  rule, so it is TEST-COVERED and must stay covered: C2, C3, D1, D2 (lying ±1 byte), leg 4. The
  residual is narrow and named: a lane whose result is EMPTY has `expected === 0`, which a blind
  acker could match — nothing is lost by it (there is nothing to deliver), but it is the one input
  where the receipt proves nothing.
- **F2 a LIVE lock holder robbed after 30 s** — STRUCTURALLY IMPOSSIBLE. There is no lock, no mtime,
  no age comparison and no clock read anywhere in the claim path; ownership is the kernel's. W3/W5
  witness it (nothing on disk to go stale).
- **F2b release cascade (a holder unlinking the thief's lock)** — STRUCTURALLY IMPOSSIBLE: there is
  no lock file to unlink. W5 asserts the data dir contains no lock artefact at all.
- **F3 stale-break TOCTOU (N waiters enter together)** — STRUCTURALLY IMPOSSIBLE: there is no break
  path to race. W2 is the witness at N=8: one writer, seven `not-writer`, zero lost records.
- **F8 5-second event-loop freeze** — STRUCTURALLY IMPOSSIBLE: no spin, no `Atomics.wait`, no
  waiting at all (a second writer is a misconfiguration to report, not a queue to join). W4 measures
  it: worst gap 12 ms against round 2's 5009 ms with zero ticks.
- **F6 big results never stamped** — fixed by the 120 s window plus the settle/stamp split; C4.
- **F7 the bound bricks the ledger** — fixed: `capacity()` is advisory, recording never stops; P4.

**8. What I could NOT test — the clean-room verifier's work queue.**

- **Non-Linux platforms.** `writerClaimName()` falls back to a FILESYSTEM socket path off Linux, and
  a filesystem socket **survives the process that bound it** — so after a SIGKILL the successor would
  get `EADDRINUSE` forever and the ledger would be permanently unwritable. Linux (abstract namespace)
  has no such failure and this repo is Linux-only (BUG-163), so it is flagged, not patched: the sound
  fix is a connect-probe (ECONNREFUSED ⇒ unlink once and retry), and I will not ship a recovery path
  I cannot exercise on this host. **Untested, and it is the first thing to attack if the OS
  assumption ever moves.**
- **Non-local filesystems** — now moot for the claim (no `O_EXCL` anywhere), still unverified for the
  ledger file's own `writeAtomic` rename.
- **Real cross-boot pid recycling** — simulated (S5), never rebooted.
- **The harness gap** — the receipt now proves the bytes left the client process onto fd 1, which is
  strictly narrower than round 2's "the client decided to ack", but whether the CLI turns them into a
  `tool_result` is still unobservable from here.
- **A real OpenAI dispatch** — all broker tests use `scripts/fixtures/fake-dispatch-lane.mjs`.
- **Cross-provider review** — still never obtained; both prior verdicts remain same-provider.

**9. Still open / handoff.** Step 1 now compiles, is green on its own suite, and passes the gate —
but per the "High-stakes, WA §N" clause above (session lifecycle + concurrent state + a data-loss
surface) this is NOT verified. **An independent clean-room pass is required before landing**, and
item 8 above is its queue; item 1 is the reason to insist on it. The scope fork (option A vs B)
still needs the user.

### 2026-09-16 — round 4: cross-provider verdict DO NOT LAND, and the digest-receipt fix (folded in from an orchestrator-written scratch handoff)

**Provenance of this entry.** The round-4 build lane's tooling died mid-edit (`PreToolUse hook did
not respond (host client may be unreachable)`, four consecutive calls) before it could append, and a
follow-up lane dispatched to do the appending was killed by the same fault. The orchestrator wrote
the state to `docs/bugs/_scratch-arch017-round4-handoff.md` directly; a round-4 finishing lane
(2026-09-18) folded it in here verbatim in substance and deleted the scratch file. **Every claim
below was re-checked against the real files before folding — no discrepancy was found** (see the
verification note at the end of this entry).

#### STATUS AT THE TIME OF WRITING: TREE IS MID-CHANGE — DO NOT LAND, DO NOT COMMIT

`scripts/verify-lane-ledger.mjs` was NOT updated for the round-4 semantics. Its in-suite peer double
still acks count-only, so **C1 / C4 / D7 are expected to FAIL**. That is expected, not a regression.

#### What round 4 was

A **cross-provider** clean-room verifier (the first non-same-provider verify of this session)
returned **DO NOT LAND**. `terminal()` in `src/server/dispatch-broker.ts` validated the delivery
receipt by **byte-count length only**, so a peer that received nothing but guessed the right number
was stamped `delivered`. This was the **fourth consecutive round** in which the false-delivery
property failed.

**The finding was CONFIRMED, not refuted** — reproduced end-to-end over the real socket rather than
in-memory, by `scripts/scratch-a17-r4-forged-receipt.mjs`:

- before: `peerBytesReceived=0 claimed=328 delivered=true`
- after: `delivered=false held=true`, honest peer still `delivered=true`
- exit code flips 1 → 0

#### The fix, and the reasoning that must not be lost

**`delivered` now means:** Orchard's own write of the whole result completed without error **AND**
the consumer returned `sha256(receiptNonce ‖ the exact bytes it wrote to its fd)` — unguessable, and
truncated, replaced or duplicated bytes all fail it.

**Pure sender-side proof was considered and rejected, with reason:** on AF_UNIX a completed write is
equally true for a dead peer and for the ENOSPC/EPIPE client, so sender-side alone would re-admit
round-2 finding 1. Orchard's own fact is therefore recorded *separately* as `handoffAt` /
`handoffBytes` — always written, grants nothing, record stays HELD.

(This is the answer to the round-4 charter's instruction to move the fact to the sender under the
ARCH-010 rule. The lane did not ignore that instruction; it applied it and found the sender-side
fact insufficient on this transport. Keep both facts separate — that separation is the design.)

#### Files changed since round 3

- `src/server/dispatch-broker.ts` — nonce + digest + handoff callback
- `src/server/lanes.ts` — `markHandoff()` plus 3 fields
- `src/server/dispatch-client.mjs` — digest receipt

`npx tsc --noEmit` was clean at that point. Nothing staged; no git writes.

#### Remaining work, in order (as handed off)

1. Suite peer double must send the digest.
2. Permanent tests: **D8 forged-correct-count** (the exact gap three rounds of fixtures missed),
   D9 same-length swap, D10 duplicated output, D11 handoff-without-ack.
3. A must-FAIL leg 6 proving the old length-only rule stamps the forge.
4. Full suite plus `--must-fail-proof`.
5. The attacks a read-only sandbox blocked, which are **untested, not held**: N-process claim race;
   killing a claim holder; the filesystem-socket `EADDRINUSE` wedge; a receipt that never arrives; a
   receipt arriving after prune; a crash between settle and send.
6. `npm run gate`; `npm run board:check` (5 drift problems — BUG-169, FEAT-129/131/132, ARCH-007 —
   are pre-existing and not this ticket's).

#### Why D8 matters more than it looks

Three rounds of fixtures were, in the verifiers' words, "not vacuous but fixture-blind exactly where
the attacker went": D1's blind peer **omits** the count and D2 uses **incorrect** counts. Neither
challenges a *correct forged* count. Every same-provider round passed this property; the first
cross-provider round broke it immediately.

#### Standing weaknesses of the verdicts so far

- Rounds 1 and 2 ran **same-provider** (OpenAI quota exhausted at the time), so their blind spots
  correlate with the author's.
- The round-3 cross-provider verifier ran in a **read-only sandbox**: the author suite died on
  `EROFS: mkdtemp '/tmp/arch017-XXXXXX'` with zero assertions run, and socket binding was blocked
  (`EPERM`). Use `--sandbox workspace-write` on the next cross-provider dispatch.
- Never tested anywhere: non-Linux claim path, NFS / non-local filesystems, real cross-boot pid
  reuse, the harness→`tool_result` gap.

#### Fold-in verification (2026-09-18, the finishing lane)

Re-checked before appending, so this entry is evidence and not hearsay:

- `npx tsc --noEmit` → exit 0, clean. (Handoff claim: clean. Holds.)
- `npx tsx scripts/scratch-a17-r4-forged-receipt.mjs` → real output:
  `phase 1 (honest peer) : bytes=328 delivered=true` /
  `phase 2 (forging peer) : peerBytesReceived=0 claimed=328 actuallySent=328 delivered=false held=true` /
  `phase 2 handoff (the SENDER's own fact): 328 bytes flushed to the peer's socket` → exit 0.
  Matches the handoff's quoted numbers exactly.
- The three named files carry the named changes: `dispatch-broker.ts:112` `receiptDigest()`,
  `:125-127` nonce + expected digest, `:157-160` the three refusal messages and the one grant;
  `lanes.ts:150-152` `handoffAt`/`handoffBytes`/`handoffEvidence` and `:674` `markHandoff()`;
  `dispatch-client.mjs:97` the `sha256(nonce ‖ written bytes)` receipt.
- **No discrepancy found.** The scratch file was deleted after this entry landed.

### 2026-09-18 — round-4 finish lane (CHECKPOINT 1 of 2: the suite now enforces the digest receipt)

Charter: fold the orchestrator's scratch handoff into this log (done, entry above), then finish the
round-4 work the two killed lanes never got to. **The charter's hypothesis — the digest-receipt
design is sound and what remains is test/fixture work plus the deferred attacks — SURVIVES so far;
nothing below required a design change.** Checkpointing here because the tooling fault that killed
rounds 4a and 4b is still live.

**1. The suite's in-suite peer doubles now send the digest.** Three doubles acked count-only:
`request()` in `scripts/verify-lane-ledger.mjs` (the in-process peer), the `ack-peer.mjs` child the
D7 kill-sweep spawns, and (by construction) the new round-4 modes. `honest` now returns
`sha256(receiptNonce ‖ the bytes it holds)`; `lie+`/`lie-` now hold one byte more/fewer and prove
possession of THAT (a truncated peer proves its truncated bytes), which keeps D2 sharp instead of
turning it into a count check the broker no longer performs.

Before (count-only doubles, the state the handoff predicted): **42 PASS / 3 FAIL** — C1, "a failing
dispatch is recorded as failed" and D7, all three failing only because the double could not produce
a receipt the round-4 broker accepts. After: **49 PASS / 0 FAIL**.

**2. New permanent tests D8–D11.** `size=N` prompts make the result exactly N bytes whatever the
lane id is, so the forger can know the true count without ever reading the frame — i.e. the
attacker's real position.

- **D8 forged-correct-count** (the gap three rounds of fixtures missed and the first cross-provider
  verifier walked through): a peer that never attaches a data handler and acks the CORRECT number.
  Observed: `bytes Orchard actually sent: 4096` / `bytes the forging peer claimed (it never read the
  frame): 4096` / `record {state:settled, deliveredAt:null, held:true, handoffBytes:4096}`. The test
  asserts `sent === claimed` as a PRECONDITION, so it can never degrade into D2.
- **D9 same-length byte swap**: `bytes sent / bytes the peer claims to hold: [4096,4096]` → held.
- **D10 duplicated output**: `bytes sent / bytes the peer put on its fd: [4096,8192]` → held.
- **D11 handoff-without-ack** — the two facts stay separate, both directions. For every attached but
  unproven peer: `["blind acker lane: 308/308/false", "closes early before acking: 301/301/false",
  "forged-correct-count lane: 4096/4096/false", "same-length swap lane: 4096/4096/false",
  "duplicated output lane: 4096/4096/false"]` (handoffBytes/resultBytes/delivered) — Orchard records
  its own write every time and it grants nothing. And the inverse, which is the half that could have
  been faked: for the peer that was already gone before the frame was written (D6),
  `handoffAt: null` — Orchard does not claim a handoff it never made.

**3. Must-FAIL leg 6 (new)** — the round-3 LENGTH-ONLY rule, evaluated on real observed numbers
against the real broker rather than asserted: `bytes Orchard sent / bytes the forger claimed (having
read none): [4096,4096]` → `round-3 predicate (acked count === bytes sent ⇒ delivered): WOULD STAMP
DELIVERED`; shipped record `{state:settled, deliveredAt:null, held:true}`. The leg asserts the
forgery really matched before it claims anything, so it fails loudly rather than passing vacuously
if the fixture ever drifts.

**4. Real commands and real counts.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                    → RESULT 49 PASS / 0 FAIL   (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof  → 6/6 legs PASS             (exit 0)
$ npx tsx scripts/scratch-a17-r4-forged-receipt.mjs         → HELD (exit 0), numbers in the entry above
$ npx tsc --noEmit                                          → clean (exit 0)
```

Two suite bugs found and fixed while doing this, both mine-this-round, both of the same kind: a
`const buf` inside the peer doubles' data handlers shadowed the outer accumulator and threw
`ReferenceError: Cannot access 'buf' before initialization`. In the in-process double it crashed
loudly; in the SPAWNED `ack-peer.mjs` (stdio `'ignore'`) it turned D7's calibration into an
**unbounded** `while` loop — the suite hung until the outer timeout with no message. The calibration
wait is now deadline-bounded and throws a named error. A hang is a worse failure mode than a fail,
and the suite had one.

**Still to do in this round (checkpoint 2):** the six attacks the read-only sandbox blocked on the
cross-provider round, then `npm run gate` and `npm run board:check`.

### 2026-09-18 — round-4 finish lane (CHECKPOINT 2 of 2: the six deferred attacks, closed with real output)

These are the attacks the round-3 CROSS-PROVIDER verifier could not run because its sandbox was
read-only (`EROFS: mkdtemp`, socket binding `EPERM`). They were **untested, not held**. This host is
writable, so all six were run for real. New reproducers:
`scripts/scratch-a17-r4-deferred-attacks.mjs` (A1/A2/A4/A5/A6/A6b) and
`scripts/scratch-a17-r4-fssock-wedge.mjs` (A3).

**A1 — N-process claim race, N=16, one data dir, burst aligned to a wall-clock instant.**
`processes / claims granted / claims refused: [16,1,15]`; every refused process reports `0/10`
written-refused; `records claimed written vs records on disk: [10,10]`. One writer, nothing lost.
(The in-suite W2 does this at N=8; this is the same property at twice the contention.)

**A2 — killing a claim holder.** Holder claims, writes 6 held results, is SIGKILLed (the real node
pid, not the `npx` wrapper — killing the wrapper lets the holder exit *gracefully*, which unlinks
the socket and would hide the failure). Successor: `claim ok / ms waited: [true, 0–1]`,
`held records / result files still readable: [6,6]`, `successor write: ok`.

**A3 — the non-Linux filesystem-socket EADDRINUSE wedge. CONFIRMED REAL, and now diagnosed rather
than silent.** Round 3 flagged this and declined to patch ("I will not ship a recovery path I cannot
exercise on this host"). It is exercisable: faking `process.platform` before `lanes.ts` is imported
takes the filesystem branch while socket, SIGKILL and EADDRINUSE stay real. Measured before any
change: `claim {ok:false, reason:"EADDRINUSE"}`, `wrote:"not-writer"`, socket file still on disk, 1
undelivered result stranded, **permanently** — the Linux leg of the same script recovers in 0 ms.

Change made (`src/server/lanes.ts`, new `diagnoseInUse()`): on EADDRINUSE against a FILESYSTEM name,
connect-probe the address; a refused connect proves no listener, and the claim is refused with
`EADDRINUSE-stale-socket: <path> exists but nothing is listening on it … The ledger is UNWRITABLE
until that file is removed; held results are untouched on disk. Remove <path> by hand …`. The
abstract (Linux) name is untouched and still reports a plain `EADDRINUSE`.

**Auto-unlink-and-retry was considered and REJECTED, with the reason recorded so nobody re-derives
it:** two successors probing simultaneously both see "stale", and the second one's `unlink` deletes
the FIRST one's *live* socket — two simultaneous writers, which is precisely the failure this whole
mechanism exists to make impossible and the one that was found vacuous in round 3. Node offers no
unlink-if-still-this-inode. So the honest move is to name the condition, not to guess under a race;
**diagnosis cannot create a second writer.** Standing regression: new suite check **W6**, which
asserts both legs — a LIVE holder is still refused with a plain `EADDRINUSE` (exclusion intact) and
a dead one is refused with the named diagnosis. Observed in the suite:
`second claimant while the holder is ALIVE: {"ok":false,…,"reason":"EADDRINUSE"}` /
`claimant after the holder was SIGKILLed: EADDRINUSE-stale-socket: /tmp/…/.lanes-writer-….sock …`.

**A4 — a receipt that never arrives.** A peer reads the result and stays alive and silent for the
whole `DELIVERY_RECEIPT_MS` window. `peer bytes received / handoff bytes recorded: [343,343]`,
`elapsed vs window: ["124029ms","120000ms"]`, `record {state:settled, deliveredAt:null, held:true,
resultOnDisk:true}`, evidence `(none — held)`. The record settled immediately (it did not sit
`running` for two minutes), the broker survived the window, nothing was stamped.

**A5 — a receipt arriving after the record is gone.** The lane is pulled by the user and dismissed,
then aged out at the bound (nothing deletes a HELD record — that is forbidden by design), and only
then does the peer's valid digest receipt land. Observed: the broker logs
`lane … was delivered (…digest matched…) but the stamp could not be written (… it is not in the
ledger) — the record stays HELD, so it may be delivered again rather than lost`;
`record present again after the receipt arrived: false` (no resurrection); and the control dispatch
immediately afterwards is `{state:"settled", delivered:true, bytes:353}` — the broker keeps serving.

**A6 / A6b — a crash between settle and send.** A6 kills the broker process the instant the settled
record appears on disk: `{state:"settled", delivered:false, handoff:false, onDisk:true, bytes:331}`,
boot reconciliation `{checked:0, cut:0, leftRunning:0}` — it does not cut a settled record, and
nothing claims a delivery or a handoff that did not happen. A6b closes the *narrower* window
deliberately, since A6's timing is not controllable: a 64 MB result to a peer that never reads means
the socket write cannot complete, so the kill lands strictly before the send finishes. Observed:
`{state:"settled", delivered:false, handoff:false, onDisk:true, bytes:64000000}` — the full result is
on disk, the record is held, and Orchard claims neither fact.

**Final measured state.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                     → RESULT 50 PASS / 0 FAIL  (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof   → 6/6 legs PASS            (exit 0)
$ npx tsx scripts/scratch-a17-r4-deferred-attacks.mjs        → ALL DEFERRED ATTACKS CLOSED (exit 0)
$ npx tsx scripts/scratch-a17-r4-fssock-wedge.mjs            → wedge reproduced + diagnosed; Linux leg recovers
$ npm run verify:dispatch / feat-100 / bug-158 / bug-040-boot-isolation → all exit 0 (anti-regressions)
$ npm run gate                                               → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                        → DRIFT 5 problems — the SAME five as before
                                                               (BUG-169, FEAT-129/131/132, ARCH-007). No new drift.
```

**Hypothesis verdict.** The charter's hypothesis — *the digest-receipt design is sound and what
remains is test/fixture work plus the deferred attacks, not another redesign* — **SURVIVES.** Not
one of the six attacks exposed a hole in the digest design. The only code change this round is the
non-Linux claim DIAGNOSIS (A3), which is on a platform this repo does not support (BUG-163) and does
not touch the receipt rule at all.

**Files changed by this lane** (all unstaged, no git writes): `src/server/lanes.ts` (the
`diagnoseInUse()` probe only), `scripts/verify-lane-ledger.mjs` (digest-sending peer doubles, D8–D11,
W6, must-FAIL leg 6, a deadline on D7's calibration wait), this ticket, `docs/bugs/INDEX.md`
(`board:gen`), and two new scratch reproducers. **`src/server/dispatch-broker.ts` and
`src/server/dispatch-client.mjs` were NOT touched this round** — the round-4 digest code in them is
as the killed lane left it, now proven by the suite rather than asserted.

**Untested, and therefore the next clean-room verifier's work queue.** Stated plainly rather than
implied:

- **The harness gap, still.** The receipt proves the bytes left the client process onto fd 1. Whether
  the CLI turns them into a `tool_result` in the parent's context is not observable from here and is
  explicitly NOT claimed by `deliveredAt`.
- **An EMPTY result** (`expected === 0`): the digest over zero bytes is a constant a peer can compute
  without receiving anything. Nothing is lost by it (there is nothing to deliver), but the receipt
  proves nothing on that one input. Narrow, named, unfixed.
- **A receipt with a CORRECT digest but a contradictory byte count** is currently accepted (the
  broker decides on the digest and treats `bytes` as audit trail). A conforming client cannot produce
  it, and possession is proven either way — but it is an inconsistency nobody has attacked.
- **Non-Linux beyond the claim path**: the A3 diagnosis is now tested under a faked platform, but no
  part of this has ever run on a real macOS/BSD host.
- **Non-local filesystems** (NFS) for `writeAtomic`'s rename; **real cross-boot pid recycling**
  (simulated only, S5); **a real OpenAI dispatch** (all broker tests use
  `scripts/fixtures/fake-dispatch-lane.mjs`).
- **The A6 kill timing** is polling-bounded, not instrumented; A6b exists because of that and pins
  the pre-send window deterministically, but there is no single-stepped proof of every instant
  between settle and stamp.
- **Concurrency of the drain/step-2 surface**: not built, not tested, out of scope this round.

**WA §N still applies and is not satisfied by this entry.** This round is generation verifying its
own generation again, on session-lifecycle + concurrent state + a data-loss surface. An independent
CROSS-PROVIDER clean-room pass is still REQUIRED before landing, and it must run with
`--sandbox workspace-write` — the round-3 verifier's read-only sandbox is why six attacks sat
untested for a round. The list above is its queue. Step 2 (non-blocking dispatch, the drain, the
rail) was deliberately not started.

**Incidental, not this lane's:** while running `tsc` mid-round, a transient error appeared in
`src/server/index.ts:3634` (`claude-login-${number}` vs a closed union) and had cleared minutes
later — another lane is editing this tree concurrently. Not touched, not reverted.

### 2026-09-18 — round 4 status marker: STEP 1 COMPLETE, BLOCKED ON CROSS-PROVIDER VERIFY (do NOT land)

Status marker only — no source touched, nothing staged. Green tests here are NOT permission to land.

- **Tree is coherent.** `npx tsx scripts/verify-lane-ledger.mjs` → 50 PASS / 0 FAIL; `--must-fail-proof`
  → 6/6 legs; `npm run gate` → PASS, exit 0; `npm run board:check` → 5 pre-existing problems (BUG-169,
  FEAT-129/131/132, ARCH-007), no new drift. All six previously-deferred attacks are closed with real
  output already recorded above in this ticket.
- **BLOCKED — the required independent CROSS-PROVIDER verify (`--sandbox workspace-write`) could not
  run.** The OpenAI quota window is exhausted until **2026-09-19 13:37**. The dispatch was attempted
  and refused with `[quota-window]`; thread id `01a0b17f-c863-7bf3-b427-7f5e39a56dae`.
- **Why a same-provider substitute is NOT acceptable here (load-bearing).** Three same-provider
  verification rounds passed the false-delivery property, and the FIRST cross-provider round broke it
  within minutes. The blind spots are demonstrably correlated on exactly this property. A
  same-provider green must NOT be recorded as satisfying the verify requirement for this ticket.
- **Verifier charter to re-run (priority targets), so a later session can reconstruct it:**
  - *Digest receipt:* empty-result digest; nonce reuse or predictability across lanes; a digest
    computed from bytes the consumer INTENDED rather than WROTE; a consumer writing to a different fd;
    loose comparison; any fallback to the byte count when the digest is missing.
  - *Writer claim:* N-process race; race during boot; holder kill and recovery; whether the
    confirmed-real filesystem-socket `EADDRINUSE` wedge is recoverable without manual intervention.
  - *Ordering & durability:* receipt never arrives; receipt after prune; crash between settle and send;
    concurrent settle plus prune.
  - *Vacuity of the 50 assertions*, on the standing assumption that the new D8–D11 fixtures are blind
    in a new place.
- **Still untested by anyone — verifier's work queue:** the harness→`tool_result` gap; empty-result
  digest; digest-vs-count contradiction; a real non-Linux host; NFS; a real OpenAI dispatch.
- **Step 2 not started** (non-blocking dispatch, the drain, the `#railPending` UI). The scope fork —
  all dispatched lanes Orchard-owned vs background lanes only — remains OPEN and is the user's call.

### 2026-09-18 — round-5 finish lane (CHECKPOINT 1 of 2: the three findings reproduced, and what `delivered` now means)

Charter: reproduce the cross-provider verifier's three defects FIRST, then fix. All three reproduce.
Reproducer: `scripts/scratch-a17-r5-emission-probe.mjs` (`--after` re-runs the same probes against
the fix). Measured BEFORE any change:

```
F1a empty result        {"delivered":true,"handoff":true,"resultBytes":0,"emittedBytes":0}
F1b digest-no-output    {"delivered":true,"handoff":true,"socketBytes":2048,"emittedBytes":0}
F1c2 fd-2-only receipt  {"clientStdoutBytes":0,"payloadOnStderr":true,"acceptedByRound4Rule":true,
                         "digestSaysFd1":false,"digestSaysFd2":false}   <- no fd in the statement at all
F2  ack-before-write    {"delivered":true,"handoff":false,"outcomeReported":true}
F3  the D10 peer shape  {"bytesTheOldTestPRINTED":8192,"bytesActuallyEmitted":0}
```

One correction to the verifier's write-up, stated rather than silently fixed: its `F1c` case as
described (the production client acking a payload written only to fd 2) does NOT reproduce through
the real broker with the failing fixture, because that path sends an EMPTY `text` and the client
falls back to `host broker failed`, whose digest cannot match — held for an unrelated reason
(`{"delivered":false,"state":"failed","clientStdoutBytes":0}`). The finding is nonetheless REAL and
is reproduced above as **F1c2** in its exact shape: the production client, a non-empty failure text,
a fake broker recording the receipt. `acceptedByRound4Rule:true` with the payload only on fd 2, and
the receipt byte-for-byte identical to one for an fd-1 write.

**What `delivered` now means, exactly** (the round-5 answer to "state the honest weaker claim", and
it is deliberately weaker than round 4's):

> Orchard wrote all N bytes to the consumer's socket and **its own write completed** (`handoffAt` is
> now REQUIRED, not merely usual), **and** the consumer returned `sha256(nonce || "fdN" || bytes)`
> matching those exact bytes, having also stated a byte count, which must agree.
> **PROVEN:** it holds exactly those bytes and names the channel it says it wrote them to.
> **NOT PROVEN, and not provable from this process at any price:** that it emitted them anywhere at
> all. No process can inspect another's file descriptors. A peer that holds the bytes and writes
> them nowhere still produces a valid receipt — that is F1b, it is not closed, and it is not
> closeable; what changed is that the record now says so.

The record carries that limit rather than the reader having to know it: new
`LaneRecord.deliveryProof` (`possession-digest-fd1` / `possession-digest-fd2`), and the evidence
string now ends "…PROVEN: it holds exactly those bytes and names that channel. NOT PROVEN, and not
observable from this process: that it actually emitted them…". **Decision for the orchestrator,
flagged not hidden:** the FIELD is still called `deliveredAt`. Renaming it to `acknowledgedAt` would
churn the store, the broker and the whole suite, and step 2's `drainLanes()` is the caller that will
stamp a true context delivery — `deliveredBy` already distinguishes them. The type doc now opens
with "READ THIS BEFORE TRUSTING THE NAME". Overrule if you want the rename.

**Fix 1 — the digest binds the DESTINATION.** `receiptDigest(nonce, fd, bytes)`; the frame carries
`receiptFd` (1 for a result, 2 for a failure text — both reach the parent, they are different
channels); the client digests with the fd it actually wrote to. Plus: an EMPTY result is never
stamped (over zero bytes the proof is a constant), and a receipt whose byte count contradicts its
own digest is refused. AFTER: `F1a {"delivered":false}`, `F1c2 {"acceptedByRound4Rule":false,
"digestSaysFd2":true}` — the fd-2 write is now distinguishable, and refused for a result payload.

**Fix 2 — delivery may not outrun Orchard's own fact.** A receipt arriving before the flush callback
is a legitimate ARRIVAL ORDER (so refusing outright would hold honest peers); the verdict is now
DEFERRED to the write callback and granted only if the write succeeded. AFTER:
`F2 {"delivered":null,"handoff":false,"outcomeReported":false}` — deferred, never granted. The 120 s
receipt window still bounds the wait, so a deferral cannot hang.

**Fix 3 — the fixture rebuilt so it fails when the peer writes nothing.** Every in-suite peer double
now writes its bytes to a REAL file descriptor, and every emission assertion reads the size back off
the filesystem (`emittedBytes()`) instead of printing a computed number. The verifier was right to
say "check the siblings": **D8** now asserts the forger really emitted 0, **D9** that the swap peer
really wrote the same NUMBER of bytes, **D10** that the duplicate was really emitted (`sent*2` read
off disk), **D11** reports real emission per peer, and the D7 kill-sweep peer writes the real bytes
before its marker.

**One pre-existing test was itself wrong, found by this fix.** "a failing dispatch is recorded as
failed" asserted `delivered` — and passed only because of the empty-result hole: the failing fixture
produced NO text, so the peer "proved" possession of nothing. It now runs a failure WITH output and
asserts `deliveryProof === 'possession-digest-fd2'`; the empty case became **D12**.

New permanent tests: **D12** empty result never stamped, **D13** wrong-channel receipt refused (with
a precondition that the peer really emitted every byte, so the test is about channels and nothing
else), **D14** self-contradicting receipt refused, **D15** the null-handoff deferral, driven through
the production function via a new named test seam (`__terminalForTests`).

```
$ npx tsx scripts/verify-lane-ledger.mjs   → RESULT 54 PASS / 0 FAIL   (exit 0)
```

Still to do in checkpoint 2: must-FAIL legs 7 and 8, the full re-run, gate and board:check.

### 2026-09-18 — round-5 finish lane (CHECKPOINT 2 of 2: must-FAIL legs 7 and 8, full counts, and the queue)

**Must-FAIL legs 7 and 8 (new), both evaluating the OLD predicate on real frames rather than
asserting it.**

- **Leg 7a** — an empty result under the round-4 rule: `bytes sent: 0` →
  `round-4 predicate (digest over zero bytes, a constant any peer can compute): WOULD STAMP
  DELIVERED`; shipped record `{state:settled, deliveredAt:null, held:true}`.
- **Leg 7b** — a RESULT payload acknowledged as written to fd 2: the frame names fd 1 as the
  channel, and the two round-4 receipts print identically —
  `round-4 receipts for an fd-1 write vs an fd-2 write of the same bytes:
  ["ad3e62d22a3833e0","ad3e62d22a3833e0"]` → `WOULD STAMP DELIVERED`; shipped record held. That
  equality IS the defect, shown rather than described.
- **Leg 8** — a valid receipt with Orchard's write incomplete:
  `round-4 predicate (a matching digest ⇒ stamp, handoff or not): WOULD STAMP DELIVERED`,
  `Orchard's own write completed?: false`, `shipped verdict: DEFERRED — nothing stamped`.

**Final measured state.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                     → RESULT 54 PASS / 0 FAIL   (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof   → 8/8 legs PASS             (exit 0)
$ npx tsx scripts/scratch-a17-r5-emission-probe.mjs          → the round-4 defects, reproduced (exit 1 by design)
$ npx tsx scripts/scratch-a17-r5-emission-probe.mjs --after  → NONE OF THE FINDINGS REPRODUCE (exit 0)
$ npx tsx scripts/scratch-a17-r4-deferred-attacks.mjs        → ALL DEFERRED ATTACKS CLOSED (exit 0)
$ npx tsx scripts/scratch-a17-r4-forged-receipt.mjs          → phase 1 delivered=true, phase 2 HELD (exit 0)
$ npm run verify:dispatch / feat-100 / feat-141 / bug-158 / bug-040-boot-isolation → all exit 0
$ npm run gate                                               → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                        → DRIFT 5 — BUG-169, FEAT-129/131/132,
                                                                ARCH-007. Pre-existing; no new drift.
```

**Which of the verifier's "still unverified by anyone" list is already settled by round-4 evidence**
(so the next reviewer is not sent after ground that is covered — all of it is re-run and green in
this round's numbers above):

| Named as unverified | Where it is actually covered | Observed |
| --- | --- | --- |
| boot contention | suite B1/B2/B3 + A6/A6b | reconciliation resolves against ground truth; a claim owned by a LIVE server is left alone |
| holder kill and recovery | A2, suite W3 | successor claims in 0–1 ms, 6/6 held results intact, writing resumes |
| N-process claim race | A1, suite W2 | 16 processes → 1 writer, 15 `not-writer`, 10/10 records on disk |
| stale-socket recovery | A3 + suite W6 | wedge REPRODUCED off Linux; deliberately NOT auto-recovered (the unlink race admits two writers) — refused with a named diagnosis instead |
| crash durability | A6 / A6b | 64 MB result intact on disk, record settled+held, neither handoff nor delivery claimed |
| late receipts after pruning | A5 | logged and dropped, nothing resurrected, broker keeps serving |
| settle/prune interaction | suite P1–P5, leg 2 | held results are never pruned; `outcomes.ts`-style prune deletes 3 where `prune()` deletes 0 |
| nonce replay | **NOT covered — still open** | the nonce is per-lane and random, but no test replays a receipt from lane A against lane B |

**What remains untestable or untested — the next verifier's queue.**

- **Emission, permanently.** F1b is not closed and cannot be: no process can inspect another's file
  descriptors. The receipt is possession + stated channel. If a future round wants real emission
  proof it has to come from outside both processes (the harness, or an fd the broker itself owns).
- **The harness gap**: whether the bytes become a `tool_result` in the parent's context is still
  unobservable from here, and `deliveredAt` does not claim it.
- **Nonce replay across lanes**: named above, untested, and the cheapest thing for the next round.
- **A non-conforming consumer's fd claim** is self-reported; the binding makes an honest client's
  receipt specific, it does not make a dishonest one's truthful.
- **Real non-Linux host**, **NFS `writeAtomic`**, **real cross-boot pid recycling**, **a real OpenAI
  dispatch** (all broker tests use `scripts/fixtures/fake-dispatch-lane.mjs`) — unchanged from round 4.
- **The cross-provider verifier's own integration probes never ran** (its sandbox refused unix socket
  binds with `EPERM` and `npx tsx` had no network, `EAI_AGAIN`). Its three findings were function-level
  and all three were real. The next cross-provider dispatch needs `--sandbox workspace-write` AND
  network, or it will again be limited to function-level probing.

**Files changed by this lane** (all unstaged, no git writes): `src/server/dispatch-broker.ts`
(fd-bound digest, empty-result and self-contradiction refusals, the handoff deferral, the
`__terminalForTests` seam, header rewritten to the weaker claim), `src/server/dispatch-client.mjs`
(fd-bound receipt, `fd` in the ack), `src/server/lanes.ts` (`deliveryProof` field + the
"READ THIS BEFORE TRUSTING THE NAME" doc on `deliveredAt`), `scripts/verify-lane-ledger.mjs`
(real-fd peer doubles, D12–D15, legs 7–8, the corrected failing-dispatch test),
`scripts/fixtures/fake-dispatch-lane.mjs` (`emptyresult`, `withtext`),
`scripts/scratch-a17-r5-emission-probe.mjs` (new), the two round-4 scratch reproducers (fd binding),
this ticket, `docs/bugs/INDEX.md`.

**WA §N: still NOT verified.** Five rounds, five independent verdicts, and every single one found a
real defect — three of the five in the delivery rule itself. This round is again generation
verifying its own generation. It must not land without another independent cross-provider pass, run
this time in an environment that can bind a unix socket. Step 2 remains unstarted.

### 2026-09-18 — round 5, addendum: the ledger's claim is renamed to what it proves, and nonce replay is closed

**Why.** Round 5 established that emission is not provable from the Orchard process, and I offered
to keep the field called `deliveredAt` with a qualifier beside it. The orchestrator overruled that,
correctly: a name is exactly the quiet overstatement a later reader acts on without checking the
proof field next to it, and false-proof is the one class this ticket has failed on in all five
rounds. Renamed rather than annotated.

| was | is now |
| --- | --- |
| `LaneRecord.deliveredAt` | `acknowledgedAt` |
| `LaneRecord.deliveredBy` | `acknowledgedBy` |
| `LaneRecord.deliveryEvidence` | `acknowledgementEvidence` |
| `lanes.markDelivered()` | `lanes.markAcknowledged()` |
| `LaneDeliveredBy` (type) | `LaneAcknowledgedBy` |
| `stampDelivered()` (broker-local) | `stampAcknowledged()` |

`deliveryProof` keeps its name as instructed — it is the precise qualifier
(`possession-digest-fd1|fd2`) and was never the thing overclaiming. The ticket's **Violated
invariant** section now carries a round-5 correction saying the same thing: acknowledgement is what
this transport can stamp, delivery is what step 2's `drainLanes()` will stamp, and `acknowledgedBy`
distinguishes them.

**Persisted records DID need handling — this was not a source-only rename.** The live data dir
(`~/.local/share/claude-station/lanes.json`) holds **10 records written under the old names, 1 of
them stamped and 9 held**. Read as-is under the new code they would have had `acknowledgedAt:
undefined`, which `isHeld()` reads as HELD — the rail would have re-offered an already-collected
result. `readAll()` therefore upgrades legacy names in place on read (`upgradeLegacyNames()`),
one-way and lossless: it moves values, never invents them, leaves new-format records untouched, and
back-fills `deliveryProof: null` (a round-5 addition older records cannot have). Verified against a
COPY of the real file — the live one was not modified:

```
records: 10
ack/deliver keys on record 0: acknowledgedAt,acknowledgedBy,acknowledgementEvidence,deliveryProof
acknowledged: 1 | held: 9          (same counts as before the rename)
any legacy key left: false
stamped record carried over: {"by":"blocking-dispatch","at":true,"proof":null,"evidence":"Orchard wrote 3011 bytes and the write completed w"}
```

**Nonce replay across lanes — tested, REFUSED, now permanent as D16.** Round 5 named this untested
and cheapest-next. Two dispatches produce BYTE-IDENTICAL results on purpose, so the nonce is the only
thing separating their receipts and the test cannot pass for the wrong reason; lane B answers with
lane A's nonce. Observed: `nonces (A / B): ["8b82d26c0859","cfd6d2a19dd5"]`, `result bytes identical
between the two lanes: true`, `A (honest receipt) acknowledged / B (replaying A's nonce)
acknowledged: [true,false]`. The control matters as much as the attack: the honest receipt over the
SAME bytes is still accepted, so the refusal is about the nonce and nothing else. Not a finding.

**Counts after the rename — unchanged except for the new test, which is the point.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                    → RESULT 55 PASS / 0 FAIL  (54 + D16, exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof  → 8/8 legs PASS            (exit 0)
$ npx tsc --noEmit                                          → clean (exit 0)
$ npm run gate                                              → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                       → DRIFT 5 — BUG-169, FEAT-129/131/132,
                                                               ARCH-007. Pre-existing; no new drift.
```

**Deliberately left referencing the old names, each with a reason.**

- **`src/server/survivor-delivery.ts` / `index.ts` — `deliveryEvidenceFor()`, `DeliveryEvidence`.**
  NOT this fact. That is FEAT-065's survivor-delivery evidence; the name collision is accidental and
  renaming it would have been a silent edit to another feature. Untouched.
- **`docs/bugs/FEAT-140-group-barrier-dispatch…`** references `deliveredAt` 11 times in its own
  design text. Tickets are append-only and it is not mine to rewrite; whoever builds FEAT-140 reads
  the invariant here first. Flagged, not edited.
- **This ticket's own earlier Activity entries** keep the old name, as they must — an append-only log
  records what was true at the time. Only the Status header and the invariant section were updated.
- **`DELIVERY_RECEIPT_MS`** keeps its name: it is the window for the *receipt*, not a claim about
  delivery.

**Unchanged from round 5:** this is still NOT independently verified, still needs a cross-provider
pass in an environment that can bind a unix socket, and step 2 is still unstarted.

### 2026-09-19 — round-6 RECORD entry (the fix landed green last round; this writes it down)

This entry is bookkeeping written by a records lane, not a build lane: round 6's code was completed
and the suite was green in a prior lane that never wrote its Activity entry, so the work existed only
in the tree. Every claim below was re-verified against the real source and the real tooling as this
was written; two numbers in the dispatch brief did not match ground truth and are flagged inline
rather than silently copied.

**Round 6 fixed four failures a cross-provider reviewer found in the round-5 receipt.**

1. **The stated channel was ignored.** A receipt with a correct fd1 digest but claiming `fd:2`,
   `fd:99`, a string token (`fd:"two"`), `null`, or omitting the field entirely was accepted.
   Verified in `src/server/dispatch-broker.ts`: `statedFd` is parsed as `typeof f.fd === 'number' &&
   Number.isInteger(f.fd) ? f.fd : null` (`:207`); a null/absent field is refused with a message that
   the receipt "does not state which channel it wrote to" (`:227`) and a mismatch is refused naming
   the peer's claimed `fd` and the payload's `destFd` (`:228`). Test D17 (`verify-lane-ledger.mjs`
   `:887`–`:933`) drives all five cases and asserts the `fd:2` refusal includes `fd 2` and the
   `fd omitted` case is refused for naming no channel.
2. **The handoff was not actually required.** A record could reach disk `acknowledged / handoff:null`.
   Verified: `markAcknowledged()` (`lanes.ts:866`) throws `LaneStoreError('handoff-missing')` when
   `rec.handoffAt == null` (`:886`–`:888`), and the broker defers an early receipt into the write
   callback via `pendingGrant` (`dispatch-broker.ts:185`, set at `:251`, drained at `:268`–`:270`), so
   no acknowledgement stamp can precede the handoff.
3. **Legacy upgrade accepted garbage.** Verified in `upgradeLegacyNames()` (`lanes.ts:484`): the four
   timestamps `['acknowledgedAt','handoffAt','settledAt','dismissedAt']` are type-checked and a
   non-`Number.isFinite` value throws `corruptError` (`:515`–`:519`); a record carrying BOTH a legacy
   and a current name with DIFFERENT values is refused (`:500`). **DISCREPANCY (flagged, not
   corrected): the brief said this path touches "the 10 real records in the live `lanes.json`"; the
   live `~/.local/share/claude-station/lanes.json` currently holds 11 records, not 10.** The mechanism
   is unaffected — it type-checks whatever is on disk — but the count in the brief is stale.
4. **D15 was vacuous** (it passed with `receiptReached:false` against an unconditional timer). Verified
   rewritten (`verify-lane-ledger.mjs:1060`–`:1073`): it now asserts `receiptReached === true`,
   `writeReleased === false` at receipt time, `outcome === null` (deferred) at receipt time, and that
   the resolution is `delivered === true` with `at === 'after the write completed'` — i.e. the grant
   fires from inside the write completion, never before it.

**The structural part of fix 4 is the headline, because it is the answer to four consecutive rounds of
blind fixtures.** A new `heldReason` field on the lane record (`lanes.ts:193`, stamped by the broker
via `markHeld` → `rec.heldReason = why` at `:861`) plus a `heldBecause(rec, mustMention)` gate in the
suite (`verify-lane-ledger.mjs:114`) converts every delivery-refusal test from "assert the record is
absent/held" to "assert this SPECIFIC refusal reason, a string only that one refusal can produce". The
gate first fails loudly if `heldReason` is empty ("VACUOUS: … nothing proves a receipt ever reached
the broker"), then requires the reason to mention the fragment under test. It is applied across D-series
tests (`:730`, `:750`, `:778`, `:794`, `:811`, `:831`, `:845`, `:859`, `:884`) and D17. That is a
suite-wide vacuity audit, not a one-test patch — it is the mechanism that would have caught the prior
rounds' "assert absence" tests that passed while proving nothing.

**Measured this round (re-run, not inherited):**

```
$ node scripts/verify-lane-ledger.mjs                       → RESULT 58 PASS / 0 FAIL   (exit 0)
$ node scripts/verify-lane-ledger.mjs --must-fail-proof     → 8/8 legs PASS             (exit 0)
$ npm run gate                                              → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                       → DRIFT 5 — BUG-169, FEAT-129/131/132,
                                                               ARCH-007. Pre-existing; no new drift.
```

**DISCREPANCY (flagged, not corrected): the brief stated `verify-lane-ledger.mjs` "55 PASS / 0 FAIL".
The real suite now reports 58 PASS / 0 FAIL** (55 was the round-5 count; round 6's D17 and the
`heldBecause`-gated cases raised it). 0 FAIL either way; the count is higher, not lower.

**Still UNVERIFIED, recorded honestly.** The cross-provider reviewer that found these four defects
could not bind a unix socket (`listen EPERM`) and had no network, so its silence on real socket and
real client integration is UNTESTED rather than held. The standing list also remains open: the
harness→`tool_result` gap, real non-Linux hosts, NFS, and cross-boot pid reuse. Per WA §N this is
session-lifecycle + concurrent state + a data-loss surface and every round so far has had its
self-verification broken, so step 1 is NOT the last word until an independent clean-room pass runs in
an environment that CAN bind a unix socket. DO NOT LAND. Step 2 is still unstarted.

**Diff size** across the three touched files was roughly 644 insertions / 123 deletions (per the brief;
not independently re-measured, as the round-6 code was landed by a prior lane and this entry only
records it).

**Housekeeping note for the user (NOT a lane action):** a status check found the entire working set —
113 paths, including all of `src/server/lanes.ts`, `dispatch-broker.ts`, this ticket, and dozens of
unrelated FEAT-141/144/145/146 and BUG-173..183 files — currently STAGED in the git index. Lanes on
this project never stage anything; this was not done by this lane and is left exactly as found for the
user to resolve. Reported in the lane's return, not acted on.

### 2026-09-18 — round 6: four cross-provider findings, and the vacuity audit the reviewer asked for

Reproducer: `scripts/scratch-a17-r6-probe.mjs` (`--after` re-runs the same probes). Every verdict in
it is read back from the ledger FILE, not from a function's return value — finding 2 was invisible
any other way. **All four reproduced before any change.**

```
R1  correct fd-1 digest + a receipt claiming fd:2 / fd:99 / fd:"two" / fd:null / OMITTED
    → all five {"acknowledgedOnDisk":true,"proof":"possession-digest-fd1"}
R2  disk after an acknowledgement with no handoff  {"acknowledgedOnDisk":true,"handoffOnDisk":false}
R3  readAll of {"id":"bad","acknowledgedAt":"garbage"} → read back verbatim, heldAfterRead:false
    (also: both names with DIFFERENT values merged silently in favour of the new one)
R4  D15 asserts only `outcome === null` — true whether or not the receipt ever arrived
```

AFTER: `NONE OF THE FINDINGS REPRODUCE` (exit 0). R1 → all five refused, each with a reason naming
the claimed channel. R2 → `refusedWith:"handoff-missing"`, and the control (handoff recorded first)
still acknowledges. R3 → all four malformed/ambiguous inputs refused `corrupt`, while a well-formed
legacy record still upgrades.

**One refinement to finding 4, stated rather than quietly fixed.** The reviewer's probe printed
`{"receiptReached":false,"pass":true}`; in this repo's D15 the receipt DOES arrive
(`receiptReached: true`). The defect is real and I am not disputing it — D15 never *asserted*
arrival, so it was vacuous **by construction**, and would have passed silently the day the fixture
broke. It just was not currently broken. Command: `npx tsx scripts/scratch-a17-r6-probe.mjs`.

**Fix 1 — the stated channel is compared** (`dispatch-broker.ts`). Round 5 bound the channel into
the digest and then ignored the `fd` the receipt declared, so half the fix was decorative. The
receipt must now carry an integer `fd` equal to the channel the payload is for; a missing or
mismatched statement is refused with a reason that names it. Standing test **D17** (five cases, all
checked on disk, all carrying the CORRECT digest so the statement is the only variable).

**Fix 2 — the store enforces the handoff invariant** (`lanes.ts markAcknowledged`). The broker's
handoff stamp is best-effort by design (a ledger failure must never fail a dispatch), so a guard in
the caller was one more thing to remember; `markAcknowledged()` now throws `handoff-missing`. There
is no route left to the incoherent record. Standing test **S8**, asserted on disk, with the control
leg proving the happy path still works. The reviewer also asked which of "refuse early receipts" or
"defer them" was intended: **defer, deliberately** — `socket.write()`'s callback is a flush
notification and a fast peer can legitimately reply first, so refusing would hold honest consumers
at random. The grant executes from *inside* the write callback and only if the write succeeded; the
reasoning is now written at the decision point in the code. **D15** asserts both halves.

**Fix 3 — the legacy upgrade refuses garbage** (`lanes.ts upgradeLegacyNames`). A non-numeric
`acknowledgedAt/handoffAt/settledAt/dismissedAt` is refused as corrupt (bytes preserved, nothing
overwritten) rather than read as a stamp — `isHeld()` asks `acknowledgedAt != null`, so a nonsense
string silently retired a held result and made it prunable. A record carrying BOTH the legacy and
current name with DIFFERENT values is also refused: two answers to one question, and nothing here
guesses. Standing test **S9**, including the control that a well-formed legacy record still upgrades.
**Verified against the real data:** the live `~/.local/share/claude-station/lanes.json` still reads
under the stricter rules — 10 records, 1 acknowledged, 9 held, no legacy key left — and its one
stamped record does carry a handoff (`handoffAt:1789817144819, ack:1789817144820`), so the live
ledger is coherent with the new invariant. Checked against a COPY; the live file was not modified.

**Fix 4 — the vacuity audit, which is the finding.** The reviewer was right that fixing only D15
guarantees a fifth round of this. The shared shape across EVERY delivery-refusal test was: assert
`acknowledgedAt === null`, which is equally true when the peer double silently did nothing. The
mechanism that closes the class: the broker now records **why** it refused
(`LaneRecord.heldReason`), and a new `heldBecause(rec, mustMention)` helper FAILS when no refusal was
recorded at all. Every refusal test (D1, D2, D8, D9, D10, D12, D13, D14, D16) now asserts its own
distinct reason string. Observed, one per test — no two alike:

```
D1  "…acknowledged with no byte count but NO possession proof…"
D8  "…acknowledged with 4096 bytes but NO possession proof…"
D9  "…possession proof does not match the 4096 bytes sent to fd 1…"
D10 "…claims to have written 8192 bytes but returns a proof over the 4096 bytes sent…"
D12 "…EMPTY result, and a possession proof over zero bytes is a constant…"
D17 "…states it wrote these bytes to fd 2, but this payload is for fd 1…"
```

`heldReason` is not only test scaffolding: it is the fact "why is this result still waiting", which
until now was computed, logged to nobody and dropped, so the rail could say only *that* a result was
held. Two audits fell out of it immediately, both real:

- **D2 was testing a different rule than its name claimed.** Its ±1-byte peers are refused by the
  COUNT check, not the digest check — an honestly-reporting truncated peer disagrees with the sender
  before any digest is compared. Behaviour correct, description wrong; renamed and re-asserted, with
  D9 (same length, different bytes) noted as the case that actually reaches the digest.
- **`populate()` was building records reality forbids.** The "realistic populated ledger" fixture
  wrote acknowledged-with-null-handoff rows; the new store guard rejected it on the first run. A
  fixture full of impossible states is the same defect class as a vacuous assertion, and it was
  sitting inside the helper used to make fixtures *more* realistic.

**Measured, after.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                    → RESULT 58 PASS / 0 FAIL  (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof  → 8/8 legs PASS            (exit 0)
$ npx tsx scripts/scratch-a17-r6-probe.mjs                  → all four REPRODUCED (exit 1, by design)
$ npx tsx scripts/scratch-a17-r6-probe.mjs --after          → NONE OF THE FINDINGS REPRODUCE (exit 0)
$ npx tsx scripts/scratch-a17-r5-emission-probe.mjs --after → NONE OF THE FINDINGS REPRODUCE (exit 0)
$ npx tsx scripts/scratch-a17-r4-deferred-attacks.mjs       → ALL DEFERRED ATTACKS CLOSED (exit 0)
$ npx tsx scripts/scratch-a17-r4-forged-receipt.mjs         → HELD (exit 0)
$ npm run verify:dispatch / feat-100 / bug-158 / bug-040-boot-isolation → all exit 0
$ npm run gate                                              → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                       → DRIFT 5 — pre-existing (BUG-169,
                                                               FEAT-129/131/132, ARCH-007)
```

Legs stay at 8: the round-6 before/after proof is the probe script, which runs the real functions and
is committed alongside the tests rather than being a claim in this log.

**Still untestable / untested.** Unchanged and still honest: emission is not provable from this
process at any price (a peer holding the bytes and writing them nowhere returns a valid receipt —
the `fd` is its own statement, now checked for consistency, never observed); the harness→`tool_result`
step is unobservable; a non-conforming consumer's channel claim is self-reported; no real non-Linux
host, no NFS, no real cross-boot pid recycling, no real OpenAI dispatch. New this round: the
reviewer's own integration probes were again blocked (`listen EPERM`), so **no cross-provider verdict
has ever seen this suite run end to end** — its silence on integration is unverified, not agreement.

**WA §N.** Six rounds, six independent verdicts, six times a real defect — four of them in the
receipt rule and its fixtures. Not verified; must not land without another independent pass in an
environment that can bind a unix socket. Step 2 remains unstarted.

### 2026-09-18 — round 7: the heldReason lifecycle, the legacy conflict bypass, and making the anti-vacuity gate unfalsifiable

Reproducer: `scripts/scratch-a17-r7-probe.mjs` (`--after` re-runs it). All assertions read the ledger
FILE. Measured BEFORE any change:

```
R1a  disk after a refusal then a successful acknowledgement
     {"acknowledged":true,"heldReason":"old refusal: …NO possession proof","held":false}
R2   deliveredAt:123 + acknowledgedAt:null → {"refusedWith":null,"acknowledgedAfterRead":123,"handoffAfterRead":null}
     acknowledged with NO handoff          → accepted on read
R3   the round-6 gate applied to an ACKNOWLEDGED record with a stale reason → ACCEPTS
```

**R1b — not reproduced as described, and I am not claiming the finding is wrong.** The reviewer's
`failed handoff persistence: acknowledged=false heldReason=null` comes from injecting a persistence
failure into its own instrumented store. My end-to-end injection (make the data dir read-only for
exactly the window in which the broker stamps the handoff, using a 64 MB payload and a paused peer so
the write cannot flush early) did NOT land in that window — the precondition printed
`handoff still unrecorded when the ledger was made unwritable: false`, i.e. the handoff had already
persisted. Command: `npx tsx scripts/scratch-a17-r7-probe.mjs`. **The defect is nevertheless real and
code-evident** — `stampAcknowledged`'s catch only logged — so it is fixed and covered by a
deterministic test (S11) that drives the same lifecycle against a real on-disk record instead of
racing a chmod.

**Fix 1a — a record that is no longer held stops saying why it is held.** `markAcknowledged()` clears
`heldReason`. This is not tidiness: that string is what a rail renders at a user, so an acknowledged
record carrying "waiting because the peer sent no proof" is a lie about a collected result. Test
**S10**, on disk: `while refused {heldReason:"old refusal…", held:true}` → `after
{acknowledgedAt:true, heldReason:null, held:false}`, with a precondition asserting a reason really
was recorded first.

**Fix 1b — every outcome leaves a reason, including the ones that go wrong.** The outcome callback is
now a named `recordOutcome()` (one readable lifecycle instead of an inline arrow), and
`stampAcknowledged`'s catch records a `heldReason` naming the failure instead of logging to nobody.
Test **S11** drives it through a new seam (`__recordOutcomeForTests`) against a real record whose
handoff is genuinely missing: `after {acknowledgedAt:null, heldReason:"a valid receipt arrived but
the acknowledgement could not be recorded (…)", held:true}`.

**Fix 2 — the conflict rule fires on ANY disagreement, including null-versus-value.** Round 6
required both sides to be non-null, so `{deliveredAt:123, acknowledgedAt:null}` fell through and the
legacy value was copied over the explicit null. `null` is not "unset": the current writer always
writes the key, so an explicit null IS an answer ("never acknowledged") and disagreeing with a legacy
timestamp is precisely the two-answers case. Added alongside it: a read-side coherence check —
`acknowledgedAt != null && handoffAt == null` is refused, so the write-side guard is not decorative
against a file that merely ARRIVES in that state. Test **S12**, with both control legs (a coherent
legacy-only record still upgrades; both names agreeing is not a conflict).

**The whole-file refusal, decided deliberately as asked.** One bad record still makes the whole
ledger unreadable, and that is the intended behaviour. The reason: a partial read would silently
answer "these are all your lanes" while hiding records it could not parse, and the very next
`writeAll()` — a prune, a settle, any dispatch — would rewrite the file from that truncated view and
**permanently delete the unparsed record's bytes**. Refusing the whole file is the only version where
nothing writes and nothing is lost; the error already names the preserved copy and the repair path.
The cost is real and is stated rather than hidden: while a ledger is corrupt, held results are
readable only by hand, from the file and the `lanes/<id>/result.txt` files that are still on disk.

**Fix 3 — the gate that was built to end vacuity is now unfalsifiable.** `heldBecause()` checked only
"a reason exists and mentions X". It now rejects four distinct ways a caller could be fooled: an
ACKNOWLEDGED record (its reason is stale by definition), a still-RUNNING record (no receipt can have
been judged — the shape D3 was passing on), a record with NO handoff (the peer had nothing to
acknowledge; callers must opt out explicitly with `expectHandoff:false`, which only the
peer-died-before-the-write case does), and a missing or wrong reason. **The gate now has its own
must-FAIL test inside the suite** (`GATE — heldBecause() rejects every shape that made it vacuous`),
which asserts it rejects all five bad shapes and still accepts a genuine one — so the gate cannot
quietly regress the way it just did.

**The re-audit, and the number you asked for: ZERO of the 62 assertions moved.** Every held-assertion
in the file now runs through the repaired gate — the ten refusal tests already did (D1, D2, D8, D9,
D10, D12, D13, D14, D16, D17), and this round added the five that did not: **D3** (the one named,
which could pass on a running record), **D4**, **D6** (with `expectHandoff:false`, since the peer
died before the write and the absent handoff is the point), **C2** and **C3**. All five pass. That is
the honest result: they were not passing on wrong records today, but D3 had no protection against it
— the latent vacuity was real and is now mechanically closed. This is the first round in five in
which the audit came back clean, and it is worth saying plainly rather than dressing up.

**Measured, after.**

```
$ npx tsx scripts/verify-lane-ledger.mjs                    → RESULT 62 PASS / 0 FAIL  (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof  → 8/8 legs PASS            (exit 0)
$ npx tsx scripts/scratch-a17-r7-probe.mjs                  → R1a/R2/R3 REPRODUCED (exit 1, by design)
$ npx tsx scripts/scratch-a17-r7-probe.mjs --after          → NONE OF THE FINDINGS REPRODUCE (exit 0)
```

### 2026-09-19 — step-2 build lane, round 1: STOPPED AT THE HYPOTHESIS GATE (no code written)

Dispatched to BUILD step 2 (group-settle drain + non-blocking dispatch + `#railPending`), under an
explicit charter gate: *"the lane ledger gives you everything step 2 needs to READ, so step 2 is
drain logic plus a rail, with no ledger changes. If that is wrong — if the drain needs a ledger
capability that does not exist — STOP and report before building, because `src/server/lanes.ts`
belongs to another lane right now."* A concurrent lane owns `lanes.ts`, `dispatch-broker.ts` and
`scripts/verify-lane-ledger.mjs` and I was forbidden to touch them.

**The hypothesis is REFUTED. Step 2 cannot be built read-only against today's ledger.** Five
capabilities the drain's own hazard list requires are absent from the exported surface — each
verified against the working-tree file this round, not inherited from the round-2 plan (whose line
numbers are stale; the absences are not):

1. **No group close of any kind.** `groupClosed` is set once, at birth, from `DispatchInput`
   (`lanes.ts:723`). There is no `closeGroup()`/`openGroup()` export and `writeAll()` is
   module-private (`:643`), so *no module outside `lanes.ts` can transition a group to closed*. The
   design's "a group has an explicit close" and the 30-minute close deadline have no seam.
2. **No open-group state.** `grep group` over the whole file returns only `groupId`/`groupSize`/
   `groupClosed`. The four fields the round-2 plan named as load-bearing — `groupOpen`,
   `groupCloseDeadline`, `groupClosedAt`, `groupExtendedAt` — do not exist. Without a PERSISTED
   deadline there is nothing for a restart to re-arm from, so "a group that is never closed" cannot
   be closed after a restart.
3. **No `pending` lane state.** `LaneState = 'running'|'settled'|'failed'|'cut'` (`:87`). Membership
   therefore cannot be materialised at group birth, which is the axis-3 resolution to *"a declared
   member that never spawns must not freeze the group"*: with no row, there is nothing to
   `settle(…,'never-spawned')`.
4. **`reconcileBoot` has no `adopt` outcome.** `grep adopt` → zero hits. It cuts every non-owned
   `running` row including a provably-alive child (`failureKind:'server-restart-orphan-alive'`,
   `:1058`). Restart-mid-group therefore kills live lanes rather than re-adopting them.
5. **`argvToken` is written post-spawn by `attachProcess()` (`:764`), null at birth (`:750`).** So
   crash-before-spawn and crash-after-spawn-before-attach are indistinguishable, and the `/proc`
   token scan that resolves a `pid:null` row has nothing to scan for.

**Also confirmed absent (so the next lane does not re-check):** `src/server/lane-runner.ts`,
`drainLanes`, `groupTerminal`, `spawnInIsolation`, `decideAgentBackground`, `#railPending`,
`pendingLanes`/`processLanes`, any `verify-feat-140`/step-2 suite. `grep -rn` for all of those
across `src/ public/ scripts/` hits **only `lanes.ts`** (in prose). Step 2 is at zero; nothing was
half-built by the two lanes that died here.

**What IS buildable without touching `lanes.ts` (the reduced option, offered not taken).** A
known-count-only variant: the runner calls the existing `recordDispatch(input, preallocatedId)` N
times at group birth with the same declared `groupId`/`groupSize`/`groupClosed:true`, materialising
members as `running`; `groupTerminal()` reads `list({groupId})`; `drainLanes()` stamps via the
existing `markHandoff()` → `markAcknowledged(id,'group-settle',…)` pair (the `by` union already
carries `'group-settle'|'user'|'orchestrator'|'timeout'` — step 1 provisioned the drain's own
vocabulary, `:88`). That delivers the user's default path and the escape hatch. **What it gives up:**
open groups / explicit close / close-deadline + restart re-arm (1,2), an honest `pending` state for a
declared-but-unspawned member (3), and live-orphan re-adoption (4,5) — i.e. three of the four
hazards the charter named, and the two axes the cross-provider review broke round 1 on. I judged
shipping that silently to be the exact failure mode this ticket keeps having (a mechanism that
passes its own tests and does not survive the review), so I did not build it unasked.

- **Changed:** nothing. This log entry only. No source file touched, nothing staged.
- **Verified:** the five absences above, by direct read/grep of the working-tree `lanes.ts` and a
  tree-wide grep for the step-2 symbols. No behaviour tested — there is no step-2 behaviour to test.
- **Still open / handoff:** the orchestrator decides between (a) WAIT for the `lanes.ts` lane to
  land, then dispatch step 2 with the schema work included, or (b) build the reduced known-count
  variant now and file the four deferred hazards. Either way the ledger work in the round-2 plan's
  landable-step 2 (`openGroup`, `pending`, group-state fields, `argvToken` at birth, `adopt`) is a
  PREREQUISITE of the full step 2 and must be assigned to whoever owns `lanes.ts`.
- **Symptom of a deeper design flaw?** Mild: the round-2 plan sequenced the ledger schema change as
  step-2 commit #2, but step 1 landed the ledger without it, so "step 2" is now two tickets' worth of
  work in one file that a concurrent lane holds. The plan's own commit order was right; the
  dispatch that split `lanes.ts` ownership from step-2 ownership is what made it unbuildable.

```
$ npx tsx scripts/scratch-a17-r6-probe.mjs --after           → NONE OF THE FINDINGS REPRODUCE (exit 0)
$ npx tsx scripts/scratch-a17-r5-emission-probe.mjs --after  → NONE OF THE FINDINGS REPRODUCE (exit 0)
$ npx tsx scripts/scratch-a17-r4-deferred-attacks.mjs        → ALL DEFERRED ATTACKS CLOSED (exit 0)
$ npm run verify:dispatch / feat-100 / bug-158 / bug-040-boot-isolation → all exit 0
$ npm run gate                                               → GATE: PASS — safe to commit. (exit 0)
$ npm run board:check                                        → DRIFT 5 — pre-existing (BUG-169,
                                                                FEAT-129/131/132, ARCH-007)
```

**The live ledger, re-checked against the stricter read rules** (on a COPY; the live file was not
modified): `records: 10 | acknowledged: 1 | held: 9 | any legacy key left: false`. The real
acknowledged record carries a handoff, so it satisfies the new read-side coherence check — the rules
added this round do not lock anyone out of their own data.

**Files changed this round** (unstaged, no git writes): `src/server/lanes.ts` (clear `heldReason` on
acknowledgement; conflict rule fires on any disagreement; read-side two-part-fact coherence check),
`src/server/dispatch-broker.ts` (`recordOutcome()` lifecycle, the catch records a reason,
`__recordOutcomeForTests` seam), `scripts/verify-lane-ledger.mjs` (repaired `heldBecause()` + its own
must-FAIL GATE test; D3/D4/D6/C2/C3 brought under the gate; S10/S11/S12),
`scripts/scratch-a17-r7-probe.mjs` (new), this ticket, `docs/bugs/INDEX.md`.

**Still untestable / untested.** Unchanged: emission is not provable from this process at any price;
the harness→`tool_result` step is unobservable; a non-conforming consumer's channel claim is
self-reported; no real non-Linux host, no NFS, no real cross-boot pid recycling, no real OpenAI
dispatch. New this round: **R1b's exact state — a handoff whose PERSISTENCE fails — is not reachable
by timing injection on this host**, so the fix is covered at the lifecycle seam rather than
end-to-end; and for the third consecutive review the cross-provider environment could not bind a unix
socket (`listen EPERM`), so **no independent verifier has ever seen this suite run end to end.** That
silence is unverified, not agreement.

**WA §N.** Seven rounds, seven independent verdicts, seven real defects. Not verified; must not land
without an independent pass in an environment that can bind a unix socket. Step 2 remains unstarted.

### 2026-09-19 — round-7 verify + step-2 build lane (CHECKPOINT 1 of N: real state found)

Dispatched to finish round 7 AND build step 2 (ledger capabilities + group-settle drain +
non-blocking dispatch + `#railPending`), owning the whole tree for this ticket.

**Phase 1 — what actually landed.** The round-7 fix lane COMPLETED; nothing was left half-done.
Verified against the working tree, not the ticket's own claim:

```
$ npx tsx scripts/verify-lane-ledger.mjs                    → RESULT 62 PASS / 0 FAIL   exit 0
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof  → 8/8 legs PASS             exit 0
$ npx tsx scripts/scratch-a17-r7-probe.mjs --after          → NONE OF THE FINDINGS REPRODUCE, exit 0
      R1a {"acknowledged":true,"heldReason":null,"held":false}          (was: stale reason retained)
      R2  deliveredAt:123 + acknowledgedAt:null → refusedWith:"corrupt" (was: silently acknowledged)
      R3  gate vs an ACKNOWLEDGED record with a stale reason → FAILS    (was: ACCEPTS)
```

All three round-7 findings are fixed in the tree: `markAcknowledged()` clears `heldReason`
(`lanes.ts:930`), the broker's outcome path is a named `recordOutcome()` whose catch records a
reason (`dispatch-broker.ts:390`, seam `__recordOutcomeForTests:394`), the conflict rule fires on
null-versus-value, and `heldBecause()` (`verify-lane-ledger.mjs:114`) rejects acknowledged /
running / no-handoff / no-reason / wrong-reason and carries its own must-FAIL test in the suite.
Re-audit re-run this round: **ZERO of the 62 assertions moved** under the repaired gate, matching
the round-7 claim. Round 7 needs no further work; the rest of this lane is phases 2 and 3.

Step 2 remains at zero, as the 2026-09-19 entry above refuted it: the five ledger capabilities are
still absent (`grep -n 'groupOpen\|pending\|adopt\|openGroup' src/server/lanes.ts` → no hits).

### 2026-09-19 — step-2 build lane (CHECKPOINT 2 of N: the ledger capabilities and the drain are written)

**Phase 2 — the five absences the previous lane refuted the hypothesis on are closed**, in
`src/server/lanes.ts`:

1. `openGroup()` / `closeGroup()` / `extendGroup()` / `groupState()` — exported, and they are the
   real path the previous lane found missing: `writeAll()` is still module-private, so these four
   are the ONLY way group state changes. `recordDispatch` was split into a private
   `recordDispatchRow()` (build) + write, so `openGroup({members})` materialises N declared members
   in ONE write — N separate `recordDispatch` calls would leave the ledger observable in N-1
   half-declared states and a drain reading between two of them would fire early.
2. `groupOpen` / `groupCloseDeadline` / `groupClosedAt` / `groupExtendedAt`, all persisted. The
   deadline is an absolute ms ON THE RECORD, not a `setTimeout`, so a restart re-arms from the file.
   Legacy records (every row step 1 wrote) default to `groupOpen:false` — the CONSERVATIVE default:
   defaulting to open would make every pre-existing lane in the live ledger hold its own drain shut.
3. `LaneState` gains `pending`, and `list({heldOnly})` excludes it alongside `running`.
   `promotePending()` is the `pending`→`running` transition; `closeGroup()` cuts any member still
   `pending` as `failureKind:'never-spawned'` rather than letting it freeze the group forever.
4. `reconcileBoot` gains **adopt**. A provably-alive orphan is taken over (serverPid/serverStart/
   bootId rewritten to this server) instead of cut. Proof is required — the child's argv must still
   carry the lane's token; anything less still cuts.
5. `argvToken` is written at BIRTH (`DispatchInput.argvToken`, stamped by the broker with the meta
   path before the spawn), and `attachProcess()` now REFUSES to overwrite a real token with null.

**The one behaviour change, named rather than quietly rewritten:** B2 in the suite asserted
`failureKind:'server-restart-orphan-alive'` on a live orphan. It now asserts adoption. That was
correct for step 1 (a blocking dispatch's result died with its socket) and is wrong for step 2 (a
background lane's result lands in a file this store owns, so a new server can still collect it, and
cutting destroys a live fan-out on every restart). `B2b` was added as the guard: no token proof ⇒
still cut. B3's `leftRunning === 1` became a per-record assertion, because B2 now leaves an adopted
row behind and the bare count was measuring the previous test.

**Phase 3 — written:** `src/server/lane-drain.ts` (`sweep`, `groupTerminal`, `pending`, `process`,
`acknowledge`), non-blocking `op:'start'` in `dispatch-broker.ts`, `/api/lanes/{pending,process,
ack,dismiss}` in `index.ts`, `#railPending` + `renderPending`/`refreshPending`/`processPending` in
`public/app.js`, `pendingLanes`/`processLanes`/`ackLanes`/`dismissPendingLanes` in
`public/lib/api.js`.

**Scope fork, recorded as decided:** only BACKGROUND lanes become Orchard-owned. In-turn helpers
stay on the harness path, because owning them costs the synchronous await that delivers the free
half of the win — a blocking dispatch's result already arrives inside the turn that asked for it, at
zero wakes, and routing it through the ledger + rail would turn a free delivery into a click.
`op:'dispatch'` is therefore untouched; `op:'start'` is the new path and refuses `ack` outright
(nothing is sent on that socket to acknowledge).

**Non-blocking dispatch ships WITH the drain, never before it** — the plan's headline risk. `start`
alone makes a fan-out strictly worse: nothing returns in-turn and every result costs a wake plus a
manual click. Both are in this one change.

```
$ npx tsx scripts/verify-lane-ledger.mjs   → RESULT 63 PASS / 0 FAIL  (was 62; B2 rewritten, B2b new)
$ npm run gate                             → GATE: PASS (exit 0)
```

### 2026-09-19 — step-2 build lane (CHECKPOINT 3 of 3: demonstrated end to end, in the browser, with real output)

**THE HEADLINE, MEASURED.** A real 3-lane background fan-out through the real broker socket,
collected by ONE drain:

```
$ npx tsx scripts/verify-arch-017-drain.mjs
      observed frames from the first start: [{"op":"started","ok":true,"laneId":"lane-mu8dmkz7-i3gkus",
        "pid":244154,"groupId":"g-fanout-1","groupOpen":true,"groupCloseDeadline":1789823498227,…}]
      observed elapsed ms for all three starts: 15          ← the slow child sleeps 2500ms
      observed pending items for this group (in flight): 3 × kind=lane, ready=false
      observed groupTerminal: {"terminal":true,"why":"all 3 member(s) are terminal and the group is closed"}
      observed pending items: [{"id":"group:g-fanout-1","kind":"group","ready":true,"lanes":3}]
      observed ONE drain returned: {"itemIds":["group:g-fanout-1"],"lanes":3,"bytes":1082,"skipped":0}
      observed disk after the real receipt: all 3 acknowledged, by "group-settle", heldReason null
RESULT 13 PASS / 0 FAIL
$ npx tsx scripts/verify-arch-017-drain.mjs --must-fail-proof   → RESULT 5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs                        → RESULT 63 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof      → 8/8 legs PASS
$ npm run gate                                                  → GATE: PASS (exit 0)
$ npm run board:check                                           → DRIFT — 5 problem(s) (the known pre-existing set)
```

The escape hatch, same run: E6 pulls one finished lane while its sibling is still `running` —
`{"acknowledged":true,"by":"user"}` on the pulled lane, `{"state":"running"}` on the sibling.

**THE BROWSER, because a correct backend with a broken render is still broken.** Real headless
Chromium via `mcp__playwright__*` against a scratch server (free ephemeral port, scratch dataDir,
`scripts/scratch-a17-rail-fixture.mjs` — SYNTHETIC, and deliberately a busy-afternoon state rather
than the minimal one: a complete 3-lane group, a complete 2-lane group with a FAILED member, an
in-flight group, a 40-minute-starved result, plus an already-collected lane and a dismissed lane
that must NOT appear. 12 records → 5 rail items; the two noise records were correctly excluded).

- `#railPending` rendered 5 rows with the right shapes: `📦 3 lanes — cross-provider review lane 1
  — 3 results ready`, `⏳ explore lane 2 — ready, waiting on 1 more`, `📥 quick answer,
  long-starved — 1 result ready`.
- Clicked **process** on the 3-lane group: the row left the rail, headline went `6 results ready in
  3 items` → `3 results ready in 2 items`, and the ledger on disk showed all three
  `acknowledgedAt` set, `handoffBytes:793`, `deliveryProof:7a0c86f7c6ac0cb1…` — a digest the
  BROWSER computed with SubtleCrypto over the bytes it actually received.
- Clicked **process now** on an in-flight lane: that row left, its sibling stayed.
- Screenshots: `.playwright-mcp/arch-017-pending-rail-before.png`,
  `…-after.png`, `…-5items.png`.

**Three defects found by verification, not by review — each fixed, each was live:**

1. **An open group could be created with NO close deadline.** The broker declared `groupOpen:true`
   and passed no deadline; the record came back `{groupOpen:true, groupCloseDeadline:null}` — a
   group NOTHING could ever close, since both the sweep and the boot re-arm key off that number.
   Hazard 3 reopened by an omission at one call site. `recordDispatch` now defaults the deadline
   whenever `groupOpen` is true, so the hazard is unreachable by construction.
2. **The possession proof was shape-checked and never compared.** Measured: `'f'.repeat(64)`
   acknowledged all three lanes of a real drain. `acknowledge()` had no memory of what `process()`
   sent. The expected digest is now PERSISTED in `handoffEvidence` (`sha256=<hex>`) and compared,
   with the byte count, so the check survives a restart. This is the round-4/5/6/7 vacuity class
   reintroduced one layer up, and it is why `process`/`acknowledge` are two passes now.
3. **`import … from './lanes.js'` in `lane-drain.ts` typechecked and would not RUN.** The server is
   plain `node` with type stripping — no bundler, no path rewrite — so the scratch server refused
   to boot. Found only because the browser leg exists; `tsc` and `tsx` both accepted it.

**A fourth, found by LOOKING at the render rather than asserting on the DOM.** With five items the
section (`.rail-sub`, `max-height:158px; overflow:auto`) scrolled the fifth row out of sight while
the headline read `6 results ready in 3 items` — the rows you could not see were also not counted,
so the surface under-reported what was waiting. The headline now reads
`6 results ready in 3 items · 2 still finishing` (verified on screen), and the totals add up to the
row count. **Known limitation, not fixed:** the section still scrolls past ~4 rows. It is the shared
rail-section style (`railStopped` behaves identically), so it is consistent rather than new, and the
honest headline is what tells the user there is more.

**Also measured, and it is a real constraint on this feature:** `PROJECT_CAP` is 2, and a
BACKGROUND lane holds its slot for its whole runtime — a far longer occupancy than the blocking
path. A naive back-to-back fan-out of three had its third start refused
(`op:'result', failureKind:'project-concurrency-cap', laneId:null`). The refusal is loud and leaves
NO ledger row (asserted in E1b — a phantom member would hold its group open forever), and the
dispatcher stages members into the OPEN group as slots free, which is exactly what `groupOpen` and
`pending` are for. **Whether the cap should rise for background lanes is a product decision and is
NOT taken here.**

#### What I could not test, stated plainly
- **No real provider turn.** Every lane is `scripts/fixtures/fake-dispatch-lane.mjs`. The drain
  never sees a real model's output, only a real child's bytes through the real socket.
- **The rail fixture is synthetic.** There was no live fan-out to point a browser at. It is
  realistic-state, not real.
- **No multi-hour or multi-day run.** `HELD_STARVATION_MS` and `GROUP_CLOSE_TTL_MS` are exercised by
  injecting a clock (`now`), never by waiting 20 or 30 real minutes.
- **No restart of the LIVE server mid-group.** Adoption and deadline re-arm are proven against the
  real `reconcileBoot` over real records (B2, B2b, H2, must-FAIL leg 4), not by killing the
  production server, which this lane must never touch.
- **Concurrent drains from two browser tabs** were not tested. `markHandoff` is first-wins and
  `markAcknowledged` is first-wins, so the second should be a no-op, but that is reasoning, not a
  measurement.
- **No visual review by a second pair of eyes**, and no check of the other `scripts/qa/*.spec.ts`
  browser suites against this change.

#### Verification class
**Session-lifecycle + regression-prone** (`lanes.ts` has a seven-round regression history, and this
round already re-broke hazard 3 and re-introduced a vacuous proof). An independent clean-room
verify pass IS warranted before this is called VERIFIED — generation must not be its own only
verifier. `regressed-from:` none; step 1's B2 behaviour change is a deliberate supersession, not a
regression, and is argued above.

- **Changed (all unstaged, no git writes):** `src/server/lanes.ts`, `src/server/lane-drain.ts`
  (new), `src/server/dispatch-broker.ts`, `src/server/index.ts`, `public/app.js`,
  `public/index.html`, `public/lib/api.js`, `scripts/verify-lane-ledger.mjs`,
  `scripts/verify-arch-017-drain.mjs` (new), `scripts/scratch-a17-rail-fixture.mjs` (new).

### 2026-09-19 — step-2 fix lane, round 2 (CHECKPOINT 1: the verifier's five, REPRODUCED before any change)

Independent verify returned **LAND WITH FIXES** (`docs/bugs/_scratch-arch017-step2-verify.md`). I
reproduced the two load-bearing findings against the real code before touching anything. **I am not
refuting any of the five — all five are real, and two of them are mine from earlier this build.**

**§2 — a lost ack strands a lane FOREVER.** `npx tsx /tmp/a17atk/atk1.mjs`:

```
observed early drain A: {"lanes":["lane-mu8ghaq9-0kgiaz"],"bytes":57}
observed A handoff on disk: {"bytes":57,"ev":"group-settle drain sha256=c89d787e1a631f"}
observed group drain acknowledged: ["lane-mu8ghaqb-q831vx"]
observed group drain REFUSED: [c89d787e1a6…, 056daf22637…]      ← the two early-pulled lanes
observed retry 0/1/2: {"acknowledged":0,"refused":2}             ← forever
observed FINAL rail: [{"id":"group:g-atk1","lanes":[2 ids],"ready":true}]
ATTACK 1 RESULT: BROKEN — results permanently unacknowledgeable
```

Mechanism, confirmed by reading: `process()` computes the digest over the CURRENT SELECTION, but
`markHandoff()` is first-handoff-wins and keeps the ORIGINAL `handoffBytes`/`handoffEvidence`. Any
re-drain in a different selection can therefore never be acknowledged. This breaks the exact
contract `lane-drain.ts`'s own header advertises ("re-offered, not lost"), so the header was a lie
about its own code.

**§3 — my E5 does not assert its own headline.** Reproduced in a `/tmp` sandbox (`tar`-exported
sources, `node_modules` symlinked; the repo was not modified):

```
M1 = acknowledge()'s `if (!got || got !== want || …)` → `if (false)`; `if (!want)` → `if (false && !want)`
      observed acknowledge with a forged digest: {"acknowledged":[3 lanes],"refused":[]}
      observed after the forged receipt: [{"acknowledged":true},×3]
PASS E5 — ONE drain carries all three results, and only a real receipt acknowledges them
RESULT 13 PASS / 0 FAIL
```

E5 PRINTS the forgery being accepted and still reports PASS. This is precisely the vacuity class
that cost step 1 five rounds, committed by me in the round that claimed to have fixed it — the
`show()` call made the defect visible to a reader and invisible to the suite. Observation is not
assertion.

§4 (12-row cap, 5 of 17 items unrenderable), §5 (bundle goes only to `console.info`), §6 ("ready,
waiting on 0 more") and §7 (non-writer server: HTTP 200, `lanes:[]`, client ignores `skipped`, row
silently returns) are accepted as reported; §4/§5/§7 I will re-prove in a real browser rather than
take on trust.

### 2026-09-19 — step-2 fix lane, round 2 (CHECKPOINT 2: §2 and §3 fixed, and the mutation check is now standing)

**§2 FIXED — `lanes.restampHandoff()`.** The drain now RE-stamps the expected digest on a re-send
instead of `markHandoff`'s first-wins. `handoffAt` deliberately does not move ("when Orchard first
handed this over" is a fact); `handoffBytes`/`handoffEvidence` do, because they describe the send a
receipt will be checked against, and the only send that can still be acknowledged is the most recent
one. Overwriting loses nothing: a send being re-offered is by definition a send that reached nobody.
Re-stamping an ALREADY-ACKNOWLEDGED record is refused — it would invalidate the receipt that
collected it.

**Must-FAIL-before proof, not a claim.** `R1` reproduces the verifier's attack (two early pulls,
both acks lost, group completes and collapses to one item). Against the PRE-FIX code, in a /tmp
sandbox with only `restampHandoff`→`markHandoff` reverted:

```
FAIL R1: no lane may be stranded by an earlier lost ack; refused:
  [{"id":"…vdcwgu","why":"expected sha256 22bfb0f0f2a1e4fb… over 74 bytes, got 675d73394e1f4cf1… over 233"},
   {"id":"…80gzug","why":"expected sha256 d99ed2b8ed2f72db… over 74 bytes, got 675d73394e1f4cf1… over 233"}]
RESULT 14 PASS / 1 FAIL
```
After the fix: `PASS R1` — 3 acknowledged, 0 refused, item leaves the rail. `R2` additionally pins
the two facts above (first `handoffAt` preserved; collected lane refuses a re-stamp).

**§3 FIXED — E5 now ASSERTS the refusal** (forged digest ⇒ 0 acknowledged, N refused by name, the
DISK unchanged, and each lane records why it is still held). The verifier's diagnosis was exact and
the lesson is worth stating plainly: the `show()` call made the defect visible to a human reading
the log and invisible to the suite. **Observation is not assertion.**

**The verifier's technique is now a standing check: `scripts/verify-arch-017-mutation.mjs`.** Nine
mutants, each REMOVING one named property, each graded against the suite that owns it, in the
suites' DEFAULT mode (the mode people actually run — a property guarded only behind
`--must-fail-proof` is a property whose green run is not evidence).

**It immediately found a SECOND instance of the same class, which the verifier had not.** M8
(`status === 'alive' || status === 'pid-reused'` in the adopt branch) survived BOTH default suites:

```
SURVIVED M8 — adoption requires the argv TOKEN, not just a live pid   → 63 PASS / 0 FAIL
```

Cause: `B2b` used `pid: 999999`, which `process.kill` reports ESRCH, so `liveWithToken` returned
`'dead'` and the `'pid-reused'` branch — the only one that distinguishes "alive" from "alive AND
still ours" — was never reached. The guard existed only in the drain suite's `--must-fail-proof`
leg 4. `B2b` now carries a LIVE pid (this process) with a token its argv does not contain, and
asserts the naive rule would have fired. **So: 2 assertions died under the mutation check —
E5 (verifier-found) and B2b (found here) — and both are fixed.**

```
$ node scripts/verify-arch-017-mutation.mjs
KILLED M1 [drain] killed by: E5          KILLED M6 [drain] killed by: R1
KILLED M2 [drain] killed by: E2          KILLED M7 [drain] killed by: H3
KILLED M3 [drain] killed by: H1          KILLED M8 [ledger] killed by: B2b
KILLED M4 [drain] killed by: H4          KILLED M9 [ledger] killed by: S10
KILLED M5 [drain] killed by: E3, E6, R1, H4
RESULT 9 killed / 0 SURVIVED
```

### 2026-09-19 — step-2 fix lane, round 2 (CHECKPOINT 3: §4/§5/§6/§7 fixed and re-proven in a real browser)

All four UI/server findings fixed and re-proven in headless Chromium against a scratch server, on a
**17-item fixture rebuilt to the verifier's own shape** (11 extra lone lanes added to
`scripts/scratch-a17-rail-fixture.mjs`) — not on the tidy 5-item state that let the bug through.

**§7 — a failing drain is no longer silent.** Server: `/api/lanes/process` now answers **503** when
nothing could be handed over, carrying the store's own words. Client: every failure path in
`processPending`/`dismissPending` now sets `state.pendingActionProblem`, rendered as a `⚠` row above
the list with an `ok` dismiss. Reproduced the verifier's exact scenario — a SECOND server booted
against the same scratch data dir, losing the writer claim:

```
[orchard] lane ledger: another process holds the writer claim for /tmp/a17-rail-data-m7fxyj (EADDRINUSE)
$ curl -X POST …/api/lanes/process -d '{"ids":["group:g-build-2"]}'   → HTTP 503
browser: problemShown "could not collect: nothing could be handed over: this process is NOT the lane
          ledger's writer for /tmp/a17-rail-data-m7fxyj … Refusing to write: the ledger has exactly one wr…"
          rowCameBack: true   anyVisibleWarning: true
```
Before: HTTP 200, `lanes:[]`, a 400 from `ack`, an uncaught throw, and nothing on screen.
Screenshot: `.playwright-mcp/arch-017-r2-nonwriter-visible.png`.

**§4 — no row is unreachable.** The hard `break` at 12 is now a cap with a `+N more` toggle:

```
before click: apiItems 16, domRows 12, missing [g-solo-8, g-solo-9, g-solo-10, lane-fixture-08]
              moreRowText "+4more — show all"
after  click: apiItems 16, domRows 16, missing []   rowsWithBothButtons 16
```
Every item now has its own `process` and `dismiss`. (This mattered precisely because `process all`
reads the list, not the DOM — the user was acting on more than they could see.)

**§5 — the collected bundle has a real destination.** It went only to `console.info`. It now goes
into the MESSAGE COMPOSER, which is the concrete form of this ticket's whole goal: N results land in
your draft and you send ONCE. Measured after clicking process on the 3-lane group:

```
confirmRow "collected 3 results → added to your message"
bundleInComposer true   bundleInPre true   composerChars 827
composerHead "Results collected by Orchard (3 lanes, one drain):\n── cross-provider review lane 1 …"
```
Screenshot: `.playwright-mcp/arch-017-r2-bundle-and-more.png`. **A render defect I caused and then
caught by looking:** rendered above the list, the bundle's `<pre>` filled the section's entire 158px
and pushed all sixteen actionable rows out of view — collecting one item hid everything you had not
dealt with. Moved below the rows and capped at 72px; the composer holds the readable copy.

**§6 — "ready, waiting on 0 more" is gone.** An open-but-all-settled group now renders
`— ready, group still open`, which is the true reason. Browser check: `incoherentStrings: []`.

**Final numbers.**

```
$ npx tsx scripts/verify-arch-017-drain.mjs                  → 15 PASS / 0 FAIL   (was 13; +R1, +R2)
$ npx tsx scripts/verify-arch-017-drain.mjs --must-fail-proof→  5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs                     → 63 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof   →  8/8 legs PASS, exit 0
$ node scripts/verify-arch-017-mutation.mjs                  →  9 killed / 0 SURVIVED, exit 0
$ npm run gate                                               → GATE: PASS (exit 0)
$ npm run board:check                                        → DRIFT — 5 (BUG-169, FEAT-129/131/132, ARCH-007)
```

#### Does step 2 owe the "one wakeup into a live session" surface?
The verifier correctly noted that end-to-end "one wakeup" is not observable, because no consumer
surface existed. **It does owe it, and §5's fix is it** — the drain now deposits N results into the
composer as one message, so the fan-out costs one send instead of N. What is still NOT proven is
that send actually happening into a live session with a real model, because that needs a real
provider turn, which nothing in this lane spends.

#### Still unverified, carried forward unchanged
A real spawned-child fan-out beyond E1–E6; real wall-clock 20/30-minute TTLs (injected `now` only);
torn cross-process ledger writes (prevented by the kernel writer claim — only the refusal side is
observable); non-Linux socket staleness; a real machine reboot across `reconcileBoot`; and the live
send described above. Also not re-run: the other `scripts/qa/*.spec.ts` browser suites.

### 2026-09-19 — step-2 fix lane, round 3 (CHECKPOINT 1: the round-2 regression, D4, and which side was wrong)

**What I was handed.** Round 2 finished two of its three fixes and recorded none of them, so
this round began by reading the tree rather than a report. Found: fix 1 (the `heldReason`
lifecycle, generalised into `clearHeldReason()` at `src/server/lanes.ts`) landed; fix 2 (the
untruncated 503 reason in the rail, `public/app.js` + `public/styles.css`) landed; fix 3
(extending the mutation set past `lane-drain.ts`/`lanes.ts`) did not.

**And found fix 1 had broken the ledger suite.** Measured before touching anything:

```
$ npx tsx scripts/verify-lane-ledger.mjs                      → 62 PASS / 1 FAIL  (exit 1)
FAIL D4 — no receipt requested (an older peer) means no stamp, and the dispatch still worked:
     VACUOUS: this lane is held but the receipt rule recorded NO refusal reason —
     nothing proves a receipt ever reached the broker
$ npx tsx scripts/verify-arch-017-drain.mjs                   → 16 PASS / 0 FAIL  (exit 0)
```

`regressed-from:` the round-2 fix-1 generalisation in this ticket — which is itself
`regressed-from:` the round-7 finding-1a fix. Third time this one string has been got wrong.

**Which side was wrong: the clearing, not the gate.** The charter's instruction was explicit
that the anti-vacuity gate must not be blunted to clear a red, and it should not have been —
but the interesting part is that the gate was not merely defensible here, it was *correct*, on
two independent grounds:

1. **A handoff resolves nothing.** Every other writer on the clearing list either ends the
   record's heldness (`dismiss`, `markAcknowledged`), restarts it (`promotePending`), moves it
   to a terminal state decided afresh (`settle`, `reconcile`), or changes the bytes a receipt
   will be checked against (`restampHandoff`). `markHandoff` does none of those — its own
   doc-comment says *"It grants nothing: a handed-off record with no delivery proof is still
   HELD"*. So the reason still describes the record's CURRENT state, which is precisely the
   condition the lifecycle invariant tests. Clearing it produces a record that is held with no
   explanation: round-7 finding 1b, reintroduced from the other end.
2. **"Earlier" was not even true on the wire.** In the no-ack path of `terminal()`
   (`src/server/dispatch-broker.ts:178-183`), the broker calls `socket.end(line, cb)` and then
   runs `onOutcome(false, 'the peer did not request a delivery receipt …')` **synchronously**,
   while `cb` — the thing that calls `markHandoff` — fires **later**, on the write callback. The
   reason `markHandoff` was wiping was therefore not a stale verdict from a previous cycle; it
   was the receipt rule's verdict about *this very send*, written microseconds earlier. The
   justification comment ("a fresh send makes any earlier refusal reason stale") described an
   ordering that does not occur.

**The change.** `markHandoff()` no longer calls `clearHeldReason()`; the receipt rule
(`markHeldReason` / `markAcknowledged`) owns that string and `markHandoff` records Orchard's own
half of the fact and touches nothing else. The lifecycle doc-block on `clearHeldReason` now
carries `markHandoff` as the writer that deliberately is NOT on the list, with both grounds and
the measured failure, so the next tidy-up does not re-add it from the comment alone.

**Test that fails before and passes after.** `R3` in `scripts/verify-arch-017-drain.mjs` asserted
the old (wrong) behaviour, so it was removed from the writer list rather than left to pin a
defect. Its replacement is a new check, `R3b`, which pins both grounds — including a replay of the
real broker ORDER (end-with-callback registered, refusal written synchronously, handoff landing on
the flush afterwards) so a future regression fails here and not only three hundred lines away in
another suite:

```
MUST-FAIL PROBE (the round-2 clear temporarily restored in markHandoff):
$ npx tsx scripts/verify-arch-017-drain.mjs                   → 16 PASS / 1 FAIL  (exit 1)
FAIL R3b — markHandoff LEAVES the reason standing …:
     VACUOUS-BY-SILENCE: the record is held and nothing on disk says why —
     round-7 finding 1b, reintroduced by the clearing rule
     observed after markHandoff: {"heldReason":"(NONE)","handoffAt":true,"held":true}

WITH THE FIX:
$ npx tsx scripts/verify-arch-017-drain.mjs                   → 17 PASS / 0 FAIL  (exit 0)
$ npx tsx scripts/verify-lane-ledger.mjs                      → 63 PASS / 0 FAIL  (exit 0)
PASS D4 …  observed refused because: the peer did not request a delivery receipt (no "ack" in
     its request), so nothing proves it holds the result — the record stays held rather than
     claiming a delivery
```

The mutation numbers are handled in checkpoint 2: they are not trustworthy as round 2 left them.

### 2026-09-19 — step-2 fix lane, round 3 (CHECKPOINT 2: the mutation numbers were not trustworthy, and what they are now)

**The reported `9 killed / 0 survived` was partly false, and the harness could not tell.**
It graded a mutant purely on `run.status !== 0`. That is sound only while the suite is green to
start with, and it was not: D4 was already red, and the harness credited M9 *and* M8 as "killed by
D4". M9 deletes the exact line whose absence D4 was already complaining about — so its only killer
was a pre-existing failure, and it was a **survivor being reported as a kill**, by the one check
whose whole purpose is to stop false assurance.

**Harness fix (`scripts/verify-arch-017-mutation.mjs`).** One baseline pass per suite, run
UNMUTATED *in a sandbox*, now decides two things at once — the round-2 lane had added the first,
this round added the second, and running both meant running every suite twice:

- a suite that cannot run in the sandbox at all (measured earlier: five UI/API mutants "KILLED" by
  a sandbox missing `docs/`, where the server never booted) **aborts the run**, and
- a suite that is red before any mutation **aborts the run** too, naming what was already failing;
- and a mutant is credited only with checks the baseline **passes** (`newlyFailing`), with any
  pre-existing failure printed as `(pre-existing, NOT credited: …)`.

A mutation score over a broken suite is not a number worth having, so the harness now refuses to
print one (exit 2) instead of printing a comforting one.

**Numbers, honestly, before and after.**

| run | set | reported | true |
|---|---|---|---|
| round 2, as left in the tree | 9 mutants, `lane-drain.ts` + `lanes.ts` only | 9 killed / 0 survived | **8 killed / 1 survived** — M9's only killer was the pre-existing D4 failure |
| an independent reviewer's own mutants over the API/UI paths | 8 | — | 3 killed / **5 survived** (503 guard, CAP/`+N more`, composer append, warn row, byte-count arm) |
| round 3, first full run (18 mutants, baseline-guarded) | 18 | 17 killed / **1 survived** | M17 — the receipt BYTE COUNT arm |
| round 3, after `R4` | 18 | see checkpoint 3 | — |

**The set now reaches five files, not two.** `src/server/lane-drain.ts`, `src/server/lanes.ts`,
`src/server/index.ts`, `public/app.js`, `public/styles.css` — graded against three suites
(`verify-arch-017-drain.mjs`, `verify-lane-ledger.mjs`, and `verify-arch-017-rail.mjs`, which
drives the REAL server over HTTP and the REAL `public/app.js` in a REAL headless browser). All
five of the reviewer's survivors are now covered and killed: M10 the 503 guard (killed by A1/A2/A3),
M11 the CAP and `+N more` (B1), M12 the composer append (B3), M13 the ⚠ row (harness), M14 the
wrap (B5), M17 the byte count (R4).

**Two genuine holes the run found, beyond the arithmetic.**

1. **M17 was mis-filed AND real.** It edits `lane-drain.ts` but was graded against the ledger suite,
   which does not load that file — it reported `RESULT 63 PASS / 0 FAIL` and SURVIVED. Re-filing it
   to the drain suite did not save it either: the byte-count arm was asserted **only** in
   `--must-fail-proof` leg 2, the optional mode nobody runs by reflex. That is precisely the
   "green run is not evidence" hole this harness exists to find. `R4` now asserts it in the DEFAULT
   run over five bad counts (short, long, zero, `NaN`, a string) against a CORRECT digest, and
   checks the honest receipt is still accepted so the test cannot pass by refusing everything.
2. **M18 — a mutant that ADDS a line.** Every other mutant deletes a property. The `heldReason`
   regression this round fixed was caused by a line being *added*, and a delete-only set could
   never have caught it. M18 re-inserts `clearHeldReason(rec)` into `markHandoff` and must be
   killed by `R3b`.

### 2026-09-19 — step-2 fix lane, round 3 (CHECKPOINT 3: the warn row looked at, final numbers, and what is still untested)

**The ⚠ row, driven by hand in a real browser (`mcp__playwright__*`), not only asserted.**
Round 2's screenshot was overwritten in place, which makes before/after unprovable, so this round
stood the real fixture up (`scripts/scratch-a17-r3-warnrow-hold.mjs` — 18 lanes, past the 12-row
cap, two servers on one data dir so the writer claim is genuinely unavailable and
`/api/lanes/process` really answers 503), clicked `process` in the rail, and saved NEWLY NAMED
files:

- `.playwright-mcp/arch-017-r3-warnrow-mcp-1280x900.png` — the whole app at 1280×900
- `.playwright-mcp/arch-017-r3-warnrow-mcp-rail-zoom.png` — the rail, before the line-height fix
- `.playwright-mcp/arch-017-r3-warnrow-mcp-rail-zoom-after.png` — the rail, after

Measured in the page: `{textLen:1819, whiteSpace:"normal", scrollWidth:178, clientWidth:178,
horizontallyClipped:false, lines:62, hintVisible:true}`. The round-2 fix holds — the recovery
sentence is bold, front-loaded and **fully readable without hovering or scrolling**, and the
horizontal clip (`scrollWidth:1195` vs `clientWidth:210`, ~38 of 1115 characters) is gone.

**And looking at it found something the assertions could not.** The cap was `max-height: 132px`
against a `16.675px` line box — not a whole number of lines, so the block sliced its 8th line in
half and the half-glyphs sat immediately above the next rail row. Now expressed as
`max-height: 11.6em` (8 × the 1.45 line-height), which clips on a line boundary at any font size.
Honest about the size of this: the slice went from ~1.4px to ~0.4px of a line
(`clientHeight/lineHeight` 7.916 → 7.976), and the boxes do NOT overlap either way
(`btBottom:221`, `nextTop:225`). **Residual, recorded rather than claimed fixed:** the detail text
is 62 lines in a 178×133 box, so ~8 lines are visible and the rest needs an inner scroll. The
instruction the user must act on is in those 8; the diagnostic tail is not.

**Final numbers, all re-run after every change in this round.**

```
$ npx tsx scripts/verify-arch-017-drain.mjs                    → 19 PASS / 0 FAIL   (+R3b, +R4)
$ npx tsx scripts/verify-arch-017-drain.mjs --must-fail-proof  →  5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs                       → 63 PASS / 0 FAIL   (D4 green again)
$ npx tsx scripts/verify-lane-ledger.mjs --must-fail-proof     →  8/8 legs PASS, exit 0
$ npx tsx scripts/verify-arch-017-rail.mjs                     → 15 PASS / 0 FAIL
$ npx tsx scripts/verify-arch-017-rail.mjs --must-fail-proof   →  5 PASS / 0 FAIL
$ node scripts/verify-arch-017-mutation.mjs                    → 18 killed / 0 SURVIVED, exit 0
      BASELINE OK verify-arch-017-drain.mjs / verify-lane-ledger.mjs / verify-arch-017-rail.mjs
$ npm run gate                                                 → GATE: PASS (exit 0)
$ npm run board:check                                          → DRIFT — 5 (BUG-169, FEAT-129/131/132,
                                                                  ARCH-007) — all pre-existing, none this ticket
```

**Lane-hygiene note for whoever reads this next.** A `verify-arch-017-mutation.mjs` run from the
previous round was still alive in the process table when this lane started (its lane had already
reported), and a second lane was editing `scripts/verify-arch-017-rail.mjs` and the drain suite
concurrently with this one — the drain baseline moved from 18 to 19 PASS mid-run for that reason.
Nothing of this round's was clobbered (re-checked file by file at the end), but the numbers above
are a reading of a tree two lanes were writing to.

#### STILL UNTESTED — the standing list, stated so nobody has to infer it

Carried forward and added to. None of these is covered by any suite in this ticket:

- **A light / second theme.** Every browser leg runs one theme; the ⚠ row's contrast, the
  `.fix-first` emphasis and the rail row separation are unmeasured in any other.
- **A writer claim lost between pass 1 and pass 2 of a single `process()` call.** The 503 guard is
  proven for a server that never had the claim, not for one that loses it mid-drain.
- **A genuinely partial `skipped[]`** — some lanes handed over and some skipped in the same bundle.
  Both suites test all-or-nothing.
- **A real spawned-child fan-out beyond E1–E6**, and beyond `PROJECT_CAP`'s staging shape.
- **Wall-clock TTLs.** The 20/30-minute group deadlines and `HELD_STARVATION_MS` are exercised with
  an injected `now`, never by real elapsed time.
- **Torn cross-process ledger writes.** Prevented by the kernel writer claim by construction, so
  only the refusal side is observable from a test.
- **Non-Linux socket staleness** (the `EADDRINUSE`/unlink dance is Linux-only here).
- **A real machine reboot across `reconcileBoot`** — simulated by killing a server, never by a boot.
- **A live send with a real model.** The composer append is proven to put the bundle in the box; that
  the send then costs ONE wakeup instead of N is the headline claim and it is still unmeasured,
  because it needs a real provider turn that no lane in this ticket has spent.

Because this round repaired a regression introduced by the previous round's fix, on a file with a
three-round history of getting this exact string wrong, a **third independent clean-room pass**
(`scripts/independent-verify.mjs`, or a second fresh-context agent) is warranted before VERIFIED —
generation must not be its own only verifier, and here it demonstrably was not enough twice.

### 2026-09-19 — step-2 fix lane, round 3 (independent verify round 2: all three closed)

Verify round 2 (`docs/bugs/_scratch-arch017-step2-verify-r2.md`) returned **LAND WITH FIXES** and
held all five round-2 fixes under direct attack — `restampHandoff` vs a stale ack, a double
re-stamp, a post-collection re-stamp, 4× parallel process+ack; the 503 path across process /
process-all / dismiss / ack; the composer at 60 KB, against an existing draft, with hostile HTML and
two drains in one tick; `+N more` over a 19-item fixture. **Nothing was refuted; all three findings
are real and are fixed.**

**§4a — `heldReason` survived `restampHandoff`.** Reproduced first (`npx tsx /tmp/a17v/atk1.mjs`):

```
heldReason AFTER a successful re-send: the acknowledgement did not prove possession of what was
  sent: expected sha256 b139afe4fa328f4d… over 116 bytes, got fff…
```
— a record naming an expected digest that was no longer expected. The charter said to check whether
any OTHER writer had the gap rather than fix the one reported. **Four more did.** The rule is now a
function (`clearHeldReason`) called by `restampHandoff`, `dismiss`, `promotePending` and `settle`,
alongside `markAcknowledged` (round 7). `R3` tests the RULE across every writer and fails pre-fix
naming all five offenders:

```
observed writers leaving a stale reason: ["markHandoff left …","restampHandoff left …",
  "dismiss left …","settle left …","promotePending left …"]        FAIL R3   (pre-fix)
```

**And one of my five clears was WRONG, corrected in-tree with `R3b` pinning it.** Adding
`markHandoff` to the rule turned `D4` in the ledger suite red on the spot (62 PASS / 1 FAIL,
"VACUOUS: this lane is held but the receipt rule recorded NO refusal reason"). Both halves of my
reasoning were wrong: a handoff GRANTS NOTHING (`isHeld()` is still true after it, so the reason
still describes the current state), and "earlier" is false on the real wire — the no-ack broker path
runs the refusal SYNCHRONOUSLY while `markHandoff` fires later on the socket write callback, so the
reason being wiped was the verdict about that very send. `R3b` replays the real broker ordering, so
a future tidy-up that re-adds the clear fails next to the code rather than in another suite.
**Corrected audit: five writers clear, `markHandoff` deliberately does not.**

**§2a — the ⚠ row surfaced the error and clipped the instruction out of it.** Two compounding cuts:
`.slice(0, 220)` in `app.js` and `.bt`'s `white-space:nowrap; text-overflow:ellipsis` in a 210px
rail — the verifier measured ~38 of 1115 characters, recovery hover-only. Both gone: `.brow.problem
.bt` wraps, and the recovery sentence is LIFTED TO THE FRONT (`recoveryHint()`, conservative — it
returns a hint only when the text really contains an instruction and never paraphrases; the full
message renders underneath regardless). Measured in a real browser:

```
before: {clientWidth:210, scrollWidth:1195, approxVisibleChars:38, whiteSpace:"nowrap"}
after : {whiteSpace:"normal", clientWidth:178, scrollWidth:178, horizontallyClipped:false, lines:26,
         hintFrontLoaded:"If no other Orchard server should be running against this data dir, stop it;…"}
```
Screenshot `.playwright-mcp/arch-017-r3-warn-readable.png` — the instruction renders bold across
five lines with no hover.

**§1 — the mutation check was a true statement about two files.** `scripts/verify-arch-017-rail.mjs`
(new) drives the REAL server over HTTP and the REAL `public/app.js` in REAL headless Chromium, on an
18-record fixture sized past the row cap: the 503 guard (A1-A4), `CAP`/`+N more` (B1-B2), the
composer append against a live draft (B3), the ⚠ row and its readability (B4-B5). The mutation set
grew 9 → 18 and now covers **`lane-drain.ts`, `lanes.ts`, `index.ts`, `app.js` and `styles.css`.**

**A false-kill I shipped and caught, worth more than the number it replaced.** The first extended
run reported M10-M14 `KILLED … killed by: harness` — the sandbox was missing `docs/`, so the server
never booted and the crash was counted as a kill. Five mutants "killed" by a sandbox that could not
start. The harness now runs each suite UNMUTATED first and ABORTS if the baseline is not green,
and the rail suite names its timeouts instead of falling through to the catch-all:

```
BASELINE OK  verify-arch-017-drain.mjs — RESULT 19 PASS / 0 FAIL
BASELINE OK  verify-lane-ledger.mjs    — RESULT 63 PASS / 0 FAIL
BASELINE OK  verify-arch-017-rail.mjs  — RESULT 15 PASS / 0 FAIL
RESULT 18 killed / 0 SURVIVED
```
`M17` (the byte-count arm, the verifier's X6) survived until `R4` was added: a receipt with the
GENUINE digest but a wrong byte count (+1, −1, 0, NaN, null) must be refused. Honest about severity,
per the verifier: `bytes` is a pure function of the bundle, so this is coverage, not exploitability
— its job is to stop the arm being deleted as dead weight.

```
$ npx tsx scripts/verify-arch-017-drain.mjs         → 19 PASS / 0 FAIL   (+R3, R3b, R4)
$ … --must-fail-proof                               →  5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs            → 63 PASS / 0 FAIL
$ … --must-fail-proof                               →  8/8 legs PASS
$ node scripts/verify-arch-017-rail.mjs             → 15 PASS / 0 FAIL   (new)
$ … --must-fail-proof                               →  5 PASS / 0 FAIL
$ node scripts/verify-arch-017-mutation.mjs         → 18 killed / 0 SURVIVED
$ npm run gate                                      → GATE: PASS (exit 0)
$ npm run board:check                               → DRIFT — 5 (BUG-169, FEAT-129/131/132, ARCH-007)
```

#### UNTESTED BY ANYONE, written down rather than left in prose
- **A light/second theme.** The dashboard's theme story was never established; glyph contrast
  (⚠/📦/⏳/📥) is unverified. The §2a clipping was geometry, so that fix is theme-independent.
- **A writer claim lost BETWEEN pass 1 and pass 2 of a single `process()` call.** The adjacent real
  states are covered (never had the claim; ack to a non-writer); this one needs a fault-injection
  point the code does not expose.
- **A genuinely partial `skipped[]`** (some lanes stamped, some not). `lanes.get()` and `pending()`
  read the same snapshot inside `process()` and held records are prune-exempt, so the branch is
  unreachable without patching. The client code for it is REVIEWED, NOT EXERCISED.
- **A real spawned-child fan-out beyond E1-E6**; **real wall-clock 20/30-minute TTLs** (injected
  `now` only); **torn cross-process ledger writes** (the kernel writer claim prevents them — only
  the refusal side is observable); **non-Linux socket staleness**; **a real machine reboot** across
  `reconcileBoot`; and **a live send with a real model** — the composer is the one-wakeup surface,
  but nothing here spends a provider turn to prove the send.
- Minor, accepted and not fixed: four concurrent acks each report success though one delivery
  happened (idempotent-by-design; disk is correct); an empty/already-collected drain returns 200
  with the sha of the empty string and the client says "still held", which is false in the
  already-collected case; and the `+N more` affordance itself sits below the rail's inner fold.

### 2026-09-19 — step-2 fix lane, round 4 (CHECKPOINT 1: verify round 3 reproduced; nothing refuted)

Third independent verify (`docs/bugs/_scratch-arch017-step2-verify-r3.md`) returned **LAND WITH
FIXES** — five items, none a data-loss or lifecycle defect. **All five reproduce; I refute none.**
It also corrected my own round-3 write-up: the `clearHeldReason` set is **four** call sites, not
five, and `reconcile` never called it (my entry implied otherwise). Correction accepted.

```
1. 503 body repeats one reason per lane
   $ curl -X POST …/api/lanes/process -d '{"all":true,…}'  → len 9820, 18 identical ~545-char copies
2. $ grep -oE "check(Async)?\('[A-Za-z0-9]+" scripts/verify-arch-017-drain.mjs | sort | uniq -c | awk '$1>1'
        2 check('R4          ← two checks, one property; 19/0 overstates by one
3. rail :268-269 compute clientHeight/scrollHeight; :285 `readable` never uses them
4. $ npx tsx /tmp/a17v/probe1.mjs
     P1 after refused ack: {"held":false,"dismissedAt":true,"heldReason":"the acknowledgement did not prove…"}
     P2 after ack        : {"state":"running","heldReason":"Orchard has no record of sending this result…"}
5. rail :183  `const preFixWouldSend200 = true;`  — a constant ANDed with shipped behaviour
```

**And the finding that matters most — the verifier's own mutants score 0 killed / 6 SURVIVED**
(`node /tmp/a17v/my-mutants.mjs`, baseline 15 PASS / 0 FAIL). V1 and V3 delete the exact round-3 CSS
being landed (`overflow:auto`, `max-height:11.6em`) and the rail suite stays green. This is the
round-2 defect one layer further on, and the harness's own header says so: "0 survived" was a true
statement about two files; **"18 killed / 0 survived" is a true statement about eighteen mutants I
thought of and a false impression about coverage.** A mutant set containing only my own guesses is
the same false assurance in a new place.

**`heldReason` HAS NO CONSUMER OUTSIDE THE SUITES — stated because it is worth knowing before
anyone builds on it.** `grep -rn heldReason src/server/*.ts public/app.js public/lib/*.js` returns
only `lanes.ts` and one doc-comment in `dispatch-broker.ts`. `pending()` never returns it and
`app.js` never renders it. So the invariant comment's justification ("the string a rail renders at
a user") is **aspirational, not true today**; the live hazard is confined to `heldBecause()` test
vacuity. Finding 4 is fixed anyway, and the comment is corrected rather than left overstating.

### 2026-09-19 — step-2 fix lane, round 4 (CHECKPOINT 2: all five closed, and the verifier's mutant set adopted)

**1. The 503 body repeated one reason per lane — FIXED** (`index.ts`, `[...new Set(...)]`). Every
lane in a refused drain fails for the SAME cause, so `skipped.map(s => s.why).join('; ')` emitted
the identical ~545-char message once per lane. Measured on the real non-writer server, `process all`
over 17 lanes:

```
before: 9,263 chars, 18 copies       after: 597 chars, 1 copy, `reasons:[1]`, 17 lanes still named
```
A second duplication I introduced and then caught in the browser: the front-loaded hint ALSO
remained in the body, so the row was 753 chars for a 597-char message. Removed by exact match only
(if the sentence is not found verbatim the full message renders unchanged — it can shorten, never
lose). **Rendered, in Brave, after clicking the primary `process all` button:**

```
textLen 615 (was 9820)   reasonCopies 1 (was 18)   hintCopies 1
visibleLines 8 of 22 → visibleFraction 0.364  (was 0.024 — a 15x improvement)
hintInVisibleBand true   overflowY auto   noSideClip true
```
Screenshot: `.playwright-mcp/arch-017-r4-503-deduped.png`. **Residual, stated not suppressed:** the
warn row still occupies ~72% of the rail's 198px viewport, and 14 of 22 lines need a scroll. The
box scrolls, nothing is lost, and the instruction is the visible part — but it is not fixed.

**2. Duplicate `R4` — DELETED** (`:588`; `:541` was a strict superset). `grep -oE "check(Async)?\('[A-Za-z0-9]+" | uniq -c`
now reports no duplicates, and the drain suite declares **18 distinct properties**, not 19. My
`19/0` headline last round overstated by one; the honest count with this round's additions is 19.

**3. `B5` asserted nothing vertically — FIXED.** It computed `clientHeight`/`scrollHeight` and never
used them, which is exactly the gap V1/V3 walked through. Four properties now, each naming a way the
text becomes unreadable: no side-clip, ≥3 lines actually shown, overflow reachable, and the
instruction inside the band visible WITHOUT scrolling.

**4. `markHeldReason()` had no state guard — FIXED**, and reproduced first via
`/tmp/a17v/probe1.mjs`. Round 3 fixed every writer that INVALIDATES a reason and left the one that
CREATES them guarded only on `acknowledgedAt`. It now refuses `dismissedAt` and
`running`/`pending`. `R3c` drives both routes through `drain.acknowledge()` — the real caller
reachable from `POST /api/lanes/ack` — rather than the store directly. R3's own fixture had to
change as a result: a not-yet-terminal record can no longer be given a reason through the API at
all, so the fixture now plants it straight into the ledger file, which is the only way such a record
can now arise (hand-edited, half-written, or an older build) and exactly what the clearers defend
against.

**5. Rail must-FAIL leg 1 could not fail — REPLACED.** It was `const preFixWouldSend200 = true`
ANDed with the shipped status. Both quantities are now MEASURED from the same live response: the
pre-fix length computed from the server's own `skipped[]`, against what actually came back
(`9,263 → 597, 15.5x`).

**THE MUTATION SCORE AGAINST THE VERIFIER'S OWN SET: 0 killed / 6 SURVIVED → 8 killed / 0 SURVIVED.**
Reproduced their 0/6 first (`node /tmp/a17v/my-mutants.mjs`). V1-V6 are now adopted verbatim into
the standing set, plus V7 (the dedupe) and V8 (the `markHeldReason` guard). **An outside set that
beat this check is precisely the set worth keeping permanently** — a mutant set containing only my
own guesses is the same false assurance in a new place, which is the third time that lesson has
landed on this ticket.

```
$ node scripts/verify-arch-017-mutation.mjs      → RESULT 26 killed / 0 SURVIVED
  BASELINE OK  drain 19/0 · ledger 63/0 · rail 21/0
  V1 KILLED by B5 · V2 KILLED by B5 · V3 KILLED by B5 · V4 KILLED by C1
  V5 KILLED by C3 · V6 KILLED by C4 · V7 KILLED by A5 · V8 KILLED by R3c
```

**The harness no longer voids a run on a flaky baseline.** `D7` in the ledger suite is a wall-clock
sweep and goes red under load; the verifier hit that and the whole check ABORTED, grading zero
mutants — a standing anti-vacuity check whose verdict depended on machine load, failing silently.
Now: one RETRY, then a named-failure baseline EXCLUDES those checks from kill credit and the run
CONTINUES; only a baseline with no named check (a true crash) aborts. Also added: `harness` alone
no longer counts as a kill — it is reported `CRASHED`, because a mutant that merely crashes the
suite would otherwise be credited with coverage it does not have. And V2 caught its own anchor going
stale when I edited the line it targets (`ERROR … the code moved`), which is the harness doing its
job — re-pointed.

Also confirmed for the record: `verify-arch-017-rail.mjs` uses **network interception**, not module
stubbing, for C3/C4. `api` is an ESM namespace object and is read-only, so assigning to it silently
does nothing — measured: the stub never ran and the real request went out, and the check failed for
the wrong reason before I noticed.

#### RESIDUAL — untested by anyone across all four rounds, and NOT claimed as done
- **Cross-machine stability of the mutation score.** It aborted once (loaded) and passed twice
  (idle) on ONE box. The retry + exclude logic should stop the abort, but that is reasoning; a
  slower or busier CI is unmeasured.
- **A real provider fan-out.** Every round used `fake-dispatch-lane.mjs` or hand-written ledgers.
  No real `claude`/`openai` child has ever been spawned through this path.
- **The `dismiss`-races-`drain` window through HTTP timing.** The store now refuses the bad write
  (R3c), but the two have never been raced concurrently against one lane id over the wire.
- **Other browsers and viewports.** Brave at 1280x900 only. The `11.6em` cap is line-height
  relative so it should hold, but "should" is not a measurement.
- **`--must-fail-proof` mutation mode.** Only the default mode is graded.
- **A genuinely partial `skipped[]` from the server** (some lanes stamped, some not) — unreachable
  without patching, so C3 drives the client path with an intercepted response instead.
- **A writer claim lost mid-`process()`**, between its two passes — needs a fault-injection point
  the code does not expose.
- **Real wall-clock TTLs** (20/30 min), **torn cross-process ledger writes**, **non-Linux socket
  staleness**, **a real machine reboot** across `reconcileBoot`, and **a live send with a real
  model** — the composer is the one-wakeup surface, but no round has proven the send itself.
- Minor, accepted, unfixed: the warn row occupies ~72% of the rail viewport (14 of 22 lines need a
  scroll); four concurrent acks each report success though one delivery happened; an
  already-collected drain returns 200 and the client says "still held", which is false in that
  case; and `+4more` renders without a space between its two spans.

### 2026-09-19 — step-2 fix lane, round 5: the FIRST CROSS-PROVIDER review found five defects three same-family rounds missed

**This is the finding that matters more than the five.** Rounds 1-3 of independent verify were
same-family and passed all of this; a cross-provider reviewer broke five properties in minutes by
extracting the production functions and asserting against temporary JSON **on disk**. That is the
pattern this ticket's own ledger showed seven times and demanded cross-provider review for. **All
five reproduce (`node --disable-warning=ExperimentalWarning /tmp/arch017-qa.mjs`); I refute none.**

**1. Group lifecycle — the drain could fire twice.** Three separate defects in one finding:
```
1 late-after-close:     accepted; same group delivered twice
1 duplicate-id:         rows=2 outstanding=1 after settle
1 dismiss-running-last: outstanding=1 terminal=false   ← a PERMANENT hang
```
`recordDispatch` appended unconditionally. Fixed: a duplicate id is refused (`duplicate-id`) —
every lookup here resolves with `find()`, so a second row is unreachable to `settle()` AND blocks
its group forever; and a lane cannot join a group that has been explicitly closed (`group-closed`),
which is what makes `closeGroup()` a barrier rather than advice. A **DISMISSED** member no longer
counts as outstanding: nothing will ever settle a row the user discarded, so counting it hung the
group and made every sibling's result undeliverable — the hazard I believed closed in round 1.

**A self-inflicted over-reach, caught by my own new tests before landing:** stamping `groupClosedAt`
at birth made "declared closed" and "lifecycle closed" indistinguishable, so the guard refused the
SECOND member of every ordinary multi-lane group (`lane … cannot join group g-x3: that group was
closed at …`, for a group nobody had closed). `groupClosedAt` is now null at birth and belongs only
to an explicit close or a passed deadline.

**2. The nonce was decorative — FIXED BY REUSING THE LEDGER'S RULE, not writing a second one.**
```
2 replay: differentNonces=true oldReceiptAccepted=1 channelOmitted=true diskAcknowledged=true
```
The drain minted a nonce, never persisted it, never checked it, and required no destination at all.
The blocking transport had enforced both since rounds 4-6 — so this was **two implementations of one
security rule, and the newer one had only the possession third.** `receiptDigest(nonce, channel,
bytes)` and `receiptNonce()` are now exported from `lanes.ts` (the store both paths already depend
on) and used by the drain; the nonce and channel are persisted in `handoffEvidence`, so the check
survives a restart and `restampHandoff` rotates the nonce on every send. `dispatch-broker.ts` keeps
its own `fd`-typed wrapper over the same function rather than a copy.

**3. Refusal and partial delivery.**
```
3 partial:              sent=1 skipped=1 bundleContainsSkipped=true skippedHandoffOnDisk=null
3 missing-result-file:  excerptAcknowledged=true
```
A skipped lane's result was still **inside the returned bundle**, so the consumer read a result the
ledger says was never sent. `process()` now computes the bundle and the stamp set as a **fixpoint**
— stamp, drop failures, recompute, repeat — so payload and ledger cannot disagree. And the
excerpt-substitution is **decided deliberately: REFUSE.** A missing authoritative file is skipped
with a reason naming it; the result stays held and its excerpt stays visible on the rail. The
rejected alternative (ship it marked but never acknowledgeable) recreates the permanent-stranding
class round 2 was spent removing. Silent substitution was never an option.

**4. The rail acknowledged before it delivered.**
```
4 ack: composerHasResult=false
```
`showPendingBundle(r)` now runs BEFORE `ackLanes`. An acknowledgement is the consumer's statement
that it HAS the bytes where it said it would put them; sending it first is a claim about the future,
and a failure in between recorded "collected" for a result that reached nowhere the user could see.

**5. Vacuity, again.** `after=[]` and "empty API + empty DOM" both passed. Cardinality guards added
before every `.every()` in E5 and at rail `B2`.

**The reviewer's probes are adopted verbatim** as `X1`-`X7` + `X5b` (drain) and `C5` (rail), each
asserting the FIXED behaviour **on disk**, and as mutants **`Y1`-`Y8`** in the standing set.

**Mutation numbers against the reviewer's probes: 0 of 8 covered before → 8 killed / 0 survived
after.** ("Before" is not a guess: its five findings were live in shipped code while all three of my
suites were green, i.e. nothing asserted any of them.) Two of its probes initially survived even
after the fixes, and both were real coverage gaps I had to close:
- **Y4** (nonce check deleted) survived because the digest already incorporates the nonce. The
  explicit check only bites when the digest is right but the DECLARED nonce is stale — added to X4.
- **Y6** (fixpoint removed) survived because X5's partial came from the missing-file path, which
  filters candidates *before* the loop. `X5b` now makes the data dir read-only mid-drain — a
  reachable production failure (full disk, remount) — so every stamp fails and the drain must report
  sending nothing rather than a bundle with no handoffs behind it.

The reviewer's own per-lane write-failure injection is **not reproducible from a test here**: `lanes`
is an ESM namespace object and is read-only (`Cannot assign to read only property 'restampHandoff'`),
the same constraint that forced round 4's client probes onto network interception. It reached it by
rewriting the module in a sandbox; `X5b` + `Y6` cover the property by another route.

```
$ npx tsx scripts/verify-arch-017-drain.mjs          → 27 PASS / 0 FAIL   (+X1-X7, X5b)
$ … --must-fail-proof                                →  5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs             → 63 PASS / 0 FAIL
$ … --must-fail-proof                                → exit 0
$ node scripts/verify-arch-017-rail.mjs              → 22 PASS / 0 FAIL   (+C5)
$ … --must-fail-proof                                →  8 PASS / 0 FAIL
$ node scripts/verify-arch-017-mutation.mjs  (twice) → 34 killed / 0 SURVIVED, both runs
$ npm run gate                                       → GATE: PASS (exit 0)
$ npm run board:check                                → DRIFT — 5 (BUG-169, FEAT-129/131/132, ARCH-007)
```

**Closed from the reviewer's could-not-test list** (its sandbox blocks sockets/network; this
environment does not): live HTTP and browser integration are exercised by the rail suite against a
real server and real headless Chromium — including the new nonce/channel receipt computed by the
BROWSER via SubtleCrypto and accepted by the store (B3), and the deliver-before-acknowledge ordering
observed at the instant the ack leaves the client (C5). Real writer-socket arbitration is exercised
by the two-server 503 path (A1-A4).

**Still NOT closed, carried forward:** automatic wakeup/starvation SCHEDULING (the starvation bound
is only ever evaluated with an injected clock — no timer has been observed to fire); a real provider
fan-out; wall-clock TTLs; torn cross-process writes; non-Linux sockets; a real reboot; a live send
with a real model; other browsers/viewports; `--must-fail-proof` mutation mode; and cross-machine
stability of the mutation score.

---

### Round 6 — CHECKPOINT 1 (in progress, 2026-09-21)

Picking up an interrupted round: the round-5.5 lane edited source and died before running
anything. Verified against the real code (not the description) that all five claimed fixes are
genuinely present:

1. `groupSeal` exists as ONE exported rule (`src/server/lanes.ts:1098`), consumed by both the
   admission path (`:931`) and the group view's `sealed` field (`:1118`).
2. The broker no longer hashes for itself: `dispatch-broker.ts:169` delegates to
   `lanes.receiptDigest`, `:181` to `lanes.receiptNonce`, `:229` to `lanes.receiptMatches`.
   `receiptMatches` (`lanes.ts:745`) is the single case-normalising + length-checked comparison,
   and evidence is JSON via `encode/decodeReceiptFacts` (`:764`/`:767`), so `composer/main`
   survives the round trip.
3. The fixpoint bound is `attempt <= laneIds.length` (`lane-drain.ts:294`) and non-convergence
   REFUSES with an empty payload (`:325-333`) rather than returning a payload/disk mismatch.
5. `showPendingBundle` returns a delivery verdict consumed at `public/app.js:6201`.
6. The standing vacuity scanner exists and is green.

FIRST MEASURED RESULTS (nothing had been run since those edits):

```
verify-arch-017-drain.mjs    → 27 PASS / 0 FAIL
verify-arch-017-rail.mjs     → 22 PASS / 0 FAIL
verify-lane-ledger.mjs       → 63 PASS / 0 FAIL
verify-arch-017-vacuity.mjs  → 20 guarded / 0 UNGUARDED
verify-arch-017-mutation.mjs → 27 killed / 7 SURVIVED   ** RED, exit 1 **
```

**Two facts that correct the dispatch's premise and the round-5 record:**

- **There is no Z-series.** The handoff said `Z1`-`Z4` had been written into the drain suite and
  never executed. They do not exist — `grep` for `Z1..Z4` finds nothing in any of the four suites,
  and the drain suite's case labels are E2 E5 H1-H6 R1-R4 X1-X7 only. Nothing was lost; they were
  never written. Recorded here so no later round hunts for them.
- **Round 5's "34 killed / 0 SURVIVED" no longer holds.** The mutation suite is red at 27/7. All
  seven survivors are `ANCHOR MISSING` errors (M1, M6, M12, M17, Y1, Y6, Y8) — the round-5.5 edits
  moved the code each mutant patches, so those seven mutants stopped asking their question and the
  harness scored the un-asked question as a survivor. This is a self-inflicted regression of the
  mutation harness, not of the product code. Re-pointing them is round 6's work.

regressed-from: ARCH-017 round 5.5 (same ticket, unverified edit)

### Round 6 — CHECKPOINT 2: the mutation harness is green again

The seven stale mutants are re-pointed at the lines the round-5.5 edits moved them to, each
keeping its original question rather than being deleted or weakened:

| mutant | why it went stale | re-pointed to |
|---|---|---|
| M1  | the digest comparison became `lanes.receiptMatches` | `lane-drain.ts:429` |
| M17 | same line as M1; still drops ONLY the byte count, so M1/M17 stay distinct | `lane-drain.ts:429` |
| M6  | the fixpoint renamed `bytes` → `trialBytes` | `lane-drain.ts:309` |
| Y1  | admission now asks `groupSeal`; `closedSibling` no longer exists | `lanes.ts:932` |
| Y6  | the convergence test became a multi-line block under the N+1 bound | `lane-drain.ts:316` |
| M12 | the composer write reads the draft into a `before` local (for the read-back) | `app.js:6259` |
| Y8  | the call gained a verdict, a try/catch and a refuse-branch | `app.js:6199` |

`verify-arch-017-mutation.mjs` → **34 killed / 0 SURVIVED, exit 0.**

The lesson worth keeping: an anchored mutant that stops matching is scored as a SURVIVOR, which
reads identically to "this property is unasserted". The harness does print `ANCHOR MISSING`, but
the headline number is the thing people copy into a report — so a refactor can silently deflate the
mutation score, and round 5 landed its edits without re-running it. The anchor errors should fail
LOUDER than a survivor, since they mean "this measurement did not happen" rather than "this
measurement came back bad".

### Round 6 — CHECKPOINT 3: the vacuity scanner was itself vacuous in three ways

`/tmp/arch017-r5.cjs` **is gone** — the reviewer's probe file did not survive. Rebuilding its
probes from the areas named in the handoff, the "empty inputs pass rail A4, drain R1 and the
open-group item assertion" probe turned up three defects in the round-5 scanner, each of which made
it report a clean sweep it had not performed. None of these was found by making the scanner
weaker; the count went UP at every step.

1. **An idiom its own header advertised was never implemented.** The docblock has always listed
   `xs.includes(...) === false` among the covered vacuous idioms. It was not in `VACUOUS`. Adding
   it (plus `find() == null`, also advertised) surfaced four unguarded blocks — one of them exactly
   the "open-group item assertion" the reviewer named. A checker that documents a guarantee it does
   not implement is worse than one that promises nothing, because the docblock is what gets audited.

2. **The observed payload counted as a claim.** `guardsCardinality` was matched against the whole
   block, and `assertionExprs` kept *everything* after the first argument — the debug object
   included. Rail C1 prints `pulledTheUnreadyOne: pulled.includes('lane-v4-done')` in its observed
   payload, and the scanner accepted that print statement as proof the collection was non-empty.
   Observed payloads describe; they do not claim.

3. **The argument splitter was not string-aware — and this one was hiding the other two.** Every
   block starts with a prose title, and those titles contain commas and parentheses:
   `check('P4 — … capacity() reports it, nothing is deleted, recording CONTINUES', () => {…})`.
   The comma after "reports it" was read as the end of argument one. While the extractor kept
   everything after the first comma this was harmless by accident, so narrowing the extractor to
   argument two is what made it bite: **P4 and S4 silently dropped out of the scan**. That is the
   failure mode that actually matters here — the scanner kept printing `0 UNGUARDED` while
   examining fewer blocks than the round before.

**One real assertion was genuinely vacuous and is now fixed.** Rail `C1` / `leg 6` asserted only
that `pulled` did NOT contain the two unready ids, which is true of an empty `pulled`: a
`process all` that collected *nothing* certified "the filter works". The fixture now includes
`lane-v4-control`, a complete closed single-lane group that MUST be collected, and the check
asserts the positive and the negative together — the filter has to DISCRIMINATE, not merely
decline. Verified it really is pulled: C1 still passes, and the guard is not decorative.

```
scanner, round 5 as found  → 20 guarded / 0 UNGUARDED  (20 blocks scanned)
+ the advertised idioms     → 21 guarded / 4 UNGUARDED
+ payload-is-not-a-claim    → 23 guarded / 2 UNGUARDED
+ string-aware arg split    → 25 guarded / 0 UNGUARDED  (25 blocks scanned)
```

regressed-from: ARCH-017 round 5 (the scanner landed green over three blind spots)

### Round 6 — CHECKPOINT 4: the reviewer's probes, BEFORE

Its probe file is gone, so W1-W7 are OUR encoding of the five areas the handoff recorded, not a
verbatim adoption — stated plainly because an area mis-transcribed is an area still unprobed.

**BEFORE: `34 killed / 7 SURVIVED`. All seven probes survived.**

That is the finding of the round. Every one of the round-5 fixes is really in the code — verified
line by line in checkpoint 1 — and **not one of them was asserted by anything.** The suites were
27/22/63 green around code that could be reverted wholesale without a single check noticing:

| probe | the property nothing asserted |
|---|---|
| W1 | a group ALREADY DRAINED is sealed (cannot be delivered twice) |
| W2 | the receipt comparison is case-insensitive in the one shared place |
| W3 | a channel containing `/` survives the evidence round trip |
| W4 | fixpoint exhaustion REFUSES rather than returning a payload the disk disagrees with |
| W5 | a missing composer refuses to acknowledge |
| W6/W7 | the vacuity scanner catches an unguarded empty-true assertion |

**And W6/W7 exposed a defect in the mutation harness itself.** They survived against a scanner that
had in fact caught both mutations. The harness names a mutant's killer by scanning for
`^FAIL <name>:`; the scanner only ever printed `UNGUARDED`, so the run exited non-zero with no
NAMED killer and the harness declined the kill — correctly, by the rule that stops a crashing
sandbox being counted as coverage. The one check nothing was checking could not be checked, for
want of a prefix. The scanner now prints a `FAIL <block>:` line per offender and a machine-readable
`RESULT n PASS / m FAIL` twin.

### Round 6 — FINAL (2026-09-21): the round-5 report overstated, and the gap it hid was real

This round was dispatched to finish an interrupted one. The round-5.5 lane edited source and died
before running anything, so the tree arrived unverified. Checkpoints 1-4 above are the running
record; this is the close-out.

**A claim in the round-5 report is REFUTED.** Round 5 recorded `34 killed / 0 SURVIVED, twice` and
then made further edits without re-running. Measured: **27 killed / 7 SURVIVED.** All seven were
`ANCHOR MISSING` — the edits moved the lines those mutants patch, so they stopped asking their
question and the harness scored an un-asked question as a survivor. The number in the report was
true when written and false when landed, which is the failure mode worth naming: the mutation score
is the one figure people copy forward, and nothing forced it to be re-earned after a refactor.

**A second dispatch premise is also false, recorded so nobody hunts for it:** there is no `Z1`-`Z4`
series. The handoff said four cases had been written into the drain suite and never executed. They
do not exist in any of the four suites. Nothing was lost — they were never written.

**The reviewer's probe file `/tmp/arch017-r5.cjs` did not survive.** W1-W8 are therefore OUR
encoding of the five areas the handoff recorded, not a verbatim adoption; an area mis-transcribed is
an area still unprobed, and that is a real limit on this round's assurance.

#### The finding

| | before | after |
|---|---|---|
| mutation, reviewer's probes (W1-W7) | **0 of 7 killed** | 7 killed, +W8, 1 UNREACHABLE |
| mutation, whole set | 27 killed / 7 survived | **41 killed / 0 survived** (twice) |
| vacuity scanner | 20 guarded / 0 unguarded, 20 blocks | **25 guarded / 0 unguarded, 25 blocks** |

Every round-5 fix was genuinely present in the code — verified line by line, not taken from the
description — and **not one was asserted by anything.** Three suites totalling 112 green checks sat
around code that could have been reverted wholesale without a single one noticing.

#### What was actually broken, and fixed

1. **LIVE PRODUCT DEFECT — a missing composer still acknowledged.** `showPendingBundle` asked
   `node.prompt`, which `public/app.js:609` captures ONCE at boot. That reference outlives the
   composer being removed, replaced or re-rendered. A detached `<textarea>` is truthy, accepts
   `.value`, and reads back exactly what you wrote — so the existence check passed, the round-5
   read-back passed, and the ack went out for a result written into a node not in the document.
   Measured with `#prompt` removed: `ackWasSent: true`, no problem reported. `node.prompt` is a
   cache, not a question; the check is now `!box || !box.isConnected`. Covered by rail `W5` and
   mutant `W8`. This is the round-5 fix failing at exactly the thing it was written to do.
2. **The vacuity scanner was vacuous in three ways** (checkpoint 3): an idiom its own docblock
   advertised was never implemented; the observed/debug payload counted as a claim; and the
   argument splitter was not string-aware, so a comma inside a block's prose title ended argument
   one. The third was masking the other two — and the moment the extractor was tightened, P4 and S4
   dropped silently out of the scan. A checker quietly examining FEWER things while still printing
   `0 UNGUARDED` is the worst available failure.
3. **A genuinely vacuous assertion.** Rail `C1`/`leg 6` claimed only that `pulled` did NOT contain
   two unready ids — true of an empty `pulled`, so a `process all` that collected nothing certified
   "the ready-filter works". A `lane-v4-control` member that MUST be collected now makes the check
   assert a positive and a negative together: the filter has to DISCRIMINATE, not merely decline.
4. **The mutation harness could not grade its own scanner.** W6/W7 survived against a scanner that
   had caught both mutations: the harness names killers by `^FAIL <name>:` and the scanner only
   printed `UNGUARDED`, so the run exited non-zero with no named killer and the kill was declined —
   correctly, by the rule that stops a crashing sandbox counting as coverage. The one check nothing
   was checking could not be checked, for want of a prefix.
5. **Seven stale mutant anchors re-pointed** (checkpoint 2), each keeping its original question.

#### One mutant is UNREACHABLE by construction, and is reported as such

`W4` (fixpoint exhaustion refuses) cannot be killed, and that is the round-5 fix's own claim rather
than a coverage gap. The loop is `attempt <= laneIds.length && candidates.length`; `candidates` is
a filter of `laneIds` so it starts at C ≤ N, and every non-final pass moves ≥1 lane to `skipped`,
so the set is empty or fully stamped by pass C ≤ N. The refusal branch is a safety net against a
future edit lowering the bound (round 5's defect was a fixed bound of 4), not a live path. Reaching
it needs per-lane injection into `lanes.restampHandoff`, which ESM read-only namespaces prevent
in-process — the same constraint `X5`/`X5b` already document. The harness now has an `unreachable`
annotation: such a mutant is still RUN (if it is ever killed, the justification was stale and it
says so), a survival is reported `UNREACH` with the argument printed, and it does not fail the run.
Deleting it would hide the gap; leaving the gate permanently red would teach everyone to ignore it.

#### Measured this round

```
$ npx tsx scripts/verify-arch-017-drain.mjs            → 30 PASS / 0 FAIL   (+W1, W2, W3)
$ …   --must-fail-proof                                →  5 PASS / 0 FAIL
$ npx tsx scripts/verify-lane-ledger.mjs               → 63 PASS / 0 FAIL
$ …   --must-fail-proof                                →  8 PASS / 0 FAIL
$ npx tsx scripts/verify-arch-017-rail.mjs             → 23 PASS / 0 FAIL   (+W5)
$ …   --must-fail-proof                                →  9 PASS / 0 FAIL   (+leg 9)
$ npx tsx scripts/verify-arch-017-vacuity.mjs          → 25 guarded / 0 UNGUARDED (25 scanned)
$ npx tsx scripts/verify-arch-017-mutation.mjs (twice) → 41 killed / 0 SURVIVED, 1 UNREACHABLE
$ npm run gate                                         → GATE: PASS (exit 0)
$ npm run board:check                                  → DRIFT — 5 (BUG-169, FEAT-129/131/132,
                                                         ARCH-007 — all pre-existing, none ARCH-017)
```

#### Residual — still NOT verified, carried forward

Unchanged from round 5 and still accurate: real sockets; browser RENDERING and hangs (the rail
suite drives a real headless Chromium, but nothing asserts what a human would see, and no other
browser or viewport has been tried); kernel/writer arbitration beyond the two-server 503 path;
**automatic wakeup and starvation SCHEDULING — the timer has never been observed to fire, the bound
is only ever evaluated with an injected clock**; a real provider fan-out; a live send with a real
model; wall-clock TTLs; torn cross-process writes; non-Linux sockets; a real reboot.

New to this list, from this round:
- **The reviewer's probe file is gone**, so W1-W8 are a reconstruction from a prose summary. Any
  area of its original probes we mis-transcribed is still unprobed, and we cannot tell which.
- **`W4`'s refusal branch is unexecuted code** — argued unreachable, never run.
- `--must-fail-proof` mutation mode, and cross-machine stability of the mutation score, remain
  unmeasured (carried from round 5).

**This round's own verification is not the last word.** It touches session-lifecycle and
delivery-acknowledgement code and fixes a defect a prior round introduced-and-missed, so by the
standing rule it is in the "independent clean-room verify warranted" bucket — and the specific
thing to attack is that W1-W8 were written by the same lane that wrote the fixes they grade.

regressed-from: ARCH-017 round 5 / round 5.5 (mutation score not re-earned after a refactor; the
delivery-verdict fix never asserted; the vacuity scanner landed green over three blind spots)

---

### Round 7 — CHECKPOINT 1: third cross-provider review, DO NOT LAND, all five reproduce

**First action this round: both probe files are now IN THE REPO**, at
`scripts/reviewers/arch017-r6.cjs` and `scripts/reviewers/arch017-r6-scan.cjs`, copied verbatim
before any other work. Round 6 had to reconstruct W1-W8 from a prose summary because the round-5
probe file had been deleted from `/tmp`, and flagged that as a real limit on its own assurance.
That will not happen again: a reviewer's reproducer is evidence, and evidence lives in the repo.

Reproduced on the unmodified tree, `node scripts/reviewers/arch017-r6.cjs`:

```
1 seal {"sent":1,"sealed":true,"open":true,"terminal":false,"lateRefused":true}
1 bypass members=2 sealed=true
2 channel "composer/main" sent=1 ack=1     2 channel "a\"b" sent=1 ack=1
2 channel "a\nb" sent=1 ack=1              2 channel "文" sent=1 ack=1
2 channel ""    sent=1 ack=0   ← DEFECT    2 channel "a}b" sent=1 ack=0   ← DEFECT
3 retry {"refusedBytes":0,"skipped":2,"retrySent":2,"acked":2}   ← HELD, as the reviewer says
4 detached          {"acks":0,"refresh":1,"connected":false,"error":true}   ← the round-6 fix works
4 hidden            {"acks":1,...}   4 foreign            {"acks":1,...}
4 replace-on-input  {"acks":1,...}   4 replace-during-digest {"acks":1,...}  ← all DEFECTS
```

`node scripts/reviewers/arch017-r6-scan.cjs`:

```
5 control exit=1 · zero_guard exit=0 · unreached exit=0 · unrelated exit=0
6 drain:867 assertionExecutions=0
6 ledger:970 all assertions pass with fd:99 case UNREACHED (4/5 cases)
```

**All five failures confirmed. Nothing refuted.** Finding 3 is HELD and the reviewer is right about
why: every unsuccessful iteration shrinks the candidate set, so exhaustion is unreachable — that is
exactly the argument round 6 wrote into mutant `W4`'s `unreachable` annotation and into the round-6
entry above. Two independent reviews now agree the refusal branch is dead defensive code; it stays,
annotated, as a guard against a future edit lowering the bound.

The sharpest of the five is **#1**, and the reviewer's framing is the important part: *"admission,
readiness and reopening are three rules wearing one name… that is the third round this defect has
moved rather than closed — fix the shape, not the site."* Round 5 hoisted `groupSeal` and round 6
asserted it (`W1`), and both only ever made ADMISSION consult it. `open` and `openGroup` never did.

### Round 7 — CHECKPOINT 2: the five fixes were already in the tree UNSTAGED; verified, and found the broker-path regression the reviewer could not reach

Picked up an interrupted round 7. The prior lane (killed by a provider session
limit) had left the five fixes **in the working tree, unstaged** — `lanes.ts`
(+1064 vs its staged copy), `lane-drain.ts` (new), `public/app.js` — but with no
verification and no proof they hold. Confirmed the reviewer probes are already
adopted verbatim at `scripts/reviewers/arch017-r6.cjs` / `-scan.cjs` (byte-identical
to the `/tmp` originals; redundant copies I made were removed).

The five, as they stand in the tree:

1. **`groupSeal` is now ONE predicate with a KIND.** `groupSeal(rows) → {kind:'closed'|'drained', why}`
   (`lanes.ts:1219`). All three consumers derive from that one value: admission
   (`recordDispatch`) refuses on any seal; readiness (`summarise.open = rows.some(groupOpen) && !seal`,
   `:1249`); reopening (`openGroup`, `:1307`) refuses a DRAINED seal, permits a CLOSED one (the
   advertised deliberate re-open). The reviewer's `1 bypass` line no longer prints because
   `openGroup({members})` into a drained group now THROWS `group-closed` instead of adding members —
   i.e. the probe's demonstration path is closed by construction.
2. **Receipt evidence parses, not scans.** `encodeReceiptFacts` is length-prefixed
   (`receipt=<len>:<json>`) and `decodeReceiptFacts` reads exactly `<len>` chars, with a string-aware
   balanced-brace fallback only for legacy rounds-5/6 records (`lanes.ts:810`). Empty channel accepted
   (`typeof === 'string'`, not truthiness); `a}b` no longer truncates.
3. **Composer re-checked at the ACK instant.** `composerProblem(node.prompt, r.bundle)` is called again
   immediately before `ackLanes` (`app.js:6241`), after every await — connected, own-document, visible,
   AND still holding the bundle. Detached/hidden/foreign/replace-on-input/replace-during-digest all now
   refuse.
4. **Vacuity scanner** strengthened (`verify-arch-017-vacuity.mjs`): 25 guarded / 0 unguarded.
5. **The two vacuous assertions** (drain:867, ledger:970) — addressed by the round-7 suite edits.

**THE REGRESSION THE REVIEWER TOLD US TO HUNT — "check the broker path yourself."** The round-7 fix
for #2 made `receiptDigest` length-delimit the channel (`nonce ‖ len(ch)":" ‖ ch ‖ bytes`,
`lanes.ts:728`) to kill a channel/bytes collision once channels became free-form. The broker verifies
via that shared function — but the **real socket peer, `dispatch-client.mjs:106`, still hashed the OLD
bare `nonce ‖ "fdN" ‖ bytes`**, so on a live socket delivery the broker would refuse EVERY genuine
receipt and hold every result. This is not reachable from the reviewer's sandbox (no sockets; its
broker channels are fixed `fd1`/`fd2`), which is exactly why the charter flagged it. Reproduced: the
ledger suite drove it — `C1`/`C4` (the REAL client) plus `D15`/`D16`/`D17` all FAILED (55 PASS / 8 FAIL;
`--must-fail-proof` threw). Fixed `dispatch-client.mjs` to the shared length-delimited rule and
re-aligned the ledger suite's honest-peer mock (`peerDigest`, and the inline emitter at :1345) to match
the real client. After: **ledger 63 PASS / 0 FAIL, `--must-fail-proof` exit 0.**

regressed-from: ARCH-017 round 7 (the `receiptDigest` length-delimiter change did not update the real
socket peer `dispatch-client.mjs`; the ledger mock hid it because it, too, hashed the old way).

Suites so far: drain 30/0 + 5/5 must-FAIL; rail 23/0 + 9/9 must-FAIL; ledger 63/0 + must-FAIL exit 0;
vacuity 25 guarded / 0 unguarded. Mutation, `gate`, `board:check`, and the probe before/after still to
run — continued below.

### Round 7 — CHECKPOINT 3: #4 and #5 were NOT fixed by the prior lane; scanner + assertions hardened; final numbers

Checkpoint 2 verified #1/#2/#3 (already in the tree) and fixed the broker-path
regression. Then I ran the reviewer's SECOND probe, `scripts/reviewers/arch017-r6-scan.cjs`,
and it reproduced findings **#4 and #5 UNCHANGED** on the working tree — the prior
lane had not touched them:

```
5 control exit=1 · zero_guard exit=0 · unreached exit=0 · unrelated exit=0
6 drain:867 assertionExecutions=0
6 ledger:970 all assertions pass with fd:99 case UNREACHED (4/5 cases)
```

**#4 — the vacuity scanner had three blind spots, all now closed** (`verify-arch-017-vacuity.mjs`):
- *zero-length guards*: a cardinality assertion counted as a guard even when it was
  TRUE on the empty collection (`.length === 0`, `>= 0`). A guard now counts only
  when it is FALSE on empty (`emptyPasses`).
- *unrelated-collection guards*: a `precondition` count on a DIFFERENT collection
  counted (`ys.length` guarding `xs.every`). Guards are now base-scoped — to the
  collection, the identifiers in its initialiser, and any sibling with the IDENTICAL
  initialiser (so the real suites' derived/sibling collections still count, but the
  reviewer's unrelated `ys` does not).
- *unreached assertion loops*: the `for…of + assert` idiom was scanned against the
  extracted assertions, where a loop wrapper never appears, so it never fired. Loops
  (`for…of`/`.forEach` whose body asserts) are now detected against the block BODY
  (`loopCollections`) and require the iterated collection be pinned non-empty.

After: all three scan-probe cases exit 1, and the scanner catches the class before a
fixture is blind. Strengthening it made it correctly flag **six real blocks** whose
prior "guard" was the very unrelated-precondition hole #4 describes; five were given a
genuine same-collection cardinality guard (E1 `recs`, E5 `laneIds`, R1 `after`/rail-leave,
R4 `observed`, P2 `results`), and one (R3 `offenders`) was cleared by crediting the
initialiser source. Real suites: **27 guarded / 0 unguarded.**

**#5 — the two named vacuous assertions, fixed:**
- `verify-arch-017-drain.mjs` — "every sent lane has a handoff on disk" looped over
  `out.lanes`, which the block asserts is EMPTY three lines up, so it ran zero
  assertions. Moved to the recovery drain's `good.lanes` (pinned length 2).
- `verify-lane-ledger.mjs` D17 — `d17.length >= 4` passed with the `fd:99` case
  (a receipt naming a channel that was never the destination) unreached, 4 of 5.
  Pinned to `=== 5`, every case asserted present, and `fd:99` asserted by name.

**#3 coverage gap closed:** the round-7 pre-ack re-check (`composerProblem` at the ACK
instant) was UNTESTED by the rail suite — only the before-run missing-composer case
(W5) was. Added leg **C6 + must-FAIL leg 10** driving a composer torn on the `input`
event during the async gap against the REAL client in a REAL browser: no ack is sent
and the user is told. Mutant `W5` re-pointed to delete the re-check → C6 kills it;
`W8` re-pointed to the split `isConnected` guard → W5-leg kills it; `Y8` re-pointed
(the delivery block moved) → C5 kills it; `M1` re-pointed (the empty-channel fix moved
its anchor).

**Mutation harness:** added an env-gated suite filter (`ARCH017_MUT_SUITES`) so the
42-mutant set runs in foreground chunks under a wall-clock cap without splitting the
score (the 15 RAIL mutants each boot a real server + browser). Score, run **twice**:
DRAIN+LEDGER+VACUITY **26 killed / 0 survived + W4 unreachable**; RAIL **15 killed / 0
survived**; union **41 killed / 0 survived / 1 unreachable**, baselines all green
(drain 30/0, ledger 63/0, vacuity 27/0, rail 24/0).

**Full verification this round:**
- drain 30/0 + 5/5 must-FAIL; rail 24/0 + 10/10 must-FAIL; ledger 63/0 + must-FAIL
  exit 0; vacuity 27 guarded / 0 unguarded.
- reviewer scan probe: all three scanner blind-spots now exit 1.
- mutation 41 killed / 0 survived / 1 unreachable, twice.
- `npm run gate` PASS (exit 0, read unpiped). `board:check` at the 5 pre-existing
  drifts (BUG-169, FEAT-129/131/132, ARCH-007); no new drift.

**Still unverified, carried forward:** a real provider fan-out and a live send with a
real model; wall-clock TTL/starvation scheduling under real load; torn cross-process
writes on the socket transport under concurrency; non-Linux sockets; a real reboot.
The reviewer's first probe (`arch017-r6.cjs`) now THROWS at its `openGroup` bypass line
(section 1) because that bypass is exactly what #1 closed, so its sections 2-4 are not
reachable in one run — those properties are covered by the suites and the mutation set,
not by re-running the monolithic probe.

**High-stakes flag:** this round fixes a session-lifecycle/delivery regression that a
prior round-7 lane introduced-and-missed and closes two defects that lane left. Per the
standing rule this is squarely in the "independent clean-room verify warranted" bucket
— and the specific thing to attack is that the C6 leg and the scanner hardening were
written by the same lane that graded them.

regressed-from: ARCH-017 round 7 (the `receiptDigest` length-delimiter change did not
update the real socket peer `dispatch-client.mjs`; #4 and #5 from the third review were
left unaddressed by the interrupted lane).

### Round 8 — CHECKPOINT 1: fourth cross-provider review, all four + the two #5 reproduced, all fixed

Both probes adopted verbatim to `scripts/reviewers/arch017-r7.cjs` / `-r7-scan.cjs`
(byte-identical to `/tmp`) before any change. All reproduced on the unmodified tree,
then fixed:

**#1 reopen-after-drain (fourth round for this defect).** Two parts, both real:
- `groupSeal` checked `closed` BEFORE `drained`, so closing MASKED delivery — a
  drained+acknowledged+closed group reported `closed`, which `openGroup` treats as a
  re-openable state, and it was delivered a SECOND time (`1 closed+drained
  seal=closed reopen=accepted secondDrain=1`). Fix: the delivered state (handoff OR
  acknowledged) is ABSORBING and checked first, so closing can never overwrite it
  (`lanes.ts:1219`). Reopen now throws `group-closed`.
- `pending()` re-derived readiness locally (`rows.some(r => r.groupOpen)`,
  `lane-drain.ts:158`), disagreeing with `groupTerminal` which asks `groupState`
  (`1 readiness terminal=true pending=[{kind:lane,ready:false}]` — two answers, the
  ARCH-010 defect). Fix: `pending()` now reads `groupState(gid).open`/`.outstanding`,
  so every readiness caller goes through the one predicate. Verified: `groupTerminal`
  and `pending()` agree (both `true`/ready). W1/X1/E6/R1 still pass.
**#2 empty-failure-text digest.** `dispatch-client.mjs:68` used `f.text || 'host
broker failed'`, hashing that fallback while the broker hashes `frame.text ?? ''`
(empty) — `2 mismatch ok=false text=""`. Fixed to `?? ''`; the human fallback is now
DECORATION on stderr, not part of the receipted payload. **Checked the broker's own
path**: `dispatch-broker.ts:179` already uses `?? ''`, no analogous substitution.
Verified: peer digest now matches broker 8/8 (was 7/8), empty case included.
**#3 composer.** (a) ancestor visibility was unchecked — a box inside a `hidden`
parent still acknowledged; `composerProblem` now walks ancestors (`app.js`). (b) a
re-check that THREW escaped with nothing shown; the re-check is now wrapped so a
throw is a refusal (problem + refresh), not an exception. Verified: all four modes
(hidden-ancestor, throw-recheck, detach-digest, detach-value-get) now `acks:0,
refresh:1, problem:true`.
**#4 scanner — the mechanism, not another patch.** Four more evasions (`relative`,
`filtered`, `prefix`, `unreached_guard`), the third round it has been beaten in a new
way. **Conclusion recorded per the reviewer's invitation: a static source-matcher
cannot win the vacuity-idiom enumeration race; it is a LINT, and the AUTHORITATIVE
anti-vacuity mechanism is the MUTATION HARNESS — a vacuous assertion is exactly a
mutant that survives deleting its property, which the 41/0 score already forbids.**
The lint is narrowed to what a source scan can soundly assert: a cardinality claim on
the collection's OWN word-bounded name (`xs` ≠ `xsOther`), FALSE on empty, OUTSIDE any
loop over it; cross-variable inference (sibling-initialiser, filter-source, bare
relative) is dropped because each was a measured evasion — relative is credited only
when the other side is itself pinned positive (A4's sound form). The assert-EMPTINESS
idioms (`deepEqual(xs,[])`, `.length===0`) are no longer flagged: asserting a
collection is empty is a legitimate claim whose "right empty?" question is prior-state
and unanswerable statically. All five scan-probe cases now exit 1; real suites 23
guarded / 0 unguarded.
**#5 two more vacuous assertions.** drain E5 `afterBad.every(...)` and ledger W4
`reports.every(...)` both passed on an empty read; each now pins its OWN cardinality
(`afterBad.length===3`, `w4.reports.length===4`) — verified they THROW on the empty
input the probe injects.

HOLDS confirmed: parsed receipt evidence — malformed refused ×3, round-trips clean,
duplicate-key last-wins, no prototype pollution, million-char channel survives.

Still to do this round: fail-before/pass-after suite legs for #1/#2/#3, adopt the r7
probes into the mutation set, full re-runs (suites + must-fail + vacuity + mutation
twice + gate + board). Continued below.

### Round 8 — CHECKPOINT 2: tests, mutation adoption, final numbers

Fail-before/pass-after coverage added for each fix:
- **#1** — drain leg **W9**: a delivered+acknowledged+closed group has `sealedKind ===
  'drained'` (closed cannot mask it), `openGroup` throws `group-closed`, a second drain
  carries 0 lanes, and the re-open member never reaches the ledger; PLUS an early-pulled
  open group where `groupTerminal(G)` and `pending()`'s item `ready` give the SAME
  answer. Mutants **W11** (make closed hide drained) and **W12** (local `open`
  re-derivation in `pending`) both KILLED by W9.
- **#2** — drain leg **W10**: the real `ackAndExit` and `lanes.receiptDigest` agree on
  all 8 ok×text cases including the empty failure text. Mutant **W13** (`|| 'x'`
  substitution) KILLED.
- **#3** — real-browser legs **C7** (composer inside a hidden ancestor) and **C8** (a
  re-check that throws): both refuse the ack and name a problem, no escape. Mutants
  **W14** (box-only visibility) and **W15** (drop the re-check try/catch) KILLED.
- **#4/#5** — the scanner catches all five r7-scan evasions; the two #5 guards are
  themselves guarded by mutants **W16/W17** (VACUITY): removing `afterBad.length===3`
  or `w4.reports.length===4` makes the scanner flag the block.

**On the scanner mechanism (recorded per the reviewer's invitation):** a source-level
idiom-matcher is a LINT and always will be — it lost three consecutive rounds to a new
evasion each time. The property "no suite assertion is vacuous" is RUNTIME and is proven
by the MUTATION HARNESS: a vacuous assertion is exactly a mutant that survives deleting
its property, which the standing **48 killed / 0 survived** score forbids. The lint is
kept because it is cheap and catches the class before a fixture is blind, but it is no
longer asked to be sound against adversarial input; the mutation score is.

**Final verification:**
- drain 32 PASS / 0 FAIL + 5/5 must-FAIL; rail 26/0 + 12/12 must-FAIL; ledger 63/0 +
  must-FAIL exit 0; vacuity 23 guarded / 0 unguarded.
- reviewer probes: r7.cjs section 1 now THROWS at the reopen (the #1 fix); r7-scan
  sections 5 (all five evasions exit 1) and 6 (afterBad/W4 THROW on empty input).
- mutation **48 killed / 0 survived / 1 unreachable (W4)**, twice (non-browser 31/0
  ×2, RAIL 17/0). `gate` PASS (exit 0, unpiped). `board:check` = 5 pre-existing
  (BUG-169, FEAT-129/131/132, ARCH-007), no new drift.

**Still unverified, carried forward:** real sockets/broker transport under concurrency,
full browser rendering beyond the driven legs, a real provider fan-out, wall-clock
TTL/starvation under load, torn cross-process writes, non-Linux sockets, a real reboot.

**High-stakes flag:** #1 is the FOURTH round on reopen-after-drain and this round changes
the seal lattice and the readiness path; an independent clean-room verify is warranted,
and the thing to attack is that W9-W17 were written by the same lane that wrote the fixes.

regressed-from: ARCH-017 round 7 (the `groupSeal` kind ordering let `closed` mask
`drained`; the `pending()` readiness was a local re-derivation not routed through the
predicate; the client's empty-text digest substitution and the composer ancestor/throw
gaps predate but were not caught until this review).

### Round 9 — CHECKPOINT 1: fifth cross-provider review; reproduction + #4/#2 done

Both probes adopted verbatim (`scripts/reviewers/arch017-r8.cjs`, `-r8-mut.cjs`,
byte-identical to `/tmp`). All five reproduced; HOLDs confirmed (partial-write recovery
`first=1 retry=2 acked=2`; anchor audit `mutants=49 missing=0 ambiguous=0`; negative
deadline closes).

**Invariant for finding 1 (stated before coding, as the reviewer asked):** *A group
that has ever begun delivery is sealed against admission and re-open FOREVER, and that
fact is stored durably enough to survive the deletion (by retention pruning) of every
lane row it was derived from — including reuse of the same groupId.*

**#4 deadline arithmetic + monotonic readiness — DONE.** `now + ttlMs` with an extreme
finite operand overflowed to `Infinity`, which `JSON.stringify` persists as `null` — a
group open forever (`finite deadline addition overflow: diskDeadline=null … open=true`).
New `safeDeadline()` clamps any non-finite/absurd deadline to a finite far-future value
(`MAX_DEADLINE`) at all three sites (`recordDispatchRow`, `openGroup`, `extendGroup`).
And readiness regressed on a clock rollback (`ready=true -> false`) because it was
recomputed from the wall clock each poll; it is now MONOTONIC via a persisted
`starvationReleasedAt` stamped once by new `releaseStarved()` (called from `pending()`,
best-effort so a non-writer still reads from time). New drain leg **W18** asserts both:
an overflowing deadline persists FINITE, and a released result stays ready across a 1h
rollback (`starvationReleasedAt` on disk). drain 33/0, vacuity 23/0.

**#2 sustained-readiness — the property moved.** The mutant the harness could not kill
withdrew the pending() time-expression past 2× the threshold; that expression is now
DOMINATED by the persisted-release stamp (`releaseStarved` uses the un-mutated
threshold), so on a writer the reviewer's exact mutant is subsumed. Sustained readiness
is now ASSERTED by W18 (survives a rollback, i.e. past the release) and will be enforced
by mutants that remove the stamp arm / neuter `releaseStarved` (added with the mutation
run below). The reviewer's original pending-time mutant no longer has its anchor
(`const starved = waited >= lanes.HELD_STARVATION_MS;` gained a stamp arm).

Remaining this round: #1 (durable seal), #3 (record generation), #5 (cross-project leak
+ CSS visibility + digest-fail refresh, with real-browser proof), mutation adoption,
full re-runs. Continued below.

### Round 9 — CHECKPOINT 2: tests, mutation adoption, final numbers

Fail-before/pass-after coverage, each asserting on disk:
- **#1** drain leg **W19**: a delivered+acknowledged group, its rows overflowed out of
  the retention bound (`lanes.get(a) === null`), still has a durable seal
  (`durableGroupSeal(G) != null`) and still refuses a late join (`group-closed`).
  Mutant **W21** (skip the durable path in `groupSealFor`) KILLED.
- **#3** drain leg **W20**: `restampHandoff` with a stale generation is refused
  (`conflict`); the full swap (old bundle, replacement result, `acknowledgedByOldBundle=0`)
  is in the reviewer probe. Mutant **W22** KILLED.
- **#4** drain leg **W18**: an overflowing deadline persists FINITE; a released result
  stays ready across a 1h clock rollback (`starvationReleasedAt` on disk). Mutants **W23**
  (unclamped deadline) and **W24** (drop the monotonic stamp arm — this IS the round-8
  starvation mutant, now killable) both KILLED.
- **#5** real-browser leg **C9** (+ must-FAIL leg 11): a project switch mid-drain leaves
  B's composer WITHOUT A's result and sends no ack; screenshot saved to
  `.playwright-mcp/arch-017-r9-xproject.png`. CSS-hidden and digest-fail refusals verified
  against the client. Mutant **W25** (skip the session-binding check) KILLED.

**On #2 / the starvation mutant (the reviewer's specific ask):** the round-8 mutant edited
the `pending()` time expression; round 9 moved sustained readiness into `releaseStarved()` +
the persisted `starvationReleasedAt` arm, so that exact anchor is gone. It is re-expressed as
**W24** (remove the stamp arm) and **DIES** — killed by W18's rollback assertion. So yes, the
starvation mutant now dies.

**On W1/W11 becoming UNREACHABLE:** the durable seal (written at handoff, consulted first)
now dominates the row-based `groupSeal` drained clause those two mutate, so mutating the row
clause changes no observable behaviour while the durable file is intact. The PROPERTY is still
enforced and asserted — via the durable path, which W21 kills. They are annotated unreachable
(defence-in-depth), not deleted, and not counted as survivors.

**Final verification:**
- drain 35/0 + 5/5 must-FAIL; rail 27/0 + 13/13 must-FAIL; ledger 63/0 + must-FAIL exit 0;
  vacuity 23/0.
- reviewer probes: `arch017-r8.cjs` now THROWS at the durable-seal late-join (finding 1); the
  deadline/rollback/ledger-swap/rail cases documented the bugs and now fail their bug-asserts.
- mutation **51 killed / 0 survived / 3 unreachable (W1, W11, W4)**; non-browser 33/0 twice,
  RAIL 18/0. `gate` PASS (exit 0, unpiped). `board:check` = 5 pre-existing (BUG-169,
  FEAT-129/131/132, ARCH-007), no new drift.

**Closed what the reviewer's sandbox could not:** real browser (C9 + screenshot), the full
mutation score (54 mutants), and the durable-seal / generation / deadline behaviours on a
writable disk. **Still could not reach:** actual process death mid-drain, real-duration
starvation (tested with injected clocks), result-file size races, and the live socket transport
under real concurrency — carried forward.

**High-stakes flag:** #1 is the FIFTH round on reopen-after-drain and #5 is a data-leak fix;
round 9 adds a new persistent file (`group-seals.json`) and two required record fields
(`generation`, `starvationReleasedAt`). An independent clean-room verify is warranted — attack
that W18-W25/C9 were written by the same lane, that the durable-seal file has no retention of
its own yet (it grows one entry per group ever — noted, not yet bounded), and the
non-writer read path for `releaseStarved`.

regressed-from: ARCH-017 rounds 5-8 (each stored the seal in prunable rows; the deadline
overflow, clock-rollback, ledger-swap and cross-project-switch angles predate but were not
reached until this review).

### Round 10 — CHECKPOINT 1: sixth review; the round-9 session fix was reported done and WAS NOT

Probe adopted (`scripts/reviewers/arch017-r9.cjs`, byte-identical to `/tmp`; subcommands
seal/ordering/generation/clock/session). All five reproduced, all fixed.

**#1 (the important admission): the round-9 cross-project fix was WRONG and I reported it
done with a happy-path screenshot.** The guard read `state.current.id`; a selected session
is `{sessionId, projectId, encodedDir}` — no `.id` — so it compared `undefined` to
`undefined` and passed for EVERY destination (`same/other/gone` all delivered A's result and
acked). Fixed to compare `sessionId`; verified `same` delivers, `other`/`gone` refuse
(`node scripts/reviewers/arch017-r9.cjs session` now throws asserting ack=1). A NEGATIVE
real-browser leg + screenshot is added below — the round-9 screenshot proved nothing because
the happy path passes with or without the guard.
**#2 the seal FAILED OPEN.** `readDurableSeals` caught every error and returned `{}`, so an
empty/truncated/invalid/unreadable/array/directory seal file read as "no group sealed" and
permitted re-delivery. Now ABSENT (`ENOENT`) is a fresh system (`{}`); anything else THROWS
and `durableGroupSeal` FAILS CLOSED (treats the group as delivered) — refuse rather than
deliver twice.
**#3 the broker sealed AFTER emitting** and swallowed the failure. `terminal()` now takes a
`sealFirst` step run BEFORE `socket.end`; if the seal cannot be written, nothing is emitted
and the result stays held. (The rail path already sealed-then-stamped atomically.)
**#4 legacy generations derived from the reusable id** (`legacy-${id}`), so a reused id
collided and the swap passed. `readAll` now assigns a unique RANDOM generation to a row
missing one and PERSISTS it (on the writer), stable across reads.
**#5 readiness regressed when its stamp write failed.** `ready` was `stamp || waited>=thr`,
so a failed stamp still exposed readiness and a restart reversed it. Readiness is now the
PERSISTED STAMP ALONE — a failed stamp is not-ready-yet, released durably by the next
successful poll.

drain 35/0, ledger 63/0, vacuity 23/0, gate PASS after the fixes. Remaining: fail-before/pass-
after suite legs, the #1 negative browser proof + screenshot, mutation adoption (incl. a
session-guard-delete mutant), `group-seals.json` retention. Continued below.

### Round 10 — CHECKPOINT 2: final numbers, mutation adopted and run TWICE, retention checked

Picked up the tail of an interrupted round: the prior lane reported its mutation numbers and was
killed by a provider session limit before running the final checks. This checkpoint verified the
five fixes against the real code (a claim is not evidence — two fixes on this ticket have been
reported done and were not), then ran everything.

**The five round-10 fixes are all GENUINELY PRESENT in the tree** (read, not inherited):
- **#1 session binding** — `processPending` (`public/app.js:6151`) captures `origin = {sessionId,
  projectId}` from `state.current` and `sessionMoved()` compares `state.current.sessionId /
  .projectId`; consulted before placement (`:6226`) and again before the ack (`:6296`). The
  round-9 `.id` bug is gone. C10 covers both negatives — a DIFFERENT session (`other`) and NONE
  (`gone`).
- **#2 seal fail-open** — `readDurableSeals` (`src/server/lanes.ts:1335`) returns `{}` ONLY on
  `ENOENT`; read error / non-JSON / non-`{groupId:seal}` shape (array, primitive) THROW
  `seal-unreadable`, and `durableGroupSeal` catches that and returns a `drained` seal — FAILS
  CLOSED.
- **#3 seal ordering** — `terminal()` (`src/server/dispatch-broker.ts:200`) runs `sealFirst()`
  BEFORE any bytes leave; a throw refuses the send and emits nothing. The rail path
  (`markHandoff`/`restampHandoff`, `lanes.ts:1689`/`:1773`) seals durably then `writeAll`s
  atomically.
- **#4 legacy generation** — `readAll` (`lanes.ts:733`) assigns `randomBytes(12).toString('hex')`
  to any row missing a `generation` and PERSISTS it once on the writer (`:735`), not
  `legacy-${id}`.
- **#5 readiness** — `pending()` (`src/server/lane-drain.ts:204`) sets `starved =
  r.starvationReleasedAt != null` — the persisted stamp ALONE; the time arm is gone. A failed
  `releaseStarved` write is simply not-ready-yet.

**`group-seals.json` retention — checked, and it is a SILENT-DROP bound, not a refuse.**
`MAX_DURABLE_SEALS = 50_000` (`lanes.ts:1361`); on write, if `Object.keys(seals).length >
MAX_DURABLE_SEALS`, the OLDEST seals (by `.at`) are `delete`d. Nothing special happens at the
boundary other than dropping — so a dropped seal DOES permit its groupId to be reused and
re-delivered. The in-code comment states this tradeoff deliberately: groupIds are random (or
dispatcher-chosen and one-shot), so at 50k retained the oldest is far past any live group and
reuse of a 50k-old id is not a real event. Recorded here so the residual is not hidden: at
extreme scale the seal file's guarantee is bounded, by design.

**Suites (standalone, this box):**
- drain **38 PASS / 0 FAIL** + **5/5** must-FAIL (new round-10 legs W30 fail-closed seal, W31
  unique legacy generation, W32 persisted-stamp readiness all present and green).
- ledger **63 PASS / 0 FAIL** + must-FAIL legs (7/8) exit 0.
- rail **29 PASS / 0 FAIL** + **15/15** must-FAIL — includes `C10/gone` and `C10/other` (the
  NEGATIVE session cases: a result refuses to land when the session is gone or different; no ack,
  no leak) and must-FAIL legs 12/gone + 12/other. Screenshot
  `.playwright-mcp/arch-017-r10-session-gone.png`.
- vacuity **24 guarded / 0 unguarded**, 24/0.

**Mutation harness — 57 mutants, run TWICE (the stability check the prior lane never reached):**
both runs **54 killed / 0 survived / 3 unreachable**. The 3 unreachable are W1 (a drained group
is sealed — dominated by the durable seal, W21 kills the durable path), W11 (delivered-absorbs-
closed — same), and W4 (fixpoint exhaustion — the N+1 bound makes it unreachable in-process).
RAIL browser mutants: 19 killed / 0.
- **W26 — the session-guard-delete mutant — is KILLED BY `C10/other`, NOT by `C9`.** This is the
  first time on this ticket the anti-vacuity machinery caught the thing it exists for: the old
  positive-case `C9` passes with or without the guard (the happy path delivers either way, which
  is exactly why the round-9 screenshot "proved" a broken fix), and only the negative case `C10`
  goes red when the guard is removed. That distinction would have caught the false "fixed" report
  a round earlier.
- W25 (round-9 cross-project) killed by C9 + C10/other + C10/gone; W27→W30 (fail-closed seal)
  killed by W30/W2/W3; W28→W31 (unique legacy gen) killed by W31; W24/W32 (persisted readiness)
  killed.

**`gate` PASS** (exit 0, unpiped — leak-gate + check-nul + typecheck). **`board:check`** exits 1
on exactly the **5 pre-existing drift problems** (BUG-169, FEAT-129, FEAT-131, FEAT-132,
ARCH-007 — all UNMAPPABLE-STATUS / UNREACHABLE-TICKET, none touched by ARCH-017); the STALE-doc
WARNs and the BUG-176 advisory are pre-existing and not new. No new drift introduced.

**Method note:** the prior lane's numbers were re-measured, not inherited — the suites had grown
since round-10 CHECKPOINT 1 (drain 35→38, rail 27→29, vacuity 23→24 with the new W30/W31/W32 and
C10 legs), so the CHECKPOINT-1 counts are superseded by the ones here. Mutation run 1 was still
ALIVE when this lane took over (verified from its pid + output file, not assumed dead); it was
harvested rather than re-run, and run 2 was then launched for the stability pair.

**Still untested by anyone — carried forward as the verifier's queue (unchanged in kind):** real
browser reload behaviour; socket-based writer exclusion (a concurrent process holding
`group-seals.json` open); truly concurrent processes racing the ledger and the seal file; crash
and power-loss durability (fsync/atomic-rename under real kill -9 / power cut); read-only
filesystem permissions (`EROFS`/`EPERM` on the seal + ledger writes); large-file and OOM
behaviour (a multi-MB result, or a 50k-entry seal file read at scale); real provider fan-out
(every lane is still a fixture, never a real `claude`/Codex turn); real-duration starvation
(tested only with injected clocks). None of these is HELD — they are untested, and every one is a
place the same false-proof class could still hide.

**High-stakes flag (bucket: session-lifecycle + data-loss + regression-prone).** #1 is a
data-leak fix that was falsely reported done last round, and #2/#3 change fail-open→fail-closed
on a durability store; W26-W32/C10/W30-W32 were all written by this same lane. An independent
clean-room verify is warranted — attack that the session guard truly refuses on `other`/`gone`
in a REAL reload (not a scripted DOM assert), that the seal fails closed under a truncated
concurrent write, and that the 50k retention drop cannot be triggered early by a shape bug.

regressed-from: ARCH-017 round 9 (the session-binding fix read a non-existent `.id` and was
reported DONE — the guard was inert; corrected here).

### Round 11 — CHECKPOINT: seventh review's four fixes verified present, run B harvested, final numbers

Picked up the tail of round 11: the prior lane made the four fixes and was then blocked by
consecutive `PreToolUse` hook timeouts before it could finish the checks or the write-up. This
lane verified the four fixes against the real code (a claim is not evidence — two fixes on this
ticket were reported done and were not, both proven only by a positive case), harvested the
second mutation run from ground truth rather than re-running a live child, and ran every check.

**Mutation run B was already COMPLETE, not alive.** Checked from ground truth first
(`/tmp/arch017-r11-B.log`, no live pid, log stable at 14035 bytes): its final line reads **59
killed / 0 SURVIVED / 3 unreachable (W1/W11/W4)** — identical to run A. The dispatch's "44+ and
climbing when the fault hit" was a stale mid-run reading; the run finished before the outage. So
the stability pair is 59/0/3 TWICE across 62 mutants (RAIL 20/0), not re-run.

**The four round-11 fixes are all GENUINELY PRESENT in the tree** (read, not inherited), and each
attack probe at `scripts/reviewers/arch017-r10.cjs` exits 1 (the round-10 leaky behaviour throws
an AssertionError — the fix refuses it): `ack`, `session`, `seals`, `retention` all exit 1.
- **#1 echo defence** (`src/server/lane-drain.ts`) — structurally airtight, not just the one path:
  the `DrainBundle` interface (`:78`) DECLARES `receipt: { nonce; channel; bytes }` with **no
  `digest` field at all**, and `process()` has exactly ONE `return` (`:385`) which yields that
  shape. There is no response shape on this path that can carry the expected digest — the type
  forbids it. The expected digest lives only on the record (`handoffEvidence`) and `acknowledge()`
  recovers it via `decodeReceiptFacts`; the refusal messages print no digest prefix. Probe `ack`
  (echo the server receipt, emit 0 bytes) now leaves `acknowledged:[]`.
- **#2 session guard** (`public/app.js:6151`) — `sessionMoved()` (`:6178`) refuses unless (1)
  `state.current?.sessionId` is non-null — **an ABSENT id is a refusal**, (2) `sessionId` +
  `projectId` + `encodedDir` all still equal the origin, AND (3) `state.current` is the same
  object reference captured at start. Confirmed **every** result-delivery caller goes through the
  guard, not only the patched one: `api.ackLanes` has exactly ONE call site in the whole file
  (`:6342`), inside `processPending`, and `sessionMoved()` is checked BOTH before placement
  (`:6257`, gating `showPendingBundle` at `:6264`) and again before the ack (`:6327`). No bypass.
  Probe `session` (absent / directory / recreated) exits 1.
- **#3 seal entry validation** (`src/server/lanes.ts`) — `isDurableSeal` (`:1451`) requires a
  non-array object with finite-number `at`, `kind` in {closed,drained}, string `why`;
  `durableGroupSeal` (`:1443`) returns a `drained` seal (FAILS CLOSED) for any present-but-
  malformed entry. `{"g":false}` no longer reads as unsealed. Probe `seals` exits 1.
- **#4 retention + entropy** (`src/server/lanes.ts`) — eviction candidates now
  `filter((id) => id !== groupId)` (`:1407`), so the just-written seal is never the one dropped
  even under a clock rollback; `newLaneId` (`:1060`) uses `randomBytes(9)` = 72-bit hex, not
  `Math.random`. Probe `retention` (50k boundary + rollback) exits 1.

**Suites (standalone, this box):** drain **41 PASS / 0 FAIL** + 7/7 must-FAIL; rail **32 PASS / 0
FAIL** + 18/18 must-FAIL (incl. C11/absent·directory·recreated); ledger **63 PASS / 0 FAIL** +
must-FAIL; vacuity **24 guarded / 0 unguarded**, 24/0.

**`gate` PASS** (exit 0, read directly — leak-gate + check-nul + typecheck). **`board:check`**
exits 1 on exactly the **5 pre-existing drift problems** (BUG-169, FEAT-129, FEAT-131, FEAT-132,
ARCH-007 — all UNMAPPABLE-STATUS / UNREACHABLE-TICKET, none touched by ARCH-017); STALE-doc WARNs
and the BUG-176/ARCH-017 no-independent-verify advisories are pre-existing, not new. `board:gen`
re-ran. No new drift introduced. Working set left UNSTAGED as dispatched (deliberately staged
files untouched; no git writes).

**Still high-stakes (bucket: session-lifecycle + data-loss + regression-prone).** #1 (echo) and #2
(session guard) are the load-bearing security properties, and W33-W40/C11 were written by the same
lane that made the fixes — self-verification is not the last word. An independent clean-room verify
is still warranted: that the session guard truly refuses on absent/other/recreated in a REAL
browser reload (not a scripted DOM assert), that the seal fails closed under a TRUNCATED concurrent
write of `group-seals.json`, and that the echo defence has no digest-carrying shape any real client
path can reach. The residual untested queue above is unchanged in kind.

### 2026-09-23 — session-audit finding (durable note, no code — FEAT-115 fixing lane)

Filed here because it is the same class this ticket owns: **a dispatched lane's completion is a
fact the orchestrator cannot durably read.** ARCH-017 makes the *result* durable across delivery;
this note records a sibling gap on the *background-resume* path that neither the Working Agreement
nor CONVENTIONS states as a rule, so it was learned mid-session rather than known up front.

- **Observed:** an orchestrator that background-resumes a verify-relay lane **loses it when its own
  turn ends**, because the completion notice is TURN-SCOPED — it can only fire back into the turn
  that was live when the lane finished. Once that turn ends, the notice has nowhere to land, and the
  task list does not persist the lane's terminal state either, so the orchestrator has no surviving
  handle to answer "did it finish?".
- **Cost:** it then spends whole later dispatches reconstructing whether the lane finished, is still
  running, or never started. Measured: ~4 turns on 2026-09-19, plus a repeat of the same loss at
  14:36 the same day.
- **Verbatim, session `0cc1b3b5`** (a human-orchestrator session; the loss is quoted in its own
  transcript): *"resumed in the background. The task list is empty and I have had no report, so I do
  not know whether it finished, is still going, or never started."*
- **Why it belongs on this board / this ticket:** it is the completion-ownership defect class —
  completion owned by a transient (a turn-scoped notice / an in-memory task list) instead of written
  where a later reader will look. The durable receipt/ledger ARCH-017 builds for the blocking path
  is exactly the shape a background-resume lane also needs; whether that mechanism should extend to
  cover turn-crossing completion of a background-resumed lane is a decision for the orchestrator, not
  resolved here. No code changed by this note.

### Round 12 — INDEPENDENT CROSS-PROVIDER VERIFY of the round-11 fixes: DO-NOT-LAND (8th consecutive rejection)

Verified-by: openai codex, run 01a0cb34-09ee-7521-b940-aa0cf4fb90a2 (dispatch --provider openai
--phase verifying --round 12 --class verify, sandbox workspace-write). This lane COMMISSIONED the
review and recorded the verdict only — it did not make or repair any fix. The reviewer was given the
four requirements in plain terms, the diff (working-tree `git diff HEAD` for app.js/lanes.ts + the
new untracked `lane-drain.ts`), the run commands, and the fixer's TEST CODE — NOT the fixer's report,
rationale, or self-assessment. Adversarial objective ("attempt to BREAK the claim"). Verdict is valid
per WA §C: it contains (i) the fixer's own probes re-run with real output, (ii) two self-authored
adversarial cases the fixer's fixtures do not cover, with real command output, and (iii) an explicit
could-not-test list.

**VERDICT: DO-NOT-LAND. 2 NEW findings** against fixes #1 and #3 — new angles the round-11 fixtures
(W33/W34) do not exercise. This is the **EIGHTH consecutive cross-provider rejection** (R5-R12), and
the seventh self-PASS ("finished and committable") externally refuted.

- **NEW #3 — seal fail-closed protects ADMISSION but not DRAINING (Property 3 still broken on a
  second path).** `durableGroupSeal()` now correctly reports a malformed entry as sealed (the r10
  `seals` probe exits 1, fix present for the admission path), BUT `drainLanes.process(['group:g'])`
  still SENDS the result for a group whose seal is malformed — the drain of already-recorded rows
  does not consult the durable-seal validity the way admission does. Reviewer probe (`/tmp/arch017-r12.cjs`,
  exit 0): with `{"g":false}` → `sent:1` and the entry is silently replaced; with
  `{"g":{"at":1,"kind":"bogus","why":"x"}}` → `sent:1` and the bogus entry is left unchanged. W34
  asserts admission + seal lookup, not draining existing rows, so it misses this.
- **NEW #1 — malformed-evidence refusal leaks an 80-char digest prefix (Property 1 incomplete).**
  When `handoffEvidence` is truncated inside otherwise-valid ledger JSON, `acknowledge()`'s refusal
  message includes the first 80 chars of the stored evidence, exposing the digest prefix
  (`expectedPrefix:"0bc743d310f05621"…","leaked":true`). W33 tests the challenge-only response, echo
  rejection, and computed-receipt success, but never inspects this refusal branch. Reviewer's honest
  caveat: the probe injects the damaged evidence directly and does not establish how production
  writes a truncated-but-valid-JSON ledger — but this is exactly the TRUNCATED-CONCURRENT-WRITE class
  the round-11 checkpoint itself flagged as untested.

**Fixes that HELD under this review:** #2 session guard (absent / directory / recreated / replaced-
during-digest all refuse correctly, acks=0 inserted=false — held in isolated execution); #4 retention
rollback case passed and `newLaneId()` uses `randomBytes(9)` directly (though the reviewer notes W35's
suffix-length/uniqueness assertions alone do not PROVE CSPRNG usage).

**Reviewer could-not-test (sandbox `listen EPERM` blocked all socket-integration suites — drain / rail
/ ledger suites each aborted, so mutation harness got no score, and rail C11 could not run):** real
browser navigation/reload for #2, HTTP refusal serialization, real socket peers, and concurrent
truncated writes. The vacuity scan ran (24/0) but is static and proves none of the four RUNTIME
properties. Note the socket-suite EPERM is a sandbox artifact on the reviewer's box, not a code fault.

No git write commands run; working set left as-is. `board:gen` re-run after this append.
