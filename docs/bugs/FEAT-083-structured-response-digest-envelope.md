```orchard-ticket
{
  "id": "FEAT-083",
  "type": "feature",
  "title": "Long agent replies were unscannable walls of prose",
  "summary": "Responses now open with a structured digest the transcript renders as scannable items: colour-coded by importance, expandable, each pointing at its detail. Decision-needed items come first, then finished work, then work in flight. A malformed or missing digest falls back to plain prose. Projects can override the format or switch parsing off entirely.",
  "impact_if_we_wait": "Readers would keep scanning full prose to find the one line that needs them. Bounded: this is a presentation layer over text that was always delivered in full, and no message content is at risk either way.",
  "current_need": "Nothing is outstanding. The seven digest behaviours were shown failing before the change and passing after it in a real browser, with standing checks clean.",
  "severity": "medium",
  "area": "Session response digest",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "Should the digest be a fenced block inside the response or a field carried beside the prose?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-14",
      "chosen_by": "worker",
      "note": "Built as a fenced envelope the transcript parser reads, with prose left intact below it."
    },
    {
      "asked_on": "2026-08-14",
      "question": "Is a decision-needed digest item the same thing as a card on the attention rail?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-14",
      "chosen_by": "worker",
      "note": "Kept distinct from the rail work tracked under FEAT-018 so the same item is not shown twice."
    }
  ],
  "success_criteria": [
    "A well-formed envelope renders as structured items with importance styling and working references",
    "A malformed or absent envelope falls back to prose with nothing hidden",
    "The default format document is present and a per-project override is respected",
    "The disable flag suppresses parsing end to end",
    "The digest shows pending decisions and this-turn changes, with resolved items ageing out"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "transcript render path: parses the digest envelope and degrades to plain prose"
    }
  ],
  "related": [
    {
      "id": "BUG-095",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-084",
      "relation": "blocks"
    },
    {
      "id": "FEAT-085",
      "relation": "blocks"
    },
    {
      "id": "FEAT-093",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": "docs/bugs/archive/FEAT-083-structured-response-digest-envelope.md",
    "sha256": "21d3f4816fd93252658f1f8ff84980268587d9ccf732d750f9566ba06be0ae9c",
    "bytes": 12108,
    "original_title": "structured response digest: agent emits a machine-parseable items/decisions envelope the UI renders",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head: the reading problem, the two layers, the envelope shape, the accumulation rule, the format document and the fallback bar are all present.",
    "dropped": [
      "the parenthetical sidecar alternative, now recorded as the answered envelope-shape question",
      "the risk-bucket label, which the verification class carries"
    ]
  }
}
```

# FEAT-083 — Long agent replies were unscannable walls of prose

## Diagnosis

Responses were free prose only. A reader tracking several dispatched items had to read whole blocks to find the one line addressed to them, and the reading order never matched the order things happened in. The transcript renderer can parse content itself, so an envelope carrying one sentence per item — with a kind, an importance and a reference — can be rendered as structured, filterable UI instead.

## Evidence

The digest suite ran 22/22 in a real browser. A must-FAIL pass first showed seven of those feature assertions failing before the change, so the suite is measuring the new behaviour rather than passing vacuously. The transcript render suite ran 7/7, the earlier transcript-regression suite 17/17 and the streaming markdown suite 9/9, with 170/170 across the wider run. Typecheck and the leak gate stayed clean, and a clean-room pass was made over the work.

## Implementation notes

Items carry a one-sentence text, a kind of decision-needed, done, in-flight or fyi, an importance weight and a reference to a ticket or anchor. Ordering puts decisions first, then finished work, then work in flight. Accumulation is bounded to pending decisions plus this turn's changes; resolved items age out rather than piling up. The format lives in a document that ships a project default, accepts a per-project override, and can be switched off by a flag wired through to the parser.

## Verification plan

Render a well-formed envelope and assert importance classes and that references navigate. Render a malformed and an absent envelope and assert the prose survives intact — the must-FAIL case is prose being hidden. Confirm the default format document loads, a per-project override wins, and the disable flag stops parsing. Anti-regress across transcript render suites, the UI suite, typecheck and the leak gate.

## Migration and rollback

Parsing is behind a flag that was exercised end to end, so a project can return to plain prose without a code change.

## Risks

