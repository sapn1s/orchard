# FEAT-083 — structured response digest: agent emits a machine-parseable items/decisions envelope the UI renders

- **Status:** VERIFIED (2026-08-14 — worker; UI parser+renderer built, 22/22 real-brave, must-FAIL proven 7 feature assertions FAIL pre-fix; disable flag wired end-to-end)
- **Area:** the session response surface (public/app.js transcript render) + a response-format convention doc
- **Reported:** 2026-08-14 by user

## Problem
Agent responses are free prose. The user reads ~10% and processes messages one-per-dispatched-item, so
a stream of prose blocks falls out of sync with their reading. They want, at the top of a response, a
scannable list of items/decisions — one sentence each, importance-weighted, each pointing to the detail —
so they can track state at a glance and dive into prose only when they choose. Orchard's UI can custom-parse
content, so a STRUCTURED envelope (not just prose) can be rendered: color-coded by importance, expandable
per item, filterable.

## Wanted (two layers)
1. **Now (behavioral, no code):** the agent leads responses with a markdown digest (NEEDS-YOU/decisions
   first, then done/changed, then in-flight; one line each with an importance marker + a detail pointer),
   prose below. Captured as a memory/convention today.
2. **Product (this ticket):** a defined, machine-parseable response envelope (e.g. a fenced ```orchard-digest
   JSON block, or a sidecar) the transcript renderer parses into structured UI — importance color-coding,
   collapse/expand per item, links to the referenced ticket/paragraph. Items carry: text (one sentence),
   kind (decision-needed / done / in-flight / fyi), importance, and a ref (ticket id or anchor).
   - Guidance on ACCUMULATION: the digest shows current pending decisions + this-turn changes, not full
     history; resolved items age out. Define the clear/collapse rule so it doesn't pile up.
   - A response-format DOC (WA-like): a project default, per-project customizable, and disable-able —
     so the format self-improves and projects opt in/out.

## Open questions (for a design/review pass before build)
- Envelope shape: fenced JSON block in the response vs a structured field the runtime carries alongside prose.
- Does the agent ALWAYS emit it, or only for substantive/decision-bearing turns?
- How the renderer degrades if the block is malformed/absent (must never hide the prose).
- Relationship to the Needs-You rail (FEAT-018/079) — is a "decision-needed" digest item the same as a
  rail card, or distinct? Avoid duplicating.

## Verification (§C) — on build
- Renderer parses a well-formed envelope into the expected structured DOM (importance classes, refs
  navigate); a malformed/absent envelope falls back to plain prose with no loss (must-FAIL: prose hidden).
- Format doc: default present, per-project override respected, disable flag suppresses parsing.
- Anti-regress: transcript render suites, verify:ui, typecheck, leak-gate.
- Risk bucket: UI render (moderate — must never swallow content).

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
