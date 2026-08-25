# Orchestrator design B — a cross-provider proposal

**Date:** 2026-08-20 · **Lane:** orchestrator-design-B · **Nothing was built; no code
changed.**

**This document is not mine.** The design in Part 2 was produced by **OpenAI
`gpt-5.6-sol`**, reasoning independently, with no sight of the parallel design-A lane.
My role was to brief it and bring its answer back faithfully. It is reproduced
**verbatim** — not summarised, not smoothed toward the house view, not merged with my
own opinions. My disagreements are quarantined in Part 3.

| | |
|---|---|
| Provider | `openai` (Codex runtime, via `npm run dispatch`) |
| Model | `gpt-5.6-sol` |
| **Dispatch run id** | **`01a01e74-6b8d-7bd2-87fc-e10db45804a8`** |
| Sandbox | `read-only`, cwd = this repository |
| Exit | 0 (no quota failure; the weekly window had reset) |
| Run tokens | 54,017 total — 46,633 in (37,632 cached), 7,384 out |

---

## Part 1 — What it was asked, and what it was given

The question put to it, unchanged:

> **What should the orchestrator role actually be, architecturally, so that it only
> orchestrates and relays — and can run on a cheap model?**

It was told, and it had read-only access to the repository to check any of it:

- The user's own framing — *"i have always wanted orchestrator to truly have one job:
  orchestrate and relay info… i do not actually want you to directly reason and find
  info EVER, that is actually unfortunate thing i have given up on solving as its not
  possible even with instructions u just keep doing it"* — and the explicit instruction
  that **a proposal resting on better instructions is not a proposal**, because
  instruction-based enforcement has already failed, most visibly when the orchestrator
  wrote `spend-reduction-plan-2026-08-20.md` inline while that plan was about not
  working inline.
- The hard interaction shape: acknowledge briefly, dispatch, and **say nothing more
  until the work is complete or blocked on a decision only the user can make**.
- The measured facts, with sources: 93.2% of orchestrator spend is context maintenance;
  $444/Mtok of output for the orchestrator against $131 for a lane; ~11.8k / $0.046 lane
  cold start against $0.25 for one orchestrator tool call; dispatch as a compression
  boundary (62M tokens in, ~1.1k out); 49% of defects from facts re-derived by readers
  instead of declared by owners; one structured verdict written in a whole window; and
  the 88%-recall / **0-of-7** report-checker result.
- **The user's correction, issued mid-brief and passed through before dispatch:** that
  the orchestrator catching bad lane reports *"may seem like a benefit but that itself
  is architecture issue"*. The brief therefore forbade answering "where does the
  sceptical read live" by relocating it to another reader at any tier, and required
  instead a mechanism by which **a false claim fails on its own, without any reader
  being careful**.
- Required contents: exact tool surface (especially what it must *not* have, and how the
  absence is enforced); where charter framing comes from; how results are relayed
  without interpreting prose; what replaces the sceptical read; model tier and what
  breaks at each; **cheap falsifying experiments**; and what it would deliberately not
  change.
- Reading list: `inline-vs-dispatch-crossover-2026-08-20.md`,
  `defect-origin-2026-08-20.md`, `spend-reduction-plan-2026-08-20.md`,
  `spend-plan-review-2026-08-20.md`, `pipeline-cost-2026-08-20.md`, `COST-METHOD.md`,
  `docs/prompts/WORKING_AGREEMENT.v2.md` §I, and `scripts/dispatch.mjs`.

---

## Part 2 — The design, verbatim as returned

