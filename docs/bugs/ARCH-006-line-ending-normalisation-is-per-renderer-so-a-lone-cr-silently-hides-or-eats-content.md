```orchard-ticket
{
  "id": "ARCH-006",
  "type": "architecture",
  "title": "Renderers can silently hide content with mixed line endings",
  "summary": "Readers can receive plausible but incomplete content when renderers encounter mixed line endings. Three renderers required separate corrections because text is not normalized at a shared boundary and each renderer must remember the rule independently.",
  "impact_if_we_wait": "New renderers can silently hide or delete content, repeating three instances found in one day. Bounded: this affects local display-correctness, not security, deployed systems, other users, or their data.",
  "current_need": "Build option A: inventory the model, transcript and file entry points, canonicalize text as it arrives one entry point per commit, and drop a renderer's own rule only once every source feeding it is canonical.",
  "severity": "medium",
  "area": "Text rendering",
  "reported": "2026-08-18",
  "reported_by": "bug-hunt workflow",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-18",
      "question": "How should mixed line endings be kept from silently hiding rendered content?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user, through the ARCH-010 class decision",
      "note": "The class rule overrides this ticket's own recommendation of B, and the reason is exactly why the class was settled: B keeps every renderer working the rule out for itself and adds a check that counts the workings-out, which is the option the class decision rejects by name. C is patch-on-discovery, and invisible content loss is a poor discovery mechanism. A is the only option where the owner of the text — the path that ingests it — declares it canonical once and no reader repeats the rule. The inventory A needs is the build's first step rather than a reason to prefer a guard."
    }
  ],
  "success_criteria": [
    "Every model, transcript and file entry point makes text canonical before any renderer sees it",
    "Mixed-ending input renders identically to its LF-normalized equivalent",
    "Collapsed content remains present in the accessibility tree",
    "The chosen design covers future renderers or every proven ingestion boundary",
    "Each migration step can land and revert independently"
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "prose",
      "note": "Previously normalized CRLF but missed lone CR before line-shaped processing."
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "renderAssistantText",
      "note": "One transcript entry path now normalizes mixed line endings."
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "renderBody",
      "note": "Digest rendering has its own normalization entry."
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "parseDigest",
      "note": "Digest parsing participates in the local normalization fix."
    },
    {
      "path": "public/lib/response-blocks.js",
      "symbol": null,
      "note": "Per-line classification previously split only on LF."
    }
  ],
  "related": [
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-109",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-110",
      "relation": "see_also"
    },
    {
      "id": "BUG-111",
      "relation": "see_also"
    },
    {
      "id": "BUG-119",
      "relation": "see_also"
    },
    {
      "id": "FEAT-091",
      "relation": "recurrence_of"
    }
  ],
  "recurrence_evidence": [
    "FEAT-091",
    "BUG-109"
  ],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ea4f1e87-01f8-4544-a104-79f5b9c1956b",
      "verdict": "holds",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "note": "Step 1 of the migration only (boundary normalise at bulletLines + entryBody). The ARCH migration as a whole remains incomplete."
    }
  ],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/ARCH-006-line-ending-normalisation-is-per-renderer-so-a-lone-cr-silently-hides-or-eats-content.md",
    "sha256": "c2cd204b27062e482e3843140275e2434ea833017158e68b6a0e7d8ed0b9777c",
    "bytes": 15780,
    "original_title": "line-ending normalisation is owned per-renderer, so any renderer that forgets it silently hides or deletes content",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived original; the recurrence, three options, recommendation, bounds, migration sequence, proof bar, and falsifying conditions remain represented.",
    "dropped": []
  }
}
```

# ARCH-006 — Renderers can silently hide content with mixed line endings

## Diagnosis

ARCH-006 records a shared architectural failure across independent renderers. Text arrives from model streams, transcripts, and files with LF, CRLF, or lone CR endings. Each renderer implements line-shaped rules around LF and must independently remember to normalize first. Forgetting is silent: no compiler or runtime error exposes the omission.

There is no established point where untrusted text becomes canonical text. Local fixes protect only their own paths, leaving sibling and future renderers exposed by default.

## Evidence

FEAT-091 contained two instances: per-line response classification treated carriage returns incorrectly, and a separate digest path failed on generated mixed-ending inputs. BUG-109 found that prose rendering handled CRLF but not lone CR, allowing a fence information-string strip to consume a complete code line.

