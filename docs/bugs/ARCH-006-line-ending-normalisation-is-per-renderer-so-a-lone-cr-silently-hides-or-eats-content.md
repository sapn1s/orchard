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
  "verification": [],
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