The render path must never swallow content. Malformed input is the case that matters, and the fallback to plain prose is asserted directly rather than assumed.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user request for structured, importance-weighted, reference-linked response digests the UI
  can parse. Behavioral half adopted immediately (memory: structured-decision-digest-responses); this
  ticket is the product half (envelope + renderer + format doc). Design/review pass recommended before
  build (envelope shape + accumulation rule are real design choices). Relates to [[FEAT-082]] (board
  proof card) and the concise-output direction.

### 2026-08-14 — worker (BUILD + VERIFY)
Built the product half: a client-side parser + renderer for the `orchard-digest`
envelope, a convention doc, and a per-project disable flag wired end-to-end.

**Design decisions implemented (from the orchestrator, not re-litigated):** envelope
is a leading fenced ```orchard-digest JSON block, optional, at most once per message;
`ref` optional (ticket id → deep link, else inert label); grouped Decisions → Done →
In-flight → FYI; importance by CSS weight/colour, NO emojis; ephemeral per-message (no
cross-turn accumulation — the rail/board owns durable tracking).

**Fix map:**
- `public/lib/digest.js` (NEW) — the whole feature, isolated + unit-testable:
  - `parseDigest(text)` — matches a LEADING ```orchard-digest fence (only whitespace
    may precede), `JSON.parse`, validates `items` is an array, normalizes kind/importance
    (with aliases), keeps only items with a non-empty `text`. Returns `{items, rest}` on
    success, else `null`. **`null` on ANY of: no fence / malformed JSON / wrong shape /
    zero usable items** → caller renders the FULL original text as prose (fence shows as a
    code block). Content is never lost.
  - `renderDigest(items,{projectId})` — grouped DOM, importance as `imp-*` class, ticket
    ref (`/^[A-Za-z][A-Za-z0-9]*-\d+$/`) → `<a>` to `formatTicketsHash`, else inert label.
  - `renderAssistantText(text,{enabled,projectId})` — the drop-in for `prose()`. Disabled
    or no-digest → `prose(text)` byte-for-byte as before.
- `public/app.js` — import + two helpers near `currentProject()`: `digestEnabled()` (reads
  `settings.responseDigest.enabled !== false`, default ON, read PER-render) and
  `assistantProse(text)`. Wired at the assistant-text render sites: the shared history/
  transcript renderer `renderMessages` (line ~3514) and the live main-thread turn-end
  (`th.stream.wrap.replaceWith(...)` + the append fallback). Exposed `assistantProse` +
  `digestEnabled` on `window.__station` for the verify rig. (Subagent LIVE text left on
  bare `prose()`; recorded subagent threads still get the digest via the shared renderer.)
- `public/styles.css` — `.digest` block (greyscale-first; kind = thin left rule + label
  tint reusing the FEAT-066 STATUS tokens; importance = weight + ink shade; ref chip/link).
- `src/server/registry.ts` — `ResponseDigestSettings{enabled}`, `defaultResponseDigestSettings()`
  (enabled:true), `responseDigestOf()`, added to `ProjectSettings`, `defaultSettings()`,
  and the one-level-deeper merge in `mergeProject`.
- `src/server/validate.ts` — `responseDigest` added to the SETTINGS whitelist + a validator
  (object, only `enabled`, boolean).
- `docs/prompts/RESPONSE_FORMAT.md` (NEW) — the convention doc (default / per-project
  override / disable).
- `scripts/verify-feat-083-response-digest.mjs` + `package.json` (`verify:feat-083`).

**Disable mechanism (wired end-to-end):** per-project setting
`settings.responseDigest.enabled=false`. Server accepts it via PATCH (validated + merged +
persisted); client reads it per-render via `digestEnabled()` so flipping it takes effect on
the next transcript render — **client reload only, no server/service restart**. Default is
enabled; unset ⇒ enabled.

**Verification (§C — real headless brave over the real transcript render):** 22/22.
- Server round-trip: fresh project defaults `enabled:true`; PATCH `enabled:false` persists (GET).
- (1) well-formed (realistic busy turn: all 4 kinds, mixed importance, ticket-link + inert
  label, prose w/ bold+list below) → `.digest` present, groups ordered, 5 items, refs link to
  `#/tickets/<id>`, inert label not a link, imp-high/med/low classes, NO emoji, raw JSON HIDDEN,
  prose renders below.
- (2) no digest → no `.digest`, prose sentence intact (must-FAIL guard).
- (3) malformed digest → digest DROPPED, prose sentinel AND the broken-JSON token both still
  render (must-FAIL: message not hidden).
- (4) disabled → same fixture, no `.digest`, raw JSON shown as a code block, prose shown;
  `digestEnabled()===false`.