*(Everything from here to the Part 3 marker is `gpt-5.6-sol`'s text, unedited.)*

---

# The orchestrator should be a protocol endpoint, not an agent

## Position

The long-lived Opus session should cease to exist.

The orchestrator should be a small, capability-restricted workflow controller whose only semantic operation is relaying typed messages between the user and independently dispatched lanes. It should not inspect the repository, compose technical charters, evaluate reports, choose fixes, maintain the ticket index by hand, or decide whether work is correct.

Most of the role does not require a model at all. A Haiku-class model may be used as a lossy natural-language adapter at the two human boundaries:

1. mapping a user message into a coarse request envelope; and
2. rendering a completed machine-validated result for the user.

Neither operation grants it authority to make a technical assertion. If the adapter fails, the workflow fails closed or asks the user a question. It never falls back to doing the work itself.

The architectural unit is:

```text
user
  │
  ▼
ingress controller ── immediate acknowledgement
  │
  ▼
framing lane → workflow manifest → work lane(s) → evidence runner
                                             │
                                             ▼
                                      result envelope
                                             │
  ┌──────────────────────────────────────────┘
  ▼
relay renderer
  │
  ▼
user: completed result, or a decision request
```

The controller sees envelopes, identifiers, and terminal states. It never sees repository contents or free-form lane reports.

This is not a better instruction for the existing orchestrator. It is a replacement for it.

---

## 1. Exact orchestrator tool surface

The orchestrator process gets exactly these operations.

### 1. `submit_request`

```ts
submit_request({
  user_message: string,
  conversation_constraints: Constraint[],
  idempotency_key: string
}) -> {
  workflow_id: string,
  accepted_at: string
}
```

This submits the user’s original words, unchanged, to the workflow service. The controller does not write a charter.

`conversation_constraints` contains only facts the user explicitly established in the current conversation, represented with provenance:

```json
{
  "kind": "user_constraint",
  "text": "Do not change the API response shape",
  "source_message_id": "msg-184"
}
```

No inferred diagnosis, file name, cause, or implementation recommendation is permitted in this field.

### 2. `wait_terminal`

```ts
wait_terminal({
  workflow_id: string
}) ->
  | ResultReady
  | UserDecisionRequired
  | WorkflowFailed
```

This is a blocking/event-driven wait owned by a service that outlives the model turn. It returns only on a terminal state or a decision that only the user can make. Progress events are retained in the workflow record but are not exposed to the conversational model.

This enforces the required interaction shape: acknowledge once, then remain silent until completion or a genuine human decision.

### 3. `relay_result`

```ts
relay_result({
  workflow_id: string,
  result_token: string
}) -> RenderedUserMessage
```

The workflow service, not the orchestrator model, resolves `result_token`. Rendering is schema-driven. The model cannot substitute its own result text.

For prose-heavy deliverables, `RenderedUserMessage` may contain the lane-authored artifact verbatim. The relay layer may add fixed labels such as “Completed,” “Blocked,” or “Evidence unavailable,” but cannot summarize or reinterpret the artifact.

### 4. `relay_decision_request`

```ts
relay_decision_request({
  workflow_id: string,
  decision_token: string
}) -> RenderedDecisionQuestion
```

The request must carry a schema-valid set of mutually exclusive options, consequences, and the exact reason automation cannot choose. The orchestrator may relay it but cannot invent an option.

### 5. `submit_decision`

```ts
submit_decision({
  workflow_id: string,
  decision_id: string,
  selected_option: string,
  user_text: string
}) -> { accepted: true }
```

The user’s response is passed through unchanged.

### 6. `cancel_workflow`

```ts
cancel_workflow({
  workflow_id: string,
  reason: "user_requested"
}) -> CancellationResult
```

This is available only after an explicit user cancellation request. The workflow service owns process-group termination and records what was stopped.

### 7. `get_public_status`

```ts
get_public_status({
  workflow_id: string
}) -> {
  state: "queued" | "running" | "waiting_for_user" | "complete" | "failed",
  started_at: string,
  last_heartbeat_at: string
}
```

This exists only to answer an explicit user status question. It exposes no intermediate findings and produces no unsolicited progress narration.

## Tools it must not have

The orchestrator gets none of the following:

- filesystem read, glob, search, or directory listing;
- shell execution;
- git access;
- file editing or writing;
- web search or page retrieval;
- direct database or board access;
- arbitrary agent spawning;
- arbitrary prompt construction;
- direct access to `scripts/dispatch.mjs`;
- lane transcripts, stderr, or free-form reports;
- test execution;
- commit, merge, deploy, or ticket mutation;
- general-purpose MCP/connectors;
- a “send arbitrary text to user” operation after workflow submission.

That last omission matters. If the model can freely answer the user, it can still work inline using prior knowledge. During an active workflow, the conversational gateway accepts only:

- the fixed acknowledgement returned by `submit_request`;
- output returned by `relay_result`;
- output returned by `relay_decision_request`;
- a schema-derived status answer following an explicit status query.

There is no generic final-response channel for the model during that interval.

## Enforcement mechanism

Use a separate orchestrator binary and service identity, not the normal agent CLI with tools hidden by prompt.

The binary should:

1. expose only the seven RPCs above;
2. run without a mounted repository;
3. run in a container or OS sandbox with no shell and no filesystem workspace;
4. have network access only to the workflow service;
5. possess a capability token accepted only by orchestration endpoints;
6. reject arbitrary dispatch prompts at the workflow API;
7. enforce allowed outbound user messages at the conversation gateway.

The workflow workers have different identities and permissions. A work lane may receive repository read/write access; an evidence runner may receive an immutable clean-room checkout and execution access. The orchestrator credential cannot be upgraded into either.

This makes inline repository investigation impossible. Inline general reasoning remains physically possible for any language model, so it must also be made operationally irrelevant: the gateway does not allow model-authored technical output to reach the user while a workflow is active.

Audit should record any rejected attempt to call an unavailable operation or emit unauthorized text. Such an attempt is visible immediately and cannot affect the work.

---

## 2. Charter framing belongs to a framing lane

A charter currently contains the orchestrator’s interpretation because the orchestrator has already inspected the problem. Removing repository access leaves three possible framers:

- the user;
- a template;
- an investigative lane.

The correct division is all three, with sharply different ownership.

### Ingress creates a request envelope, not a charter

The initial envelope contains:

```json
{
  "schema_version": 1,
  "workflow_id": "wf-...",
  "user_request": {
    "verbatim": "...",
    "message_id": "msg-..."
  },
  "explicit_constraints": [],
  "requested_effect": "diagnose | change | design | verify | unknown",
  "repository_ref": {
    "project_id": "orchard",
    "base_revision": "..."
  }
}
```

`requested_effect` is coarse routing, not technical diagnosis. If it is unclear, use `unknown`; do not guess.

A deterministic routing table selects the first workflow:

| Request shape | First lane |
|---|---|
| Exact mechanical command already named by user | execution lane |
| Question about repository facts | investigation lane |
| Change request without an established cause | investigation/framing lane |
| High-impact design or architecture | design lane, then adversarial experiment/validation workflow |
| Verify an existing change | evidence runner/verifier |
| Ambiguous desired outcome | user decision request |

The cheap adapter may suggest the row, but the workflow service validates it against conservative rules. `unknown` routes to investigation, not inline reasoning.

### The framing lane owns the hypothesis

The first repository-capable lane receives:

- the user’s words;
- explicit user constraints;
- the pinned base revision;
- a minimal typed project-state snapshot;
- the required output schema.

It investigates and emits a `FramingManifest`:

```json
{
  "request_id": "wf-...",
  "base_revision": "abc123",
  "observations": [
    {
      "fact": "The failing path is invoked by src/server/...",
      "evidence_ref": "artifact://run-17/observations/3"
    }
  ],
  "hypothesis": {
    "statement": "...",
    "status": "guess",
    "falsifier": "..."
  },
  "scope": {
    "included": ["..."],
    "excluded": ["..."]
  },
  "proposed_work_class": "fix | explore | design | docs | verify",
  "acceptance_claims": [
    {
      "claim_id": "C1",
      "statement": "...",
      "verification_method": "..."
    }
  ],
  "decision_required": null
}
```

This preserves the existing falsifiable-hypothesis rule while removing the contaminating source. The hypothesis comes from the first agent that actually inspected the evidence and remains labelled `guess`.

For a build, the framing lane must finish before an implementation lane is created. The implementation lane receives the manifest and evidence references, not a charter rewritten by an orchestrator.

If investigation discovers multiple defensible meanings of the user’s request, the lane emits a typed `UserDecisionRequired`. It does not recommend one unless the user asked for a recommendation. The controller relays the options.

### Preventing framing contamination

The same lane must not both converge on a diagnosis and silently promote it into fact. Therefore:

- observations require evidence references;
- hypotheses are structurally distinct from observations;
- acceptance claims bind to the verbatim user request;
- the implementation lane must return `framing_rejected` if its first concrete probe falsifies the hypothesis;
- a rejected hypothesis loops to a fresh framing lane with the falsifying artifact attached.

This does not make the hypothesis correct. It makes its epistemic status declared by its owner rather than inferred from prose.

---

## 3. Results must be data plus artifacts, not reports

`stdout = final text` is suitable for human consumption but insufficient as an orchestration protocol. Keep it for direct CLI compatibility, but add a required structured result file or framed JSON channel. `--meta-out` already demonstrates the right pattern: durable structured metadata must not be scraped from human-oriented stderr.

A lane completion is accepted only as a `LaneResultEnvelope`:

```json
{
  "schema_version": 1,
  "workflow_id": "wf-...",
  "run": {
    "provider": "openai",
    "run_id": "...",
    "model": "...",
    "started_at": "...",
    "finished_at": "...",
    "base_revision": "abc123",
    "result_revision": "def456"
  },
  "outcome": "completed | no_change | blocked | failed | framing_rejected",
  "claims": [
    {
      "claim_id": "C1",
      "status": "satisfied | unsatisfied | untested | inapplicable",
      "attestation_ref": "attestation://verify-run/C1"
    }
  ],
  "changes": [
    {
      "path": "src/...",
      "blob_before": "...",
      "blob_after": "..."
    }
  ],
  "open_items": [
    {
      "kind": "known_defect | untested_surface | follow_up",
      "statement": "...",
      "blocks_completion": true
    }
  ],
  "decision_request": null,
  "user_artifact_ref": "artifact://run/final.md"
}
```

### Field ownership

- The dispatch wrapper owns provider, run ID, timestamps, model, exit state, and transcript reference.
- Git/workspace machinery owns revisions, changed paths, and blob hashes.
- The framing lane owns the hypothesis, scope, and acceptance-claim definitions.
- The work lane owns declared changes and open items.
- The evidence runner owns claim statuses and attestations.
- The workflow engine computes the aggregate workflow state.
- The renderer owns fixed user-facing labels.
- The user-facing artifact belongs to the lane that produced it and is relayed verbatim.

No model declares facts that a lower-level authority can measure.

### Malformed returns

A malformed result is not shown to the orchestrator and is not “interpreted generously.”

The result ingester:

1. rejects invalid JSON or unknown schema versions;
2. rejects missing required fields;
3. rejects inconsistent revisions or run IDs;
4. rejects `satisfied` without an attestation;
5. rejects undeclared changed files;
6. rejects `completed` when any blocking open item exists;
7. records `protocol_failure`;
8. permits one automatic protocol-repair resume in the same lane, supplying only validation errors;
9. after a second failure, terminates as `WorkflowFailed`.

The user then sees a fixed failure message with the run ID and protocol error, not a model’s reconstruction of what the lane “probably meant.”

### Ticket and INDEX handling

A successful result produces a board event:

```json
{
  "ticket_id": "BUG-...",
  "event_type": "verification_recorded",
  "workflow_id": "wf-...",
  "run_id": "...",
  "revision": "...",
  "verdict": "holds | broken | invalid",
  "defect_class": "...",
  "regressed_from": null
}
```

Append-only ticket history can remain. `INDEX.md` should become a generated projection of typed events, rebuilt by a deterministic board process. It must no longer be manually owned by an LLM orchestrator. An orchestrator that cannot read or write the repository cannot honestly own it.

This directly closes the substance of G2 and G3: verdict and dispatch class become fields rather than prose judgments.

---

## 4. Replace sceptical reading with executable attestations

The replacement is not another report reader. It is an evidence authority that reruns claims and produces attestations bound to an immutable subject.

### Mechanism: claim-bound clean-room attestation

For each acceptance claim, the framing manifest must name a verifier type:

- executable test;
- invariant/property test;
- static structural check;
- artifact comparison;
- human acceptance;
- epistemic-only, meaning not mechanically decidable.

For mechanically testable claims, a trusted runner—not the work lane—does this:

1. resolves the exact result revision/tree hash;
2. constructs a clean room from that immutable revision;
3. records an environment fingerprint;
4. reruns the producer’s named test;
5. runs at least one independently selected adversarial probe;
6. captures command, exit code, stdout/stderr digest, and produced-artifact hashes;
7. checks non-vacuity by running the same test against a known-bad subject where feasible;
8. signs or MACs an attestation over the claim, subject revision, environment, and evidence;
9. returns the attestation directly to the workflow engine.

The lane cannot manufacture or edit this attestation. The workflow engine accepts `satisfied` only when the attestation:

- names the expected claim;
- binds to the exact result revision;
- is fresh for this workflow;
- comes from the evidence-runner identity;
- records actual execution;
- passes the verifier-specific policy;
- uses a verifier run ID different from the producer run ID.

A stale snapshot, wrong commit, missing execution, self-verification, or prose-only assertion fails mechanically.

This is stronger than the present rule that a verifier’s final text must contain commands and output. The current rule still asks a reader to decide whether those blocks mean what they claim. An attestation is generated from the process supervisor’s observations, not copied from the model’s prose.

### Who runs it

A small trusted execution service runs the clean room and attestation wrapper. A verifier agent may generate an adversarial test case, but it does not assign the verdict. The runner assigns only mechanical facts:

- this exact command ran;
- on this exact subject and environment;
- it exited with this status;
- this artifact was produced;
- the non-vacuity subject behaved differently.

The workflow engine applies the predetermined policy to those facts.

### Cost

The repository measurement says clean-room setup cost about $0.36 per round and 16 seconds in the superseded pipeline-cost arithmetic; its absolute dollars should not be treated as exact because `COST-METHOD.md` documents transcript-accounting corrections. The robust conclusion is that setup was only 8.7% of verification cost, while attacking was about 71%. The current median whole verification lane was reported as $4.09 and seven minutes under that same superseded arithmetic.

The new wrapper adds negligible model cost and some local compute. Generating adversarial probes remains a lane cost. A reasonable initial budget is therefore approximately one existing verification lane per material code change, plus the measured dispatch overhead of about $0.60. This is a guess until the experiment below measures it under the corrected collector.

### What this catches automatically

It catches false claims caused by:

- invented execution;
- tests run against the wrong revision;
- stale or mutable snapshots;
- omitted exit status;
- self-verification;
- missing required evidence;
- tests that never ran;
- simple vacuous tests that also pass on a known-bad subject;
- a lane saying “green” while the clean-room execution is red;
- a result being changed after verification.

### What it still cannot catch

It cannot prove that the acceptance claims fully express the user’s intent.

A perfectly executed test can attest to the wrong requirement. An adversarial generator can omit the boundary that matters. A visual or experiential claim may lack a reliable executable oracle. A malicious or systematically mistaken framing lane can produce a coherent but incomplete claim set.

This is the irreducible remaining class: **specification incompleteness and oracle error**.

The design must not hide it. Claims without a mechanical oracle are returned as:

```json
{
  "status": "untested",
  "reason": "no_mechanical_oracle",
  "required_authority": "user_acceptance"
}
```

The user may accept them, request another design lane, or decline completion. They must never be presented as mechanically verified.

For research and architecture documents, “completed” means the requested artifact was produced and protocol requirements were met. It does not mean every proposition in the document is true. Evidence citations can be checked for existence and snapshot binding, but semantic adequacy remains an epistemic limitation.

---

## 5. Model tier

## The orchestrator itself: no model is required for correctness

A deterministic controller is the preferred orchestrator. Use a cheap model only to translate between natural language and the small protocol.

### Haiku-class

Sufficient for:

- recognizing explicit cancellation or status requests;
- extracting literal user constraints;
- choosing a conservative coarse route;
- rendering fixed-schema completion data;
- relaying a lane-authored artifact verbatim.

Expected failures:

- misclassifying ambiguous work;
- compressing away an important qualifier;
- inventing a friendly explanation beyond the envelope;
- treating a technical choice as clerical.

Mitigation is mechanical: preserve the verbatim request, validate outputs, route ambiguity to a framing lane, and prohibit free-form technical output. A Haiku mistake may add a framing round or cause a clarification; it cannot modify the repository or certify work.

Haiku-class is my recommendation.

### Sonnet-class

Sonnet would improve conversational parsing and reduce unnecessary clarification. It is useful if the user routinely sends long messages containing multiple intertwined requests and expects polished result rendering.

What still breaks:

- it can reason inline and invent conclusions;
- it cannot validate an internally consistent false-green;
- it can incorrectly summarize a lane artifact;
- it may smuggle an inferred diagnosis into a constraint.

Those are prevented by the same capability boundary, so Sonnet buys convenience rather than correctness. Use it only if measured routing error or rendering quality justifies the premium.

### Opus-class

Opus adds no architectural capability to this role. It may produce better prose and more plausible inferred plans, which is actively dangerous because the role is forbidden from making those judgments.

Opus still cannot catch a false-green by reading an internally consistent report. It also recreates the measured context-maintenance problem if kept long-lived. The recorded orchestrator cost was $444 per million output tokens versus $131 for lanes, with 93.2% of orchestrator spend going to context maintenance.

Opus should be used inside bounded architecture, framing, or adversarial-test lanes where its judgment is the product—not in the relay controller.

---

## 6. Cheap falsification experiments

These experiments should happen before implementing a new controller. They require wrappers, transcript replay, and temporary schemas—not production changes.

### Experiment 1: blind-router replay

**Method:** Take 100 historical user messages, remove all later orchestrator work, and give a Haiku-class adapter only the verbatim message and the proposed request schema. Have it select the first workflow route. Compare with a human-labelled conservative route.

**Prediction:** At least 95% will either match the safe route or choose a more exploratory route; fewer than 2% will route an ambiguous change directly to implementation.

**Measure:**

- unsafe-underroute rate;
- unnecessary-exploration rate;
- constraint omission rate;
- added dispatches per request.

**Kill result:** More than 2% unsafe under-routing, or more than 10% of explicit user constraints omitted after schema validation. If killed, remove model routing entirely and always start technical requests with a framing lane.

### Experiment 2: no-free-text relay test

**Method:** Replay 50 historical lane completions through the proposed envelope and renderer. Give evaluators the original user request, the original orchestrator answer, and the rendered answer, blinded.

**Prediction:** The schema relay will preserve all disposition-critical facts while being shorter and containing no unsupported orchestrator conclusions.

**Measure:**

- missing blocking fact;
- false statement introduced by relay;
- user-action ambiguity;
- token count.

**Kill result:** Any unsupported technical assertion introduced by rendering, or more than 5% of cases missing a fact required for the user’s next action. If killed, relay the lane’s user artifact verbatim and restrict generated text to fixed labels.

### Experiment 3: historical false-green challenge

**Method:** Take the seven known internally consistent false-greens. Reconstruct their claimed result revisions and run a prototype attestation wrapper in clean rooms. Do not give the wrapper the reports. Give it only claims, revisions, commands, and verifier policy.

**Prediction:** All cases whose defect is reproducible from the preserved revision will fail mechanically or be marked `invalid/untested`; none will receive a valid satisfied attestation.

**Measure:**

- false attestation count;
- invalid rather than broken count;
- setup time;
- compute and model cost.

**Kill result:** Any reproducible false-green obtains a valid satisfied attestation. That would show the attestation binds to an inadequate subject or accepts evidence without exercising the claim.

This experiment deliberately does not predict catching defects for which no adequate adversarial case was encoded. Those expose the oracle limitation, not runner integrity.

### Experiment 4: stale-subject injection

**Method:** Generate 30 synthetic result envelopes containing wrong commit hashes, tests run before the final edit, mismatched environment fingerprints, reused run IDs, missing exit codes, and producer/verifier identity collisions.

**Prediction:** The ingester rejects 30 of 30 without model involvement.

**Measure:** rejection by defect class and false acceptance count.

**Kill result:** Any false acceptance. The protocol is not ready if identity, freshness, and subject binding are not total.

### Experiment 5: malformed-lane recovery

**Method:** Ask cheap and mid-tier lanes to answer ten ordinary tasks using the schema, then inject ten malformed variants. Permit one automatic repair resume using only validator errors.

**Prediction:** At least 95% of genuine completions become valid within one repair; every injected semantic inconsistency remains rejected.

**Measure:**

- first-pass schema validity;
- repair success;
- false normalization;
- tokens and wall time of repair.

**Kill result:** More than 10% require a human to interpret the intended outcome, or the repair mechanism converts an inconsistent claim to `completed` without new evidence.

### Experiment 6: framing-contamination replay

**Method:** Select 30 historical tasks where the initial diagnosis was wrong or materially incomplete. Compare:

- charters written after an orchestrator had inspected the problem;
- framing manifests produced from the verbatim user request by a fresh investigation lane.

Blindly score whether each preserved the initial hypothesis as a guess and exposed falsifiers.

**Prediction:** Fresh framing lanes will prematurely commit to the historical wrong diagnosis less often and will produce a mechanically distinguishable observation/hypothesis split in at least 90% of cases.

**Measure:**

- wrong diagnosis encoded as fact;
- missing falsifier;
- implementation launched before premise test;
- extra lane cost.

**Kill result:** Fresh framing is no better than the historical charter on wrong-diagnosis-as-fact, or costs more than one median lane without reducing contamination. If killed, split observation collection from hypothesis formation into two machine stages, not two report readers: one collects cited observations; a separate lane proposes the hypothesis from the observation set.

### Experiment 7: interaction-shape audit

**Method:** Run 20 workflows through a mock gateway while injecting progress, retries, verifier failures, and lane protocol errors.

**Prediction:** The user-visible transcript contains exactly two assistant messages for successful work—acknowledgement and completion—and one additional message only when a user decision is required.

**Measure:** unsolicited intermediate message count.

**Kill result:** Any progress or intermediate finding leaks to the user. This is a gateway failure, not a prompting problem.

### Experiment 8: cost replay

**Method:** Use `scripts/lib/cost-model.mjs` and the corrected collection rules in `COST-METHOD.md`. Replay 50 historical tasks under:

- the original orchestrator path;
- cheap adapter + framing lane + existing work/verify lanes.

Include downstream context rereads, not just immediate output.

**Prediction:** Controller-side model spend falls by at least 80%; total spend falls despite the added framing lane because the persistent context disappears.

**Measure:**

- total corrected cost per completed user request;
- controller cost;
- lane count;
- completion latency;
- terminal-result correctness.

**Kill result:** Total corrected cost rises by more than 20% without a measurable reduction in unsupported relayed claims. If that occurs, the framing lane is too universal; introduce deterministic fast paths for exact, already-structured requests.

---

## 7. What I would deliberately not change

### Keep `scripts/dispatch.mjs` as the provider process boundary

It already provides:

- separate provider processes;
- read-only versus workspace-write modes;
- process-group timeout handling;
- a failure taxonomy;
- run/session IDs;
- `--meta-out`;
- stdin transport for large prompts;
- final-result-only stdout and progress-only stderr;
- transcript recording.

Those are useful foundations. Extend its machine contract alongside stdout; do not replace its provider runtimes.

### Keep fresh-process, clean-room verification

The measured cold start is about 11.8k tokens and $0.046, only one fifth of a large orchestrator tool call. Clean-room setup was a small fraction of verification cost. Reusing the producer’s context would save little and reintroduce contamination.

### Keep generation and verification in separate provider processes

The independent process boundary is sound. The change is that the verifier’s prose no longer carries the authoritative verdict; the execution service’s attestation does.

### Keep append-only ticket histories

Append-only events preserve auditability. Replace prose-derived state and manually maintained projections, not the historical record.

### Keep cross-provider routing for high-cost-of-mistake work

Cross-provider architecture and adversarial lanes remain valuable as work producers. They simply do not become readers that bless reports.

### Keep human decisions for genuinely normative choices

Architecture trade-offs, product meaning, acceptable visual quality, and intentional scope are not made mechanical by pretending they are tests. The controller should surface these as typed decisions.

### Do not build a universal proof system

The repository already has 98k lines of scripts against 54k lines of product, 183 verification scripts, and 90 ticket-specific verifiers. The attestation layer should standardize execution facts, identity, subject binding, and verdict records. It should not generate a custom proof framework for every ticket.

The design should delete opportunities for judgment at the relay boundary, not encode the entire product specification into orchestration machinery.

---

## Failure modes

1. **Wrong or incomplete acceptance claims.**  
   The runner faithfully proves the wrong thing. This is the principal unsolved risk. It must be labelled as an oracle limitation and escalated to user acceptance where no mechanical oracle exists.

2. **Bad framing lane.**  
   A lane may misunderstand the request. Preserving the verbatim request, separating observation from hypothesis, and requiring falsifiers make this visible but do not eliminate it.

3. **Compromised evidence runner or wrapper.**  
   The runner is in the trusted computing base. A bug in revision binding, environment construction, or evidence capture can issue false attestations. The stale-subject experiment and a deliberately small codebase are essential.

4. **Flaky or environment-dependent tests.**  
   A single clean-room result may not represent production. Attestations must declare the environment and permit policies such as repeated runs or target-environment execution. They must not generalize beyond what ran.

5. **Schema gaming.**  
   A lane can populate fields dishonestly. Fields backed by repository or runner facts must therefore be overwritten or checked by those authorities. Lane-authored fields remain claims, not facts.

6. **Excessive exploration.**  
   Conservative routing can add a framing lane to obvious work. That costs roughly a lane plus the measured ~$0.60 dispatch overhead. Deterministic fast paths should be added only after replay data identifies safe shapes.

7. **Protocol rigidity.**  
   Novel work may not fit the claim taxonomy. The correct outcome is `epistemic-only` or a versioned schema extension, not squeezing it into `verified`.

8. **Loss of helpful conversational synthesis.**  
   Verbatim relay may be less elegant than an Opus summary. That is intentional when summarization could change meaning. A cheap renderer can improve presentation only for fields whose semantics are fixed.

9. **Workflow-service outage.**  
   With no inline fallback, work stops. That is the desired failure mode: visible unavailability is safer than quietly violating the architecture.

10. **User asks for immediate conversation rather than repository work.**  
    Purely social or administrative exchanges need not create a technical workflow. The gateway must define this narrow class mechanically. Any request requiring facts, analysis, recommendations, or design goes to a lane—including this design task.

---

## Operating cost

The controller’s non-model cost is an event record, several small RPCs, and workflow storage. Its model cost should be limited to two short Haiku-class transformations per user request and can approach zero with fixed rendering.

The substantive cost moves to bounded lanes:

- one framing lane for requests that require investigation;
- one or more work lanes;
- one evidence run for each material executable change;
- approximately $0.60 of measured orchestrator-side dispatch overhead per dispatch under the current system;
- existing lane cost distributions: median lane about $2.45, with cold start about $0.046;
- verification historically around seven minutes and $4.09 median under superseded absolute arithmetic, so this number must be remeasured using the corrected collector.

A typical uncertain code change might therefore use a framing lane, an implementation lane, and a verification lane: roughly three dispatch overheads plus the three bounded lane costs. That can cost more immediately than one lucky lane. It should still cost far less than carrying a 400k–1M-token orchestrator context through hundreds of requests, and it buys enforceable role separation.

For already well-formed requests, the framing lane can be skipped by deterministic rule. For prose or architecture deliverables, evidence cost depends on what claims are mechanically checkable; the artifact itself is relayed without a false verification label.

---

## Final architectural definition

The orchestrator is not “the agent that understands everything and delegates most of it.”

It is:

> A capability-restricted, event-driven protocol endpoint that accepts a user request, starts a typed workflow, waits, and relays an authority-owned terminal envelope.

It owns:

- workflow identity;
- user-message provenance;
- waiting;
- decision routing;
- terminal delivery.

It does not own:

- repository facts;
- diagnosis;
- hypotheses;
- technical charters;
- implementation;
- verification;
- verdicts;
- ticket state;
- summaries of technical prose.

Those belong respectively to investigation lanes, work lanes, the evidence runner, and deterministic record services.

If this boundary is implemented in a separate binary, separate credential, separate sandbox, and constrained conversation gateway, the orchestrator cannot work inline even when the model tries. More importantly, there is no longer any reason to pay an Opus-tier model to perform the role.

---

## Part 3 — My disagreements (mine, not the other provider's)

*Separated deliberately. Nothing above was altered to accommodate anything below. A
reviewer attacking design B should attack Part 2; this part is one reader's reaction to
it and carries no more authority than that.*

**1. Where I think it is right, and it is the load-bearing part.** Replacing the
sceptical read with an attestation issued by the process supervisor — not copied from
the model's prose — is the correct answer to the 0-of-7 result, and it answers the
user's correction rather than dodging it. The specific properties it demands (binding to
the exact result revision, verifier run id ≠ producer run id, freshness, recorded actual
execution, non-vacuity against a known-bad subject) are each mechanically checkable, and
each corresponds to a real failure this board has recorded. Its distinction between
*runner integrity* (checkable) and *oracle error* (irreducible) is honest and I would
not weaken it. The tier answer — Haiku-class, and no model at all required for
correctness — follows from the tool surface rather than being asserted, which is why it
convinces.