A real-browser observation described authored content missing from both the visible fold and accessibility tree. A generated corpus exposed the digest path after the first local repair. These observations illustrate the class; they are not an independent clean-room verdict for this architecture ticket.

## Implementation notes

Option B adds a repository-wide guard over renderer modules. A module containing a line-shaped split, replacement, or anchored expression must normalize mixed endings before that rule runs. Deliberate exceptions need a named allowlist. The guard must detect values passed through local variables and avoid treating output-only joins as rendering rules.

Option A instead canonicalizes text at model, transcript, and file ingestion boundaries. Renderer-level normalization should remain until every source feeding that renderer has been inventoried and converted.

## Verification plan

Introduce a synthetic renderer that splits on LF without normalization and confirm the mechanical guard rejects it. Repeat with the value passed through a local variable. Exercise realistic streamed tokens, transcripts, and file bytes containing CRLF and lone CR through each real rendering path, comparing output with the LF-normalized equivalent.

For collapsible content, drive collapse and expansion in a headless browser and assert that authored content remains in the accessibility tree. If pursuing boundary normalization, enumerate every ingestion path before removing any renderer-level safeguard.

## Migration and rollback

Land the renderer guard first with no allowlist because the three known renderers already normalize. Extend it to inventory model, transcript, and file ingestion paths. Use that inventory to decide whether boundary normalization is complete enough to adopt.

If A proceeds, normalize one entry point per commit. Remove a renderer safeguard only after all sources feeding it are canonical. Every step is independently revertible; reverting the initial guard should require an explicit decision.

## Risks

Boundary normalization fails silently when the inventory misses a source or a new raw source appears. Renderer enforcement can miss indirect flow or produce false positives that erode trust in the guard. Continued local patching leaves invisible content loss as the discovery mechanism and repeatedly spends adversarial testing effort.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — promotion lane (worker)
- **Understood:** BUG-109's Deeper-flaw note pre-committed to handing this class forward, and it is a real class: three renderers (`response-blocks.js`, `digest.js`, `prose()`) each broke the same one-sentence invariant — a line-shaped rule observing a `\r` its own splitting never accounted for — within hours, each fixed correctly at its own module, none preventing the next. Filed to the ARCH contract with the invariant stated testably (behaviourally as output-equivalence under line-ending rewrite, mechanically as "no line rule before a normalise"), so this is an ARCH and not a BUG. Kept the severity proportionate: single-user local tool, no security dimension; it matters because two of three were silent content loss/hiding, the project's stated worst failure class.
- **Changed:** this ticket, and a one-line cross-reference appended to BUG-109. No product code, no scripts, no `public/*`, no `src/server/*`. Did not run `board:gen` (orchestrator owns INDEX).
- **Verified:** nothing to verify — this ticket builds nothing by design. `npm run gate` run before commit, exit status read directly.
- **Still open / handoff:** a human picks A, B or C. The cheapest information-gathering move, and the one that makes the A-vs-B decision evidence-based instead of a guess, is migration steps 1–2 (land the mechanical check as a ratchet, then extend it to enumerate untrusted entry points) — those produce the boundary inventory nobody currently has. Owner flip to 👤 on INDEX is needed for the Decide card to render (orchestrator-owned).

### 2026-08-25 — settled by the class decision (ARCH-010 option A); no build in this lane

- **Understood:** this ticket was one of eight instances of one habit, settled as a class by the
  user on 2026-08-25. Applied here the rule picks A, and it does so **against this ticket's own
  recommendation of B** — which is worth stating plainly rather than quietly. B leaves every
  renderer owning the rule and adds a commit-time check that counts the places that own it; that is
  option C of ARCH-010 at renderer scale, and the class decision rejects it by name. The owner of a
  piece of text is the path that ingests it — the model stream, the transcript reader, the file
  read — and A is the only option where that owner writes the canonical form down once.
- **Re-measured before recording it, because this ticket is a week old.** There is still no shared
  normalizer and no boundary. Seven separate normalisations in the browser
  (`public/lib/dom.js:327`, `public/lib/digest.js:94`, `:297`, `:424`, `:465`,
  `public/lib/response-blocks.js:1307` used at `:1441` and `:1908`, plus the trailing-terminator
  trims in `public/lib/ticket-record.js:91` and `:108`), each an inlined copy of the same literal;
  `LINE_ENDINGS_RE` is module-private and exported to nobody. **A new fact, and it is worse than
  the ticket knew:** the three server-side sites handle CRLF only —
  `src/server/tickets.ts:398`, `src/server/board.ts:949`, `src/server/index.ts:214` all use
  `/\r\n/g`, so a lone CR passes through the server path intact and reaches renderers that the
  browser-side fixes were written to protect. That is the same defect one layer up, and it is
  evidence for A over B: a renderer guard would never have looked there.