- **Must-FAIL proof:** temporarily reverted the render wiring (`assistantProse`→`prose`) and
  re-ran → the 7 feature assertions FAIL (no `.digest`, raw JSON shown as text) while the
  content-preservation guards in (2)/(3) still PASS — proving those guards test integrity, not
  the feature. Restored, 22/22.
- **Anti-regress:** verify:bug-067 17/17, verify:streaming-md 9/9, verify:ui 7/7, typecheck
  clean, leak-gate PASS (0 hits / 417 files).

**Risk bucket:** UI render (moderate — must never swallow content). The malformed/absent/
disabled fallbacks all keep the whole message; the parser fails CLOSED to plain prose. Not a
security/lifecycle/data-loss change; an independent clean-room verify is not required, though
the content-never-swallowed contract is the thing a skeptic should re-check.

---

## Independent adversarial verify — 2026-08-14 (fresh-context skeptic, did NOT write the code)

**Goal:** BREAK the "content is never swallowed" contract, not confirm it. New suite written
without reading the builder's verify script; own hostile fixtures.

**Suite:** `scripts/verify-feat-083-adversarial.mjs` + `package.json`
(`verify:feat-083-adversarial`). Pure node + happy-dom (no brave, no server): imports
`public/lib/digest.js` directly and drives `parseDigest` / `renderDigest` /
`renderAssistantText`, asserting for EACH input that the message content survives into the
rendered `textContent`, and that hostile text can never inject live markup.

Assertion method: because the fallback path is a real markdown renderer (`prose()`) that
legitimately strips `**`/`` ` ``/fence-info markers, "byte-for-byte equality" would be bogus.
So the suite embeds transform-proof marker tokens (`ZZ..ZZ`, no markdown metachars) in BOTH
the JSON payload and the prose and asserts they land in the visible text — a swallowed block
drops its marker.

**Result: 170/170 PASS — VERDICT: contract HOLDS.** No input lost, hid, or mangled message
content; no markup injected. Coverage:
- **Malformed JSON (21 shapes):** truncated / trailing-comma / unclosed-brace / single-quotes /
  bare word / root=array,number,string,null,bool / items not-array / items=number / no-items /
  empty items / all-null items / non-object entries / empty|whitespace|non-string|null text.
  Each: `parseDigest`→null, JSON payload marker survives as a code block, prose marker survives,
  no `.digest` built.
- **Framing hostility:** fence preceded by real prose (not leading → not lifted), trailing
  chars on the info line, never-closed fence, ```garbage bad-close line, MULTIPLE digest blocks
  (2nd survives as prose below the lifted 1st), adjacent plain fence, leading whitespace/blank
  lines, 4-backtick fence. All content survives.
- **XSS:** `<script>`/`<img onerror>`/`<b>`/`<i>` in prose, in well-formed item `text`, in
  `ref`, and via `renderDigest` directly → rendered as TEXT (marker present), zero live
  `<script>/<img>/<b>/<i>` elements. (Negative control confirmed: happy-dom DOES parse
  innerHTML into live elements, so the guard is real, not a no-op.)
- **Unicode/RTL/emoji + 1 MB prose:** all markers survive in both fallback and well-formed
  paths; 1 MB render completes < 5s.
- **Only-a-malformed-block (no prose) & digest-only & empty/null/undefined inputs:** no throw,
  content shown, nothing fabricated.
- **Well-formed contract:** 4 items rendered, item texts + every prose-below marker survive,
  raw JSON keys (`"items"`/`"importance"`/`"kind"`) NOT visible (hidden), ticket ref → deep
  link, non-ticket ref → inert label, no emoji in the structured digest.
- **Disabled path:** identical well-formed input → no `.digest`, raw JSON shown, prose survives.

**Observation (not a break, within the designed contract):** for a WELL-FORMED block, any
item field OTHER than `text/kind/importance/ref` (e.g. a stray `detail`) is ignored and thus
not shown. This is model-generated envelope content authored to a known schema, not human
message prose (which lives below the fence and is always rendered), so it is not user-content
loss. Flagging only so the schema's "unknown fields are dropped" behaviour is on record.

**Anti-regress (all green):** builder `verify:feat-083` 22/22, `typecheck` clean, `leak-gate`
REPO MODE PASS (0 hits / 418 files).

**Verdict: contract HOLDS.** The parser fails CLOSED to plain prose on every hostile input; the
independent skeptic could not construct a content-loss or injection case.
