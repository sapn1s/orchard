```orchard-ticket
{
  "id": "FEAT-184",
  "type": "feature",
  "title": "An agent cannot honestly record a decision you delegated to it",
  "summary": "When you have delegated a decision ('do what you recommend'), the board still needs your click to clear the card, because only a user answer counts. Twice an agent instead wrote the answer through the server and it was recorded as yours. There is no honest path for 'adopted under your standing delegation'.",
  "impact_if_we_wait": "Delegated decisions keep coming back to you as clicks. Or an agent writes an answer that the board records as yours, which corrupts the record of who decided.",
  "current_need": "An independent clean-room adversarial verify of the adopt/delegation build (and a round-4 plan review of the final design), then a service restart so the routes go live.",
  "severity": "medium",
  "area": "board decisions",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A `board-tool adopt` verb records an answer as `agent-under-delegation`, linked to a recorded delegation, clears the card, never writes `by: user`.",
    "A delegation is a recorded user statement with scope and revocation; a stale, revoked or out-of-scope one is refused.",
    "The server's answer route refuses an agent-originated write that claims to be the user.",
    "The board and the Decide card show adopted decisions distinctly, and you can override one."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-166",
      "relation": "see_also"
    },
    {
      "id": "FEAT-182",
      "relation": "see_also"
    },
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "FEAT-170",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "c57875f3-7910-4cfd-9103-2522160a3e20",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T09:09:34.630Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room verify BROKEN: lookalike-you display spoof (blocker); store-delete re-migration laundering (two-break); revoke-rollback (r1#2 open). Same-provider fallback. Fixer 56/56 green in room; must-FAIL baseline reproduced. Full detail in Activity log."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
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

# FEAT-184 — An agent cannot honestly record a decision you delegated to it

## Diagnosis

`board-tool decide` never writes an answer (FEAT-166), and only the server's answer route records one. FEAT-164's and FEAT-170's current decisions carry answers noted as 'Decided A on the user's delegation (orchestrator)' and 'Orchestrator decided A ... recorded via decision-answer API per dispatch', both with `by: user`. In this session the FEAT-182 card needed the user's click although the user had delegated.

## Evidence

docs/research/unnecessary-asks-2026-10-14.md. The measured share is small: 1 ask in the corpus, plus the 2 impersonated answers. The OpenAI refutation run 01a13949 kept it (P4 KEEP) on these conditions: source-linked delegation, scope checks, revocation, a distinct actor, separate execution status, and no API writes that impersonate the user. It also flagged a missing piece, durable scoped authorisation across sessions, which this ticket's delegation store provides.

## Implementation notes (plan)

1. A delegation store: an append-only `docs/bugs/delegations.json` (or the registry), written only by the server's user-facing route, holding the user's verbatim statement, scope, date and revocation.
2. The `adopt` verb in `scripts/board-tool.mjs` writes the answer with the new actor and the delegation id, and is refused without a live in-scope delegation.
3. `ticketAnswerState` treats an adopted answer as answered, and the rail renders it as 'adopted under delegation'.
4. The answer route rejects `by: user` from a non-user origin.
5. Agents are told to use `adopt` (RESPONSE_FORMAT, WA §B 'settled decision').

## Risks

This widens who can close a decision, so it is security-adjacent and needs a clean-room adversarial round. Laundering authority through a broad or stale quote is the main attack.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — finding lane (round 1)
- **Filed with plan:** Filed with a plan from the 2026-10-14 ask study (docs/research/unnecessary-asks-2026-10-14.md). Evidence of the gap: FEAT-164 and FEAT-170 current decisions carry orchestrator-written answers recorded by: user ('Decided A on the user's delegation (2026-10-05, orchestrator)'; 'Orchestrator decided A … recorded via decision-answer API per dispatch'), and the FEAT-182 card needed a click under an existing delegation. OpenAI run 01a13949-5094-7161-bdee-4954fda87510: P4 KEEP with source-linked, scoped, revocable delegation, distinct actor, separate execution status, and no API writes impersonating the user; it also named durable scoped authorisation across sessions as missing, folded in here. Not built in this lane: it widens who can close a decision (security-adjacent) and scripts/board-tool.mjs / src/server/board.ts carry another lane's uncommitted edits.

### 2026-10-14 — worker (FEAT-184 fixing r1)
- **Fork found before build — stopped:** Hypothesis "buildable as written, plan review the only gate" is REFUTED on one point; nothing built, no plan review run (the fork precedes it). THE FORK: the only evidence of the FEAT-182 delegation is a transcript turn, and a transcript turn cannot prove the user wrote it. Evidence: the quote "first gather data and do whatever u recc" is session 20ed61fc-8795-4e73-9317-798132edf77d, message 1b7500bb-348a-48db-a57c-23ede92d1327, 2026-10-13T17:05:22Z, type user, promptSource sdk, session provenance startedBy=user source=agent-bridge. But (1) agent-bridge records startedBy=user for EVERY bridge session (agent-bridge.ts: opts.startedBy ?? user; 108 user vs 2891 agent provenance records), including one an agent opens through the API; (2) the WS start/send path checks only Host/Origin headers (index.ts verifyClient), which a non-browser client sets freely; requireUserCaller (caller-provenance.ts) guards only 5 git/path routes; (3) user-role turns also carry injections (board snapshot, [station], task-notification, dispatch charters): session 19d7373f has a board-snapshot user turn containing "do whatever u recc". So an agent can manufacture a byte-identical "user" turn, and the 2026-10-13 message predates any per-message caller stamp, so no mechanism can tell it from a relayed one. CONSEQUENCE: "use the new path to close FEAT-182 now" and "a forged delegation must be refused" cannot both hold. OPTION 1 (plan step 1 as written, recommended): delegations are written ONLY by a requireUserCaller-gated server route; an agent may PROPOSE one citing the transcript pointer above, and the user confirms it once on the dashboard; FEAT-182 then closes via board-tool adopt, and that delegation covers later decisions in its scope. Cost: one user action for FEAT-182 (no fewer than clicking Adopt A today), the route needs a service restart to go live, and the confirm UI touches public/app.js (BUG-255 lane is editing it). OPTION 2: board-tool verifies a transcript source itself (explicit startedBy=user record, whole-message match, non-meta, non-injection) and records the delegation without a click. FEAT-182 closes now. Residual: an agent that relays a message through the WS/API is accepted as the user; closing that for future messages needs a caller stamp on WS send (index.ts), and it can never be closed for past messages. Independent of the fork and safe to build either way: plan step 4, the requireUserCaller gate on tickets/:id/answer and the board/answer ticket branch (how the FEAT-164 and FEAT-170 by:user answers were written), plus steps 2, 3 and 5 against whichever delegation source is chosen.

### 2026-10-14 — worker (FEAT-184 fixing r1)
- **Fork decided by the orchestrator:** The orchestrator (not the user) decided OPTION 1 on 2026-10-14. Reason given: option 2 lets an agent forge a delegation (a relayed WS/API message is byte-identical to a user turn), which breaks the core property that an agent can never create something that reads as the user; so option 1 is the only correct answer and this is not a user fork. Build: delegations are recorded ONLY by a user-only (requireUserCaller-gated) server route; an agent adopts a decision only by citing a delegation recorded there. FEAT-182 stays blocked until the user confirms its delegation once through that route; no route-around.

### 2026-10-14 — worker (FEAT-184 fixing r1)
- **Built; demo 56/56; needs independent verify:** BUILT (option 1, orchestrator decision above); NOT self-verified; needs an independent clean-room adversarial round (security-adjacent: widens who can close a decision; touches the answer routes and the typed-answer reader, files with a regression history).
  PLAN REVIEW (OpenAI, codex default, read-only): r1 thread 01a13962-2439-7b73-9480-bda11b6a55df REJECT (7 findings); r2 01a13965-c45b-7fc3-b216-b08a2c088774 REJECT (actor flip to by:user, key residual, crash recovery, cross-process race); r3 01a13979-e399-7880-8c76-551f6d437aa6 REJECT (receipts did not bind content; first-line/migration crash recovery; reclaim race in the lock). All r3 findings were fixed after that review; NO round-4 review was run, so the plan gate is not closed on the final design.
  WHAT: (1) scripts/lib/delegation-source.mjs: the authority store OUTSIDE the board, <dataDir>/delegations/<sha256(realpath board)>.jsonl, append-only, every entry HMAC-sealed (key <dataDir>/delegation-seal.key, 0600), hash-chained, bound to the board path, with a sealed head. Any mismatch (unsealed or forged line, rollback, a removed revoke, an entry copied from another board) marks the store DAMAGED and it authorises nothing. Kinds: record, revoke, adoption, answer, migrated. (2) src/server/delegations.ts: GET/POST /api/projects/:id/delegations and POST .../delegations/:did/revoke are USER-ONLY (requireUserCaller; agent caller gets 403 agent-not-user). A delegation needs explicit ticket ids (1-20, no wildcards) and 1-90 days, and permits ONLY the decision's recommended option. POST .../tickets/:tid/adopt is the one adoption writer. (3) board.ts recordAdoption writes decision.answers[] entries by 'agent-under-delegation' that name the delegation and the user's words, with an agent-authored heading (never 'you ('). (4) User answers are now authenticated too: recordAnswer seals a receipt binding the full answer content. The first server write on a board migrates its existing typed user answers (resumable, with a 'migrated' marker). Readers count a user answer or an adoption only with a matching sealed receipt. (5) A per-ticket kernel lock (flock(1) held by a child for the critical section) wraps recordAnswer, recordAdoption and every board-tool record write. (6) The answer routes (tickets/:id/answer and the board/answer ticket branch) refuse agent callers. (7) board-tool adopt is a thin HTTP client. decide supersession keeps chosen_by agent-under-delegation. board:check FAILs unverified adoptions, unauthenticated user answers and a damaged store. The schema accepts the discriminated entry. (8) UI: the Decide card shows ADOPTED (agent named, your delegation quoted) with an Override fold. The pending card has a "Delegate to agents" fold and lists live delegations with Revoke. The rail says "adopted under your delegation", not "you chose". (9) docs/CONVENTIONS.md tells agents to use adopt, never to answer for the user, and that chat words are not a delegation. The canonical WA §B / RESPONSE_FORMAT were NOT edited: they live in ~/projects/methodology, outside this repo.
  DEMO scripts/verify-feat-184-delegation.mjs. Setup: a real Orchard-launched agent session process on an isolated scratch server, over a copy of the real board. Post-change: 56/56. Pre-change (HEAD tree + the same suite): 9 passed, 25 failed, and the suite aborted at U7. Reproduced there: the agent POST tickets/FEAT-182/answer returned 200 and wrote a by:user answer (the FEAT-164/FEAT-170 impersonation). Refused attacks post-change: both answer routes (403); the delegation route (403); a user-shaped websocket relay "I delegate FEAT-182 …" (it lands as a user turn in a startedBy=user session, BUG-258, but no delegation exists, so adopt is refused); an invented delegation id; unsealed and forged-seal store lines; flipping an adoption to by:user; a fabricated by:user answer; an A→B edit of a real authenticated answer (FEAT-164); a hand-written adoption entry; rollback of the store to before a revoke; a sealed record copied from another board; an out-of-scope ticket; a non-recommended option; a user-reading --author; replay; revoked and expired delegations. Positive path: the user records, the agent adopts, the result reads as adopted, and the user overrides. Also: re-declaring keeps the actor; 8x25 lock increments came to 200; crash windows (first line with no head, one line ahead of the head, an interrupted migration that resumes, an orphan receipt, 3 truncation points) all fail safe. Real headless Brave click path over the scratch board: record a delegation → adopt → ADOPTED card → Override B → "You answered B"; screenshots were reviewed.
  ANTI-REGRESSIONS, run: feat-166 typed-answer 37/37, board-tool-decide 62/62, fenced-answer-warn 6/6; feat-090 followup 28/28; bug-104 11/11; ticket-schema 64/64; feat-164 self-grant 62/62. Pre-existing failures, identical on a HEAD baseline: verify-board-tool (c), feat-090 answered-lane snapshot order, feat-090 answer-handoff PRECONDITION; feat-166 answer-binding needs a pinned pre snapshot. A first build broke feat-090 followup (the delegate fold reused the .dc-note/.dc-send classes); fixed with its own classes and placed below the answer form.
  ORCHESTRATOR FYI (type-strip import fails under concurrency): REPRODUCED and ROOT-CAUSED. It was not concurrency. During the build, delegations.ts held a raw U+2028/U+2029 inside a regex literal: tsc accepts that, Node's parser rejects it ("Invalid regular expression: missing /"), and every board-tool verb that loads tickets.ts failed. On a copy with that byte, 10/10 parallel board-tool runs fail; on the fixed tree, 40/40 and 20/20 parallel runs pass. Fixed to \u escapes. Not added: a gate check for raw line separators in regex literals (two tracked files hold U+2028 legitimately in strings, so a blanket byte check would be wrong).
  RESIDUALS (same uid, stated): a process that deliberately reads the seal key can forge seals. Deleting BOTH store files returns a board to legacy trust until the next server write re-migrates. Restoring an older file+head pair replays it. Tests that call recordAnswer unisolated now also write a per-board store under the real data dir (seen from concurrent suites; I removed the stale ones under /tmp). The routes go live only after a service restart.
  FEAT-182: left BLOCKED/👤, not routed around. To close it: restart the service, open FEAT-182 → "Delegate to agents" → record the delegation once, then an agent runs board-tool adopt.

### 2026-10-14 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run c57875f3-7910-4cfd-9103-2522160a3e20 — VERDICT: BROKEN — Clean-room verify BROKEN: lookalike-you display spoof (blocker); store-delete re-migration laundering (two-break); revoke-rollback (r1#2 open). Same-provider fallback. Fixer 56/56 green in room; must-FAIL baseline reproduced. Full detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — verify lane (round 1)
- **Independent clean-room verify — BROKEN:** Clean-room independent verify via scripts/independent-verify.mjs. Verdict BROKEN (VALID, manifest-backed); typed entry in verification[] run c57875f3-7910-4cfd-9103-2522160a3e20. SAME-PROVIDER (anthropic author -> anthropic verifier): OpenAI quota was exhausted (resets ~15:15), fell back to Claude per charter rather than parking — a cross-provider OpenAI pass after reset is still warranted for this security/answer-authority change. SETUP (FEAT-166 precedent): throwaway scratch repo feat184-iv.EEdPg2, base..head diff = exactly the 14 FEAT-184 files layered on the current tree (dangling 7c7f1f92..de30e441); methodology stripped; real board supplied via --allow-input docs/bugs with FEAT-184's own ticket removed so the fixer's report never reached the verifier; docs/research stayed stripped. GATE: the fixer suite verify-feat-184-delegation.mjs ran 56/56 exit 0 in the room (manifest cd85da7bed61), and the MUST-FAIL baseline on a coherent pre-FEAT-184 tree reproduced 9 passed / 25 failed, aborted at U7, with A1 agent POST tickets/FEAT-182/answer -> {status:200, by:user} — matches the ticket. BREAKS: (1) BLOCKER/display (run c57875f3, adversarial lookalike-you-author): the READS_AS_USER guard /^\s*(you|user|the user)\b/i in scripts/lib/delegation-source.mjs accepts Unicode lookalikes — leading U+200B/U+2060, Cyrillic you, quoted "you" — so composeAdoptionEntry writes a heading and the Decide card renders 'you (orchestrator) adopted A...', reading as the user's own act; authority/counting still hold (typed by stays agent-under-delegation, not counted as a user answer). Reopens r1#1 at the DISPLAY layer. Minimal fix: NFKC-normalise + reject non-ASCII/whitespace/quote-wrapped authors in READS_AS_USER. (2) MAJOR/same-uid-fs (run a1dbf62a): deleting BOTH store files drops the board to legacy trust, an agent-fabricated by:user answer then counts, and the next server write's re-migration seals it into a permanent receipts-mode receipt with board:check silent — TWO-BREAK STOP fired (second, distinct path to r2#1, not the F6 actor-flip) -> route to independent design review of the laundering path. (3) MAJOR/same-uid-fs (run a1dbf62a): restoring the pre-revoke (file,head) pair revives a revoked delegation undetected, no key — r1#2 still OPEN. PLAN-REVIEW FINDINGS: CLOSED as exercised green — r1#3,#4,#5,#6,#7; r2#1(actor-flip path),#3; r3 R1(A->B content-binding),R3(migration crash windows E3/E4/E5/E7/E8),R4(flock kernel lock, L2 8x25->200). STILL OPEN — r1#2 (revoke rollback), r2#1 via store-delete/re-migration laundering (two-break), r2#2 (0600 key same-uid readable, untested stated residual), and the NEW lookalike-author display spoof. LIMITATIONS: mixed-state diff — index.ts/app.js carry heavy FOREIGN hunks (FEAT-164 git-routes, BUG-255 UI), disclosed to the verifier; requireUserCaller shared with FEAT-164 routes. The store-fs breaks (a1dbf62a) and the lookalike break (c57875f3) were found in SEPARATE dispatches — no single run exercised both plus the browser UI render. ARTIFACTS under ~/.local/state/claude-station/scratch: clean room cleanroom-verify-kJSXE0, manifest cleanroom-record-NBnV2E/manifest.jsonl, scratch repo feat184-iv.EEdPg2. HIGH-STAKES; generation was not its own only verifier (independent clean room) but cross-provider decorrelation was reduced by the same-provider fallback.

### 2026-10-14 — worker (FEAT-184 fixing r2)
- **ADJUDICATION (orchestrator, non-author, 2026-10-14) — recorded verbatim:**
  (1) Display spoof (the READS_AS_USER guard accepts Unicode/quote lookalikes, so an adoption renders as "you adopted A"): REDESIGN at the render. WHO decided is rendered ONLY from the typed entry kind (user-answer vs agent-under-delegation vs agent-owned), never from agent-supplied text. Agent text is rendered as quoted agent content, visibly attributed to the agent. Delete the text-matching READS_AS_USER guard, or keep it only as a write-time lint; it must never be the protection.
  (2) The two-break on answer counting via store-delete → re-migration laundering, and other same-uid filesystem paths: RESCOPE. The threat model (CONVENTIONS: the guards stop autonomous mistakes, not a malicious same-uid agent) excludes deliberate tampering with the store files by a process running as the user. Record this as a disclosed residual in the ticket and in the CONVENTIONS section on delegation. Also make re-migration refuse to run when the store is missing but delegation/adoption records exist elsewhere (fail loud, don't recreate), because an accidental delete is in scope.
  (3) Revoke-rollback (r1#2): fix it. Revoking a delegation must not roll back or rewrite adoptions already made under it. They stay, marked "delegation since revoked", and no new adoptions are accepted.

### 2026-10-14 — worker (FEAT-184 fixing r2)
- **PAUSED for quota, 2026-10-14 — code changes done, demos + gate NOT run:** Paused at the orchestrator's request (user needs the Claude quota for BUG-255) at a consistent point — no half-applied edit. DONE (all source edits complete and internally coherent): (1) display REDESIGN — src/server/board.ts `composeAdoptionEntry` now writes a FIXED heading `### <date> — an agent (adopted under delegation <id8>)` (actor derived from entry kind, never from `adoptedBy`), and records the agent's self-named label as a QUOTED bullet `- **Adopted by (the agent's own label, not you):** "<author>"`; public/lib/decide.js `renderAdopted` now shows a fixed subject "Adopted by an agent" and renders `adopted_by` separately as a quoted `<q>` attributed to the agent (new .dc-adopt-agent); the READS_AS_USER regex in scripts/lib/delegation-source.mjs is kept but DEMOTED to a documented write-time lint (comment rewritten) — it is no longer the protection. (2) fail-loud re-migration — `ensureBoardStore(dataDir, boardDir, legacy, { hasAdoptions })` in delegation-source.mjs now THROWS `delegation-store-deleted` when the store is absent but the board still carries adoptions (evidence the store was deleted); new `boardHasAdoptions(dir)` in board.ts is wired as the evidence at both callers (sealAnswerReceipt, delegations.ts record route); .d.mts signature updated. Same-uid tampering rescope still owed in CONVENTIONS + ticket residual (NOT yet written). (3) revoke-rollback — adoptions are never rolled back by a revoke (confirmed: revoke only appends a revoke entry, adoptionVerified still finds the receipt); added `adoptionDelegationRevoked(file, did)` in board.ts, surfaced as `delegation.revoked` on TicketAnswerState, rendered as a "you have since revoked this delegation — the adoption stands…" note (new .dc-deleg-revoked); adopt route already refuses new adoptions under a revoked delegation (liveDelegation). REMAINS: write the 3 must-FAIL synthesized demos (display spoof, store-delete loud-fail, revoke-marked); add the disclosed same-uid residual to docs/CONVENTIONS.md delegation section + a ticket Risks/residual note; run `npm run gate` (NOT yet run — typecheck unverified); then independent (cross-provider) verify. TREE: unstaged edits to src/server/board.ts, src/server/delegations.ts, public/lib/decide.js, public/styles.css, scripts/lib/delegation-source.mjs, scripts/lib/delegation-source.d.mts; no new files yet; no git writes; service NOT restarted.
