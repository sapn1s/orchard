# Ticket board redesign — design and migration plan

**Status:** design only. Nothing here has been built. No product code was changed producing it.
**Date:** 2026-08-19
**Supersedes:** ARCH-004 (see §4). Folds in FEAT-082's open decision (see §4).

---

## 1. The argument

### 1.1 What a human gets today, measured

The prototype's `t1.txt`–`t4.txt` are verbatim pastes of our *current* ticket view for FEAT-082,
ARCH-005, BUG-104 and FEAT-092. So the "before" is not a strawman — it is our real rendered surface,
captured by the person who built the prototype.

What the current view puts on screen first, in order, for FEAT-082:

1. A title that is an argument, not a symptom:
   `board/ticket-dashboard redesign: type facets + "Solved?" proof card + summary strip (not lanes)`.
2. A metadata dump of eight labelled cells (`state / status / owner / sev / area / reported /
   activity / file`) — where `status` is *itself a sentence* ("OPEN — recommend facets + a proof
   card (not Kanban); open question: how to capture the proof."), `sev` is `—`, and `area` is a
   four-path concatenation.
3. Then the **same three fields again** (`Status:`, `Area:`, `Reported:`), because the header
   renders them and the markdown body repeats them.
4. Only then, prose.

Then the reader walks. Measured, over the four real ticket files in `docs/bugs/`:

| Ticket | Original words | Words before the decision question | Redesigned words | Words before the decision |
|---|---|---|---|---|
| FEAT-082 | 3,345 | 507 | 255 | 70 |
| ARCH-005 | 2,825 | **1,039** | 304 | 85 |
| BUG-104  | 2,030 | 772 | 291 | 87 |
| FEAT-092 | 1,897 | 348 | 207 | 76 |

The compression of the human layer is 7×–13×. The number that matters more is the second column
against the fourth: **on ARCH-005 a person currently reads 1,039 words of invariant statement,
design archaeology and failed-patch history before they are told what they are being asked.** In the
redesign it is 85 words, and the 1,039 are still there — one expander down, and unchanged in the
data an agent receives.

This is worth being precise about, because it changes what the schema must encode. The current
tickets are not badly written. FEAT-082 and FEAT-092 both open with an `## In plain terms` section
that is genuinely plain. The defects are structural, and there are exactly four:

- **The human layer is optional and unnamed.** `## In plain terms` exists on FEAT-082 and FEAT-092
  and does not exist on ARCH-005 or BUG-104, which open with `## Violated invariant` and `## What the
  clean room promises vs. what it delivers`. Nothing enforces it, so nothing can render it.
- **The human layer is one prose blob.** Even where it exists, summary / impact / need / question are
  a run of paragraphs. A renderer cannot put "impact if we wait" in a side card because it cannot
  find it.
- **State is prose.** `- **Status:** OPEN — recommend facets + a proof card (not Kanban); open
  question: how to capture the proof.` is simultaneously the machine state, the recommendation, and
  a mood. This is ARCH-004's complaint exactly, and the corpus proves it: 17 distinct status strings
  across 182 tickets, including `VERIFIED2026-08-13`, `SYNTHESISDONE`, `INVERIFICATION`, `VERIFIED/DONE`.
  The in-file headers and the INDEX disagree on 3 tickets right now.
- **Everything is at one visual level.** Decision, evidence, migration path, proof bar and a
  50-entry activity log are all `##`. The log can contradict the header (FEAT-082 records substantial
  implementation while its header still says the design is unchosen) and nothing surfaces the conflict.

### 1.2 What the prototype does about it, seen rendered

I served the prototype on a scratch port and drove it in headless Brave over CDP at 1440×1600,
capturing six frames (home and detail, light and dark) and grading each with
`scripts/lib/shot-luma.mjs`. Captures are distinct by md5; light frames grade luma 243–245, dark
frames 30–34. So the dark mode the user asked for is real, not a class that never applied.

What the pixels show:

- **A whole ticket fits one screen.** FEAT-082's detail page has `scrollHeight === 1600` at a 1600px
  viewport, and above 900px sit: type + id, title, three state pills, "What's happening", "What this
  ticket needs", "Impact if we wait", the fact card, the decision question, and two of four options.
  The remaining two options and the collapsed deep layer land by 1250px. The claim "comprehension and
  decision fit the first screen" is true in pixels, at four tickets.
- **The layout is three bands**: a two-column human grid (narrative card + impact/facts sidebar), a
  full-width decision card with a 2×2 option grid, and a collapsed deep band.
- **The option card is the real invention.** Each option is `key · label · what changes · why this
  isn't obviously best`. That last line is what makes four options comparable at a glance instead of
  four paragraphs to be held in the head simultaneously.

Two defects I found in the prototype's dark mode, which the build must fix rather than port:

- The **"Impact if we wait" card body text is near-invisible in dark** — dark green on dark green;
  the light-mode token is not overridden. Visible in the capture. This project already has BUG-101
  (muted text tokens below WCAG AA app-wide); do not import a fresh instance of it.
- The **"Record decision" button** is a low-contrast grey in dark mode.

Everything else transfers.

### 1.3 The one-line conclusion

The difference is not writing quality and it is not the visual theme. It is that the redesign
**names the human layer's fields and makes them mandatory**, so a renderer can put each one where it
belongs and a person can stop at the first band. That is the entire deliverable of §2.

---

## 2. The schema

**Adopted from the prototype as-is.** Field names, the human/deep split, and the decision model are
the prototype's. The additions in §2.6 exist only because our corpus carries things the prototype's
four examples had no occasion to include.

### 2.1 Storage decision (decided, not offered)

**Each ticket stays one markdown file at its current path. It gains a leading fenced
`orchard-ticket` JSON block that carries the entire human layer and all machine state. The markdown
body below it carries the deep-layer prose slots and the append-only activity log, unchanged in
kind.**

Rationale, in the order that decided it:

- **JSON, not YAML front matter, because of portability.** `scripts/board.mjs` is copied verbatim
  into onboarded repos (`COPIED_TOOLS`), must stay single-file and node-builtins-only, and there is
  no YAML parser in builtins. `JSON.parse` is. Choosing YAML means either a new dependency in every
  onboarded repo or a hand-rolled YAML parser, which is a worse version of the prose-parsing problem
  we are leaving.
- **A fenced block, not a `.json` sidecar, because agents read one file.** The board's whole method
  is that a ticket is the issue's durable memory and every worker reads it whole. Two files means
  two reads, two write paths, and a new class of drift between them — which is the defect we are
  fixing, relocated.
- **The activity log stays markdown, because it is appended to by hand and by agents.** Append-only
  is enforced socially and by review; a JSON array is hostile to that, and a merge conflict inside a
  JSON array is unrecoverable in a way that a conflict between two `###` entries is not.
- **The file stays at its current path** so every `docs/bugs/<ID>-<slug>.md` reference in prompts,
  tickets, commits and the archive keeps resolving.

Cost of this choice, stated honestly: the top of a ticket file becomes JSON, which is uglier to read
raw than a prose header. That cost is paid by whoever opens the file in an editor; the humans this
project cares about read the rendered board, and agents read JSON at least as well as prose. A
`board:fmt` canonicaliser (stable key order, 2-space indent) keeps diffs readable.

### 2.2 The anti-prose enforcement, which is the point

Four rules, all machine-checked by one validator. Together they leave a model no room to substitute
prose for structure:

1. **The key set is closed.** Every key below is required and present in every ticket. Unknown keys
   are **rejected, not dropped** — the dialect of `src/server/validate.ts`, chosen so the UI and the
   author hear about a stray key instead of losing it silently.
2. **Absence is explicit.** An optional field is `null`. Never omitted, never `""`, never "N/A".
   The renderer prints **"Not recorded"** for `null`. A model cannot make a field disappear; it can
   only assert absence, which is a checkable claim.
3. **Enums are fixed sets.** Every state field draws from a literal list. Anything else fails
   validation. This is ARCH-004's option B, implemented.
4. **Prose fields are capped.** Each free-text field has a hard word budget, enforced by the
   validator. `summary` is ≤ 60 words. An option's `why_not_obvious` is ≤ 30. A model that wants to
   write an essay has nowhere to put it except the deep-layer body, which is where essays belong.

### 2.3 Human layer — the default-visible block

All of these live in the JSON block. Types: `S` = string, `S?` = string-or-null, `E` = enum,
`N` = integer, `[]` = array.

| Field | Type | Req | Rule |
|---|---|---|---|
| `id` | S | yes | `^(BUG\|FEAT\|ARCH\|DEPLOY)-\d{3}$`, must equal the filename prefix |
| `type` | E | yes | `bug` \| `feature` \| `architecture` \| `deploy` — derived from `id`, stored anyway so a renderer never re-derives |
| `title` | S | yes | ≤ 12 words. A **symptom or outcome**, never a proposal. `board:check` rejects a title containing `(not `, `+`, or `→` — the shapes our current argument-titles take |
| `summary` | S | yes | ≤ 60 words. What is happening, in project-general language, assuming no subsystem knowledge |
| `impact_if_we_wait` | S | yes | ≤ 50 words. Must state the *bound* as well as the harm — the prototype's examples all do ("display-correctness, not data loss"; "the exposure is passive") and that bounding is what stops every ticket reading as an emergency |
| `current_need` | S | yes | ≤ 40 words. What the ticket needs *now*, in one sentence |
| `severity` | E | yes | `low` \| `medium` \| `high` \| `not_recorded` |
| `area` | S | yes | ≤ 6 words, human-readable ("Ticket board", "Client view model"). Not a path list — paths go to `code_refs` |
| `reported` | S | yes | ISO date |
| `reported_by` | S | yes | `user` \| `agent` \| free ≤ 4 words |
| `owner` | E | yes | `you` \| `agent` \| `unassigned` |
| `work_state` | E | yes | `open` \| `in_progress` \| `in_verification` \| `verified` \| `done` \| `blocked` \| `not_a_bug` |
| `human_action` | E | yes | `none` \| `decide` \| `answer_question` \| `review` \| `staged_decision` \| `multi_select_decision` |
| `verification_state` | E | yes | `not_required` \| `not_recorded` \| `pending` \| `holds` \| `broken` |
| `updated` | S | yes | ISO date, derived from the newest activity entry |

These four orthogonal state fields (`type`, `work_state`, `human_action`, `verification_state`)
replace the current single prose `Status:` line and the hand-curated INDEX owner glyph. Placement in
Open/Done, the needs-you rail, and the proof badge are all *derived* from them, never re-parsed.
This is precisely what ARCH-004 asks for and what the user already answered.

### 2.4 Decision model

`decision` is `null` (no decision outstanding) or an object:

| Field | Type | Req | Rule |
|---|---|---|---|
| `mode` | E | yes | `single` \| `multi` \| `staged` |
| `question` | S | yes | ≤ 25 words, ends in `?`, answerable without reading the deep layer |
| `options` | [] | yes | ≥ 2 entries |
| `options[].key` | S | yes | ≤ 6 chars, unique within the ticket |
| `options[].label` | S | yes | ≤ 8 words, a noun phrase ("Encapsulate raw session fields") |
| `options[].what_changes` | S | yes | ≤ 30 words |
| `options[].benefit` | S | yes | ≤ 25 words |
| `options[].cost` | S | yes | ≤ 25 words |
| `options[].why_not_obvious` | S | yes | ≤ 30 words. **The field that makes options comparable.** Never "n/a" — if an option has no downside it is not an option, it is the answer |
| `recommendation` | S? | yes | `null` when no recommendation is honest. `null` is not a failure; FEAT-092 is `null` because a prerequisite is unproven, and that is the correct record |
| `recommendation_reason` | S? | yes | ≤ 40 words. Non-null exactly when `recommendation` is non-null |
| `prerequisite` | S? | yes | ≤ 40 words. What must be established before this decision is safe. FEAT-092's "directly verify that reconstruction reapplies fresh instructions" is this field |

**Mode semantics — all three must be expressible, and the UI must not flatten them:**

- `single` — `recommendation` is one key. Radio group. (FEAT-082 → `"C"`.)
- `multi` — `recommendation` is a `+`-joined key list; `options[].combines_with` (array of keys,
  required in this mode) states which options compose. Checkbox group. (BUG-104 → `"1 + 2 + 4"`,
  with option 4 declaring `combines_with: ["1","2","3"]`.)
- `staged` — each option carries `stage` (integer ≥ 1, required in this mode) and the decision
  carries `stages[]`: `{ stage, question, unlocked_by }`. Only stage 1 is answerable; later stages
  render as "then" and are not clickable. (ARCH-005 → option 3 is stage 1 and supplies the inventory
  that makes the stage-2 choice between 1 and 2 safe.)

A mode's required fields are conditionally required — the validator checks `combines_with` only in
`multi`, `stage`/`stages` only in `staged`. Present-but-irrelevant fields are rejected, so a model
cannot hedge by filling in all three shapes.

`decision_history` is an array (possibly empty, never absent) of past decisions:
`{ asked_on, question, mode, options_keys[], chosen, chosen_on, chosen_by, note }`. Rendered
collapsed and visibly inactive. **A ticket has at most one live `decision`;** everything else is
history. This is the direct fix for FEAT-082's failure mode, where an answered older design question
still reads as open next to a log full of implementation.

### 2.5 Deep layer

Structured deep fields live in the JSON block (agents get them from the API even when a human has
them collapsed). Long-form deep prose lives in the markdown body under a **closed, ordered set of H2
slots**: `## Diagnosis`, `## Evidence`, `## Implementation notes`, `## Verification plan`,
`## Migration and rollback`, `## Risks`, `## Activity log`. Missing slots are omitted from the body
and the corresponding `body_slots` key records their absence, so "no evidence section" is a fact the
renderer can state rather than a gap it silently paints over.

| Field | Type | Req | Rule |
|---|---|---|---|
| `success_criteria` | [] of S | yes | ≥ 1 entry, each ≤ 25 words. Empty array is invalid; if genuinely unknown, one entry `"Not recorded"` — an explicit, greppable claim |
| `code_refs` | [] | yes | `{ path, symbol?, note? }`. May be empty |
| `related` | [] | yes | `{ id, relation }` where relation ∈ `supersedes` \| `superseded_by` \| `depends_on` \| `blocks` \| `duplicate_of` \| `recurrence_of` \| `see_also`. **Both directions are written**; `board:check` fails on a one-sided edge |
| `recurrence_evidence` | [] of S | yes | ticket ids. Required non-empty for `type: architecture` (the ARCH template's existing field) |
| `verification` | [] | yes | see below. May be empty; `verification_state` must then be `not_recorded` or `not_required` |
| `verification_class` | E | yes | `fix` \| `plan+review` \| `arch` \| `trivial` \| `docs-only` \| `exempt` |
| `body_slots` | object | yes | one boolean per slot name above; true iff that H2 exists in the body |
| `source` | object | yes | `{ archived_path, sha256, bytes, original_title, migrated_on, migrated_by, confirmation, dropped }` — provenance of the pre-migration original, plus the model's own preservation statement (§6.2) |

`verification[]` entry: `{ provider, model?, run_id, verdict, verdict_on, harness, counts?, commit? }`
where `verdict` ∈ `holds` \| `broken` \| `invalid`. This is the parsed form of today's
`- **Verified-by:** dispatch openai run <uuid> (clean-room, …) — VERDICT: HOLDS` line, and it must
round-trip: `formatVerifiedBy()` in `scripts/lib/verdict-contract.mjs` stays the single formatter, and
the migration's extractor is its inverse.

### 2.6 The additions to the prototype, each justified

Six, no more. Each exists because our corpus carries something the prototype's four samples did not.

1. **`work_state` / `human_action` / `verification_state` as fixed enums** — the prototype implies
   these as display strings; ARCH-004 requires them as machine values, and the user has already
   answered that ticket ("obviously it must be fixed set choices").
2. **`verification[]`** — our proof discipline is dispatch run ids with HOLDS/BROKEN verdicts; the
   prototype had no field for a verdict because none of its four tickets had been verified.
3. **The `## Activity log` body slot, kept append-only markdown** — the accumulating-context
   mechanism this whole board exists for; it cannot become a JSON array without losing hand-append.
4. **`related[]` with a typed, bidirectional relation** — our tickets cross-reference constantly in
   prose ("supersedes ARCH-004", "recurrence of BUG-0xx") and nothing checks the back-edge.
5. **`decision_history[]`** — required by the handoff's rule that historical decisions must not read
   as active; our tickets accumulate several decisions over their life, the prototype's did not.
6. **`source{}`** — migration provenance: which bytes this ticket derived from, where they were
   archived, and the migrating model's own statement of what it preserved and what it deliberately
   left behind (§6). Without it there is no anchor back to the original at all.

`prerequisite`, `combines_with`, `stage`/`stages`, and `body_slots` are not additions in the same
sense: they are the explicit encodings of behaviour the prototype already demonstrated (FEAT-092's
unproven precondition, BUG-104's composing option, ARCH-005's staging) and the handoff already
named.

### 2.7 Rendering contract

- Human layer renders always. Deep layer renders as independent expanders — **not one collapsed
  markdown blob**, which the handoff explicitly rejects and which is what our current view does.
- `null` renders as the literal words **"Not recorded"**, in a muted-but-AA-contrast token.
- The API returns the *whole* record — human and deep — regardless of what a human has collapsed.
  Progressive disclosure is a rendering decision, never a data decision. This is what keeps agents
  whole while humans get a first screen.
- Theme: adopt the prototype's information hierarchy and card structure; use Orchard's existing dark
  tokens rather than the prototype's, and fix the two dark-mode contrast defects named in §1.2
  instead of porting them.

---

## 3. One parser, and what it replaces

The survey found the format is parsed **five times** with three different definitions of "done":
`board.mjs` treats `VERIFIED|FIXED|RE-FIXED|RESOLVED|DONE` as done; `src/server/tickets.ts` treats
only `VERIFIED|DONE`; `arch-watch.mjs` the same as tickets.ts. **A `FIXED` ticket is therefore Done to
the board tool and Open to the ticket API today.** There are likewise three INDEX row parsers, four
H1 parsers, and four readers of `- **Field:**`.

The redesign's non-negotiable structural rule: **one module, `scripts/lib/ticket-schema.mjs`,
node-builtins-only, exporting `parseTicket`, `validateTicket`, `formatTicket`, and the enum
constants.** Every consumer imports it. It joins `COPIED_TOOLS` so onboarded repos get it, and
`SYNCED_TOOLS` so fleet-sync keeps it current (note: `lib/verdict-contract.mjs` is copied by onboard
but *not* synced by fleet-sync — fix that in the same pass or the copies diverge).

`INDEX.md` becomes **derived output only**: `board:gen` writes it from the ticket JSON blocks, with
no hand-curated cells left. The Owner glyph and the Commit cell are the last two hand-curated values
today; they move into `owner` and into the `verification[].commit` / a `commit` field respectively.
The "orchestrator owns INDEX" rule then stops being a coordination burden and becomes a fact about
generated files.

---

## 4. ARCH-004 and FEAT-082 are folded in, not left alongside

**ARCH-004** asks: keep sharpening prose patterns (A), one canonical machine state plus a
reachability check (B), or reachability check only (C). The user answered it in the ticket's own log
("obviously it must be fixed set choices"), and C's reachability check is already built and passing
against the real board. §2.3's four enum state fields **are** option B. This plan therefore
supersedes ARCH-004: ARCH-004 closes as `superseded_by: <this work>` with the answer recorded, and
its reachability check is retained unchanged — it keeps working, and it gets *stronger*, because its
one recorded blind spot (a ticket mis-classified as done by an incidental word, instance #2's
mechanism) cannot occur once `work_state` is an enum.

**FEAT-082** asks how the proof card captures verification evidence: infer from prose (A),
structured fields (B), both (C), or rework the design first (D). §2.5's `verification[]` is B, and
the migration in §5 is what makes B viable where it previously was not — the objection to B was
"old tickets stay blank", and the migration fills them. FEAT-082 closes as answered-by-migration
with `decision_history` recording B-via-migration and the reason.

Two overlapping plans become one. No third plan is created.

---

## 5. Migration

### 5.1 Shape

Copy, never edit. The originals are not touched at any point.

```
docs/bugs/<ID>-<slug>.md          ← NEW structured ticket, written by the pipeline
docs/bugs/archive/<ID>-<slug>.md  ← the original, moved verbatim at cutover
docs/bugs/archive/INDEX.md        ← generated: id, title, bytes, sha256, migrated-on
```

During the run the new copies are written to `docs/bugs/.migrated/` and nothing reads them. The
archive stays git-tracked and greppable, so "what did the original say" is always one `git show` or
one `rg` away — and `source.sha256` in each new ticket pins exactly which bytes it derived from.

### 5.2 What the model is *not* allowed to author

**The activity log and every provenance value are extracted deterministically and copied verbatim.
The model never sees the log and never writes a run id.**

This is primarily a *cost* decision — the log is 71% of the corpus by bytes and the model has no
reason to read it — and it has the useful side effect that the one class of value a future reader
cannot re-derive (§6.1) is never at risk in the first place.

Extracted by regex, by the pipeline, before the model is invoked:

- the entire `## Activity log` section — **copied byte-for-byte** into the new file's body;
- every `Verified-by:` line → `verification[]`, via the inverse of `formatVerifiedBy()`;
- every dispatch run id (UUID), commit sha, and pass-count;
- every cross-referenced ticket id → `related[]` candidates;
- every file path and backticked symbol → `code_refs[]` candidates;
- `id`, `reported`, `reported_by`, `updated` (newest `###` date), `verification_class`.

The model receives **only the pre-activity-log head**, and produces **only** the human-layer prose
fields, the option prose, the enum classifications, and the deep-slot boundaries. Measured: the head
sections are **29.1% of the corpus — 718 KB, ~180 K tokens across 182 tickets**, mean 3.9 KB each,
and exactly one ticket (ARCH-003) has a head over 20 KB (33.6 KB ≈ 8.4 K tokens). No chunking is
needed anywhere. The 176 KB and 155 KB monsters shrink to a single ordinary prompt because their
bulk is activity log, which the model never reads.

### 5.3 The pipeline

Per ticket, one **single-turn, no-tools** dispatch — deliberately *not* an agent lane:

```
npm run dispatch -- --provider openai --model gpt-5.6-sol \
  --sandbox read-only --timeout-min 5 --prompt-stdin \
  --meta-out .migrated/<ID>.meta.json
```

`--prompt-stdin` unconditionally (20 tickets exceed the 131,072-byte argv cap, and
`independent-verify.mjs` already switches at 100,000 bytes). NUL bytes replaced with `␀` per the
existing `argvSafePrompt` pattern. Parallelism does not exist in `dispatch.mjs` and must be built as
a semaphore over `spawn(process.execPath, ['scripts/dispatch.mjs', …])`; each child has its own
`--meta-out`, so it is safe. Retry/backoff keys off `failureKind` in the meta file
(`quota-window`, `rate-limited` are already distinct kinds).

**Prompt contains:** the schema (enums, field list, word caps) as a literal contract; the ticket
head; the deterministically-extracted facts as *given* values it must not contradict; and three
worked examples — the prototype's own `redesigned/*.md` content, which is the calibration set.

**Must return:** one JSON object, no prose. Extraction follows the repo's existing precedent
(`scripts/experiments/haiku-check.mjs`): lenient `/\{[\s\S]*?\}/` match, `JSON.parse`, `parseOk` flag.
Two of the returned fields are the model's own account of the transformation:
`source.confirmation` (≤ 40 words — that the substance of the original survives in the new fields)
and `source.dropped` (an array of short strings naming anything it judged non-essential and left
behind, empty array if none).

**Validation, before acceptance** — hand-rolled in the `src/server/validate.ts` dialect (the repo has
no ajv/zod in `package.json`; they are transitive-only):

1. schema validation — closed key set, enums, word caps, conditional mode fields;
2. the **provenance check** of §6.1 — a presence-and-equality assertion on ids, refs, dates, option
   keys and verification records. Cheap, narrow, and not a content comparison;
3. cross-field consistency — `recommendation` is a real option key; `recommendation_reason`
   non-null iff `recommendation` non-null; `verification_state` agrees with `verification[]`;
   `work_state: done` forbids a live `decision`.

**On failure:** the violations list is fed back as a single corrective re-prompt on the same session
(the pattern `independent-verify.mjs` already uses). Second failure → the ticket is quarantined to
`.migrated/failed/` with its violations, and is **not** migrated. Quarantine is a normal outcome, not
an error: those tickets stay on the old renderer until a human resolves them.

### 5.4 Cost and wall-clock

Priced off ROUTING.md's ladder (GPT-5.6 Sol, $5/$30 per MTok):

| | Tokens | Cost |
|---|---|---|
| Input: ticket heads | 180 K | $0.90 |
| Input: schema contract + examples, ~1.5 K × 182 | 273 K | $1.37 |
| Output: JSON + reasoning, ~3 K × 182 | 546 K | $16.38 |
| **Subtotal** | ~1.0 M | **$18.65** |
| + 20% retry/re-prompt allowance | | **≈ $22** |

> **The two borrowed comparison figures below are superseded** — see
> `docs/analysis/COST-METHOD.md`. `$8.70 per lane` and `$1,234.85 for a day` come
> from `pipeline-cost-2026-08-19.md`, computed before it was known that the CLI
> repeats `usage` once per content block (over-reporting cache-read by up to
> 2.22×). Both are most likely over-stated, which if anything *strengthens* the
> contrast this paragraph draws. The estimate for this proposal — priced from a
> token count, not from transcripts — is unaffected.

**Around $22, and under $30 in any case, for the whole corpus.** For contrast: the recent window measured **$8.70 per dispatched
agent lane** and $1,234.85 for a day. Running this as 182 agent lanes would cost **~$1,600**. The
entire cost argument is *single completion, not agent lane* — no tools, no repo access, no
verification round trip. If the build drifts toward "give the agent the repo and let it figure the
ticket out", the bill moves by two orders of magnitude.

Note also that `--provider openai` here runs on subscription OAuth against rolling 5-hour windows,
not metered API billing — so the real constraint is **quota, not dollars**, and ROUTING.md names this
provider as the scarce side explicitly not intended for bulk parallel volume.

**Wall-clock:** a single-turn extraction is ~45–90 s, not the 7-minute median of a verification lane.
Sequential: ~3.5 h. At a semaphore of 4: **~60–75 min of compute**, realistically **3–4 h elapsed**
spread across 2–3 quota windows with backoff. Plus human spot-check time (§6.2), ~2 h.

### 5.5 All 182, not just the open ones

**Migrate all of them.** Three reasons:

- At ~$25 the cost argument for a partial migration does not exist.
- A half-migrated board means two renderers and two parsers **forever** — the exact duplication this
  plan is removing.
- The 157 done tickets *are* the accumulating-context corpus. Their value is that a future agent
  reads BUG-0xx and does not repeat its failed approach. Leaving them unstructured means the search,
  the type facets and the proof card work on 24 tickets and lie about 157.

Effort is tiered, not coverage:

- **24 open tickets** — full human-layer authoring, live `decision` where one exists, **100% human
  spot-check**.
- **157 done tickets** — same schema; `decision` is `null`, past decisions land in
  `decision_history` as inactive, `human_action: none`. **15% random spot-check (24 tickets)** plus
  the 100% provenance check.

### 5.6 Cutover, so the board never reads a half-migrated set

The board's read path is switched by a single flag, once, atomically:

1. Pipeline writes every new ticket to `docs/bugs/.migrated/`. Nothing reads it. The live board is
   untouched and fully functional throughout.
2. Schema validation and the provenance check (§6.1) run over the whole set. **The gate is
   all-or-nothing**: if any ticket
   is quarantined, the set is not promoted — the quarantined ones are fixed or explicitly excluded
   by a human first, and excluded tickets keep their old file.
3. Promotion is one commit: originals `git mv` to `docs/bugs/archive/`, new files moved into
   `docs/bugs/`, `archive/INDEX.md` generated, `board:gen` run. Because it is one commit, `git
   revert` is a complete rollback.
4. `parseTicket` refuses a file with no `orchard-ticket` block and names it. So a half-migrated set
   cannot render half-silently — it fails loudly at boot, which is the only acceptable behaviour for
   a format cutover.

---

## 6. What must not be lost

The line this draws is **provenance versus content**, and it is drawn deliberately narrow.

Content — summaries, impact, option prose, diagnosis, evidence narrative — is a transformation
where loss is visible to the next reader, and any reader acting on a ticket re-verifies against the
code anyway. A strong model restructuring prose into fixed fields is reliable at that, and an
elaborate comparison harness would cost more to build and maintain than the failure it prevents.
**Content preservation rides on the model's own confirmation** (`source.confirmation` and
`source.dropped`, §5.3), which is a readable, greppable, per-ticket record rather than a silent
assumption.

Provenance is different, and only because of one property: **if a dispatch run id is dropped or
altered, no future reader can notice.** The original will be archived and nobody re-reads it, the
run id is not re-derivable from anything, and the verdict it anchors is what this project's method
rests on. That is worth a check. Nothing else on the ticket has that property.

### 6.1 The provenance check

One small function, run over each migrated ticket against its original. Presence and equality only —
no diffing of prose, no thresholds, no scoring:

| Class | Assertion |
|---|---|
| Verification records | every `Verified-by:` line in the original appears as a `verification[]` entry with identical `provider`, `run_id` and `verdict` |
| Run ids | every UUID in the original appears somewhere in the migrated file |
| Commit shas | every 7–40 hex sha in the original appears in the migrated file |
| Ticket cross-references | every `(BUG\|FEAT\|ARCH\|DEPLOY)-\d+` in the original appears in the migrated file |
| Activity entries | the count of `^### <date> —` headings is equal (the log is copied verbatim, so this is a copy-path assertion) |
| Dates | every ISO date in the original appears in the migrated file |
| Decision option keys | the live decision's option count and keys match those parsed from the original's decision section |

Any failure → reject and requeue; second failure → quarantine. That is the whole check. It is a
few dozen lines and it tests the pipeline's copy paths, not the model's judgement.

Two must-FAIL cases before it is trusted, because a check that passes on empty input is worse than
none: **(A)** mangle one character of one run id and confirm rejection; **(B)** hand it an empty
migrated file and confirm it FAILs rather than passing vacuously.

### 6.2 Human spot-check

A `--review` mode renders original and migrated side by side, with `source.dropped` shown inline.
24 open tickets at 100%, a 15% sample (24) of the done tickets. Reviewer answers one question per
ticket: *could you make this ticket's decision, or understand what it was, from the right column
alone?* A "no" sends the ticket back with the reason appended to the prompt.

This is where content is graded — by a person, on a sample, which is proportionate to the stakes.

### 6.3 Anti-regression the migration must run

`board:check` in full (drift, reachability, decision-shape, verified-by), plus every verify harness
that asserts the ticket format — the survey names ~28 of them, notably `verify:board-tool`,
`verify:decision-shape`, `verify:reachability`, `verify:tickets`, `verify:arch-watch`,
`verify:onboard`, `verify:fleet-sync`, and the Playwright `BUG-025-needs-you-question.spec.ts`.
These are the anti-regression set; they are named here so the build cannot claim green without them.

---

## 7. Risks

| # | Risk | Why it is real here | Mitigation |
|---|---|---|---|
| 1 | **Model plays it safe and nulls the human fields.** | The provenance check would not notice — it only inspects copied values. | The schema's human-layer fields are all required non-null with word floors as well as caps; `source.dropped` makes an over-eager drop visible; 100% human review of the open tickets, 15% of the done. Accepted residual: a bland-but-valid summary on a done ticket can survive unnoticed, and that is a cost worth paying against building a comparison harness. |
| 2 | **The prompt injected into every session grows.** | `boardStateSection()` composes a board snapshot into every launch prompt (`agent-bridge.ts:1050`). Structured fields are more verbose than a status line. | Budget the snapshot explicitly; it should get *smaller* — enums instead of prose status blurbs — and the build must measure it before and after. |
| 3 | **Five parsers is really nine consumers.** | `board.ts`, `tickets.ts`, `board.mjs`, `arch-watch.mjs`, `real-decisions.mjs`, `app.js` (client-side `mdField`), `onboard.mjs` (embedded verbatim copies of the format), `capture-guide-screenshots.mjs`, `guide-fixture.mjs`. | Step 1 lands the schema module and converts consumers *before* any ticket changes shape; the compatibility reader (§8) makes that possible. |
| 4 | **Four verbatim copies of the format spec** in `TEMPLATE*.md`, `docs/bugs/README.md`, `onboard.mjs`'s `BUGS_*` string constants, and the guide fixtures. | They will drift. | Generate all four from the schema module; `docs:fresh` already exists as the ride-along that catches doc staleness. |
| 5 | **Onboarded repos break.** | `board.mjs` is copied out; their tickets are in the old format. | The schema module ships with a compatibility reader that parses old-format tickets read-only. Onboarded repos keep working un-migrated; migration there is opt-in via `board:migrate`. |
| 6 | **Quota window stalls the run.** | OpenAI here is a subscription plan on 5-hour windows, explicitly not for bulk volume. | Resumable id-keyed cache (the `haiku-check.mjs` pattern), backoff on `failureKind`, run across windows. Nothing is lost on interruption. |
| 7 | **Title rewriting loses searchability.** | People and agents grep for today's argument-titles. | The original title is retained as `source.original_title` and indexed by search. |
| 8 | **Dark-mode contrast imported from the prototype.** | Two defects found in the captures (§1.2), and BUG-101 is the existing app-wide instance. | Use Orchard tokens; run the existing contrast check on the new views. |
| 9 | **A high-stakes, regression-prone change.** | This touches the board every agent reads every session, and rewrites 182 files in one commit. | Flagged in §9. |

---

## 8. Order of work — landable steps

Each step lands green on its own, and the board keeps working after every one.

**Step 1 — the schema module, no format change.**
`scripts/lib/ticket-schema.mjs`: enums, `validateTicket`, `parseTicket` (reading *both* the new block
and, in compatibility mode, today's prose format), `formatTicket`. Unit-tested against fixtures
including truncated and malformed input. Nothing else changes. *Lands: a validator with no callers.*

**Step 2 — collapse the parsers onto it.**
Convert `board.mjs`, `board.ts`, `tickets.ts`, `arch-watch.mjs` to call `parseTicket` in compatibility
mode. The three conflicting `isDone` rules become one — **this alone fixes the `FIXED`-ticket
discrepancy and the 3-ticket INDEX/header disagreement**, on today's files, before any migration.
Anti-regression: the ~28 format harnesses. *Lands: a real bug fixed, one parser, zero format change.*

**Step 3 — the provenance check.**
§6.1, standalone, run over the *real* current corpus to establish the baseline provenance set for all
182 tickets. Both must-FAIL cases proven before anything is migrated. Small — a few dozen lines.
*Lands: the acceptance check, proven to fail correctly.*

**Step 4 — the renderer, on hand-authored tickets.**
Build the human-layer/deep-layer ticket view and the decision card with all three modes, in Orchard's
dark tokens. Drive it in headless Brave over a **busy-state** fixture — many tickets, mixed states, a
staged decision, a multi-select, a `null` recommendation, a ticket with a 50-entry log, a ticket with
every optional field `null` — and grade the captures. Hand-author 3–4 tickets in the new format to
drive it. *Lands: the UI, provably, on realistic state.*

**Step 5 — the pipeline, on 10 tickets.**
Run §5.3 over a stratified sample of 10 (one giant, one ARCH, one multi-select, one staged, one
`null`-recommendation, three done, two trivial). Provenance check plus 100% human review. Measure
actual per-ticket tokens and seconds, and **re-forecast §5.4 from the measurement** rather than
trusting the estimate. *Lands: a calibrated pipeline and a real cost number.*

**Step 6 — the full run into `.migrated/`.**
All 182. Quarantine handling. Nothing promoted. *Lands: a candidate set nobody reads yet.*

**Step 7 — review, then the single cutover commit.**
§6.2 review, then §5.6 promotion in one commit. `git revert` is the rollback. *Lands: the new board.*

**Step 8 — close the folded tickets and regenerate the spec copies.**
ARCH-004 → superseded, answer recorded. FEAT-082 → answered (option B via migration). Regenerate
`TEMPLATE*.md`, `docs/bugs/README.md`, `onboard.mjs`'s embedded strings and the guide fixtures from
the schema module. Add `ticket-schema.mjs` to `COPIED_TOOLS` **and** `SYNCED_TOOLS`, and fix
`verdict-contract.mjs`'s missing `SYNCED_TOOLS` entry while there.

Steps 1–3 are pure gain and land whatever happens to the rest. If the migration is ever abandoned,
steps 1–3 still leave the board with one parser, one `isDone` rule and a content-preservation
checker.

---

## 9. Verification posture

This is a **high-stakes, regression-prone** change by the standing rule: it touches session-lifecycle
adjacent surfaces (the board snapshot injected into every launch prompt), it rewrites 182 files that
constitute this project's audit trail, and the files it touches have a documented regression history
(ARCH-004's three instances, BUG-025, BUG-103). The builder's own suite must not be the last word:
**an independent clean-room verify pass is warranted on steps 2 and 7** — `scripts/independent-verify.mjs`,
cross-provider, with the parser collapse and the cutover commit as the reviewed claims. At $4.13 mean
per clean-room round, two rounds cost about $8 against a $22 migration; there is no economic argument
for skipping it. Steps 1, 3 and 5 are routine and do not need it.

### Evidence behind this document

- Prototype rendered in headless Brave over CDP at 1440×1600; six captures graded with
  `scripts/lib/shot-luma.mjs`: light 243.5 / 244.6, dark 30.4 / 33.0 / 34.0 / 33.5, all six distinct
  by md5. Above-fold element inventories captured per view.
- Word counts and decision-offsets computed over the real ticket files in `docs/bugs/`.
- Corpus statistics measured: 182 tickets, 2,466,538 bytes, 717,943 bytes (29.1%) preceding the
  activity log, ~180 K head tokens, one ticket with a head above 20 KB.
- Format-dependency inventory and dispatch/cost infrastructure surveyed read-only across
  `scripts/`, `src/server/`, `public/`, `docs/prompts/` and `package.json`.
- Cost priced off `docs/prompts/ROUTING.md`'s ladder and `docs/analysis/pipeline-cost-2026-08-19.md`'s
  measured per-lane figures.

**Not verified, and it should be:** the prototype was graded at four tickets and one viewport width.
The busy-state and narrow-viewport behaviour of the new view is step 4's job, not this document's
claim.