- **The prerequisite is now the first build step, not a blocker.** "Establish whether ingestion
  boundaries form a small, closed set" — the inventory is what commit one produces, and the sites
  above are its starting list. `BUG-111` has since given `prose()` and `response-blocks.js` one
  shared fence model (`public/lib/dom.js:330-341`), which shows the shape this migration takes: one
  owner, every reader reading it.
- **Changed:** this ticket's record only — the decision moved to `decision_history` with A chosen,
  `human_action` is now `none`, `current_need` states the build. One success criterion was
  restated: the first one was option B's bar ("a new renderer with an unnormalized line rule is
  rejected before landing"), which no longer describes what has to be true; it now reads "every
  model, transcript and file entry point makes text canonical before any renderer sees it". The
  other four are untouched. No code, no scripts, no `public/`, no `src/`. `work_state` stays `open`
  because nothing has been built.
- **Verified:** `validateTicket` ok; `npm run board:check` exit 0, read directly. No behaviour
  changed in this lane, so there is no must-fail to show.
- **Still open / handoff:** all of the build, in the order the migration section already gives —
  normalize one entry point per commit, and remove a renderer's own rule only after every source
  feeding it is canonical. The three CRLF-only server sites are the cheapest first commit and the
  one with a live defect behind it. Keep the existing renderer normalisations until then: they are
  the safety net, and the class rule is satisfied by the boundary declaring the fact, not by
  deleting the net early.

### 2026-09-29 — fixing lane, round 1 (worker): step 1 of option A landed at the two clean server sites

- **Understood:** the migration's first landable step — normalize text as it ENTERS at the two
  server entry points whose files are clean (`board.ts` `bulletLines`, `tickets.ts` `entryBody`).
  Out of scope this round because other live sessions hold uncommitted edits there:
  `src/server/index.ts` (~:263) and `src/server/orchard-transcripts.ts`. Confirmed clean before
  editing: `git diff src/server/board.ts src/server/tickets.ts` empty; live-sessions poll shows
  the dirty owners are FEAT-155/BUG-196 on index.ts/events.ts/app.js, not my two files.
- **Reproduced the harm FIRST (must-FAIL before the fix).** Both sites composed a user
  reply/note into a ticket's append-only Activity log while replacing `\r\n` ONLY, so a bare/lone
  `\r` in the reply survived into the markdown record. Drove the REAL write path
  (`appendNote` → `entryBody`, and the exported `composeAnswerEntry` → `bulletLines`) over a COPY
  of the real `docs/bugs` board with a realistic 4-paragraph reply whose paragraphs are separated
  by LF, CRLF and a lone CR. Pre-fix the record read
  `…Third paragraph…vanishes.<CR>Fourth paragraph…` — P3 and P4 collapsed onto ONE physical line
  with an embedded CR, so a CR-honouring renderer/terminal hides P3 (the ticket record the user
  reads). Hypothesis confirmed: a lone CR at these entry points does hide content in the ticket
  record. Command: `npx tsx scripts/verify-arch-006-boundary-normalise.mjs` → **8 passed, 6 failed**
  (exit 1) against pre-fix code.