**2. The proposal has no v0, and the project it lands in cannot afford a v1.** The
design specifies a workflow service, a capability gateway, a separate orchestrator
binary with its own credential and sandbox, a signed/MAC'd attestation format with
environment fingerprints, a schema-validating ingester with automatic protocol repair,
and `INDEX.md` regenerated as a projection over typed events. That is a substantial new
subsystem in a repository whose *measured* condition is that its instrumentation has
outgrown the product it instruments — 98k lines of `scripts/` against 54k of product,
183 verification scripts, 90 of them named after a single ticket, and 407 of 447 lanes
in one window spent on the record system rather than on product defects. Its own §7 says
"do not build a universal proof system"; §4 then specifies a trusted execution service
with signing. I do not think that tension is resolved, and its failure mode 3 concedes
the runner joins the trusted computing base. The design would be far stronger with an
explicit smallest-thing-that-enforces-the-boundary: an orchestrator process launched
with an allow-list of exactly one tool — the dispatch RPC — and no Read, Bash, Grep,
Edit or Write, which is enforceable **today** with existing permission machinery and
would test the entire hypothesis in an afternoon. Everything else in the design is an
improvement on top of that, not a prerequisite for it.

**3. The false-green moves from prose into an enum; it does not disappear.**
`open_items[].blocks_completion`, `claims[].status: "inapplicable"`, and
`"untested" / reason: "no_mechanical_oracle"` are all **lane-declared** fields that no
lower authority can measure. A lane that under-declares an open item, or marks the
awkward claim inapplicable, completes cleanly with a fully valid envelope and a genuine
attestation on the claims it did declare. The design names this as failure mode 5
("schema gaming") and prescribes that "fields backed by repository or runner facts must
be overwritten by those authorities" — but that remedy by construction does not reach
the fields where the risk actually lives, because those are exactly the fields no
authority can measure. The attestation makes *claim status* unforgeable while leaving
*claim coverage* forgeable. I think that is a real hole, and it is the same defect class
the whole design is built to close, relocated one level up: the completeness of the
claim set is a fact declared by the party with an interest in it. Experiment 3 cannot
find this, because it only asks whether reproducible false-greens obtain valid
attestations.

**4. It predicts a cost reduction its own structure argues against.** Experiment 8
predicts controller spend down ≥80% (very likely true) and total spend down. But the
design routes most requests through a framing lane, then a work lane, then an evidence
run — three dispatch overheads and three lane costs where the current system frequently
pays one. The crossover measurement supports *dispatch being cheaper than inline*; it
says nothing about three dispatches beating one. The saving has to come entirely from
the disappearance of the 400k-token persistent context, which is plausible but is the
whole bet. To its credit, experiment 8 is stated so that it can come out against the
design, and its kill condition is specific.

**5. The gateway is the best mechanism in the document and is priced at zero.**
Refusing the model any free-form user-facing channel during an active workflow is the
one thing an instruction genuinely cannot substitute for, and I would adopt it before
anything else. But its cost is not stated: a user who asks "why is this taking so long"
or "wait, did you consider X" mid-flight gets a schema-derived status line or nothing.
Failure mode 10 defers this to "a narrow class the gateway defines mechanically" and
never defines it. Given the stated requirement — the next message is the completed work
— this is arguably correct behaviour rather than a defect, but a design that removes a
conversational affordance should say what it costs rather than leave it as an
undefined class.

**6. One thing I would keep that it discards without comment.** It removes `INDEX.md`
from the orchestrator entirely, which is right, but it does not address what happens to
the orchestrator's *memory across workflows* — which lane was told what, which decision
was already made, what the user asked for last week. In this design the controller holds
workflow identity and nothing else, and the durable record is the ticket board it can no
longer read. Something has to answer "have we already tried this", and the design does
not say who.

---

## Cost of this lane

One dispatch to the other provider, plus this document. No sub-agents, no code changed,
no verification suites run.

- **The dispatch (`gpt-5.6-sol`, run `01a01e74-6b8d-7bd2-87fc-e10db45804a8`):** 54,017
  tokens — 46,633 input (37,632 of them cached), 7,384 output. One turn, ~2 minutes.
- **This lane's own context:** 12 tool calls — 5 document reads (the crossover analysis,
  the defect-origin classification, the cost method, WA §I, plus outlines of the two long
  analyses), 2 shell reads of `scripts/dispatch.mjs` and the outline greps, 3 scratch
  writes (brief, header, footer), the dispatch itself, and the assembly. The largest
  single input was reading the context docs in order to brief the other provider, which
  is the irreducible cost of being the harness for a cross-provider question.

The design in Part 2 cost approximately one median lane's worth of tokens to obtain, and
was produced by a provider that had never seen this project's history.