- **Changed:** added ONE shared normaliser `normalizeLineEndings(text)` in
  `src/server/board.ts` (owner's single declaration; `/\r\n?/g` collapses CRLF then lone CR to LF)
  and applied it at `bulletLines` (was `/\r\n/g`); imported it into `src/server/tickets.ts` and
  applied it at `entryBody` (was `/\r\n/g`). Per the ticket, renderer-level rules
  (`LINE_ENDINGS_RE` in `public/lib/response-blocks.js`, the `public/lib/*` normalisations) STAY —
  not removed — because sources feeding them are not yet all converted. New test:
  `scripts/verify-arch-006-boundary-normalise.mjs`.
- **Verified:** after the fix `npx tsx scripts/verify-arch-006-boundary-normalise.mjs` → **14
  passed, 0 failed** (exit 0); the record now carries all four paragraphs on their own indented
  continuation lines, no embedded CR. PART 0 is a git-independent must-FAIL anchored to a
  synthesized pre-fix `\r\n`-only state (not a moving baseline). Anti-regression on the
  composer/write-path suites: `verify-feat-090-followup` 13/13, `verify-bug-104-chose-roundtrip`
  11/0. `verify-feat-090-answer-handoff` (23/24) and `verify-feat-090-answered-lane` (25/26) each
  have ONE failing check — a live-session precondition and live-board answered-section ordering
  respectively — both environment/live-board dependent, neither feeds reply text through the
  composers I changed, so pre-existing, not a regression. `npm run gate` **PASS (exit 0)** incl.
  typecheck (the export/import wiring compiles). `npm run board:check` exits 1 but every FAIL is a
  pre-existing INDEX/status mismatch on obsolete tickets (BUG-143/150/164/166/FEAT-104/140 DONE-in-
  Open, BUG-199 missing row) — orchestrator/INDEX-owned, none involve ARCH-006.
- **Still open / handoff:** NEXT STEP — apply `normalizeLineEndings` at the remaining server
  entry points once their owning lanes land: `src/server/index.ts` (~:263, the transcript/model
  ingest) and `src/server/orchard-transcripts.ts`. After ALL sources feeding a given renderer are
  converted, and only then, remove that renderer's own rule (`public/lib/*`,
  `response-blocks.js` `LINE_ENDINGS_RE`). Do not mark VERIFIED: this is one step of a multi-step
  migration and warrants an independent clean-room verify (touches an append-only record; a
  regression-prone class). `work_state` left `open` (migration incomplete); INDEX untouched
  (orchestrator-owned).

### 2026-09-29 — clean-room verify lane, round 1 (driver): step 1 HOLDS (VALID)

- **Verified-by:** dispatch anthropic run ea4f1e87-01f8-4544-a104-79f5b9c1956b (clean-room,
  `scripts/independent-verify.mjs --working-tree`, grey account — same-provider fallback, openai
  exhausted; VERIFY.md #5) — VERDICT: HOLDS, verdict-contract VALID.
- **What was verified:** the step-1 boundary normaliser (`normalizeLineEndings` applied at
  `board.ts` `bulletLines` via `composeAnswerEntry`, and `tickets.ts` `entryBody` via `appendNote`).
  The independent verifier re-ran the fixer test (`npx tsx
  scripts/verify-arch-006-boundary-normalise.mjs`, exit 0, 14/14) and then constructed adversarial
  cases the fixer fixture does NOT cover, all exit 0: bare-CR-ONLY input, CR-then-CRLF/blank-line
  mixes (`\r\r\n`, `\n\r\n`, `\r\n\r`), a leading/trailing lone CR, CRLF-only, and a CR-FREE
  identity check byte-comparing the post-transform output against the pre-fix `entryBody`/
  `bulletLines` rule — driven through the REAL `appendNote`/`readTicket` and `composeAnswerEntry`
  over a copy of the real board, byte-comparing the file prefix before/after each append
  (append-only-safety). No embedded CR survived; every paragraph landed on its own line; CR-free
  input was byte-unchanged. The real board was provided to the clean room as a declared input
  (`--allow-input docs/bugs`) because the fixer test drives the real write path over a real ticket.
- **Verifier's own "could not test" (recorded honestly, not defects):** CR inside the OTHER fields
  `composeAnswerEntry` writes (`question`, `chose` label, `author`/`label`) is not normalised — out
  of scope (requirement covers the reply/note text only); the HTTP route handlers in
  `src/server/index.ts` that also call these fns (that server entry point is a LATER migration step,
  still not converted); and visual render in a real terminal/browser (checked structurally: no CR
  byte, one paragraph per physical line).
- **Scope of this verdict:** step 1 ONLY. This ARCH ticket tracks a multi-step migration; the
  remaining server entry points (`index.ts` ~:263, `orchard-transcripts.ts`) and the eventual
  removal of the renderer-level `public/lib/*` safeguards are NOT done. `work_state` stays `open`.
  Whether/when to close the ARCH ticket is an orchestrator decision, not implied by this HOLDS.
  Independent clean-room verify of step 1 is now satisfied per the fixer's handoff (append-only
  record, regression-prone class). INDEX untouched (orchestrator-owned).
