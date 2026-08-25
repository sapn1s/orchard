# FEAT-041 — WA hoist: canonical methodology repo + committed mirror (FEAT-039 gap 2)

- **Status:** VERIFIED — canonical methodology repo + committed mirror + sync/drift script; live read-through injection proven unchanged (see 2026-08-04 agent entry).
- **Area:** methodology / cross-project sharing / build tooling
- **Reported:** 2026-08-04 (FEAT-039 gap 2; user chose "dedicated repo, whatever you recommend")

## Goal
Give the **universal** Working Agreement its own product-agnostic home so it survives the
Orchard rename / any vendor change and can be shared across projects without drift — while
keeping claude-station self-contained, portable (dual-boot), and its live WA injection
byte-for-byte unchanged.

## Design (light, per §E/§B — no premature multi-consumer machinery)
- **Canonical repo:** `~/projects/methodology` (git), seeded from claude-station's
  CURRENT WA (v1 `WORKING_AGREEMENT.md` + v2 `WORKING_AGREEMENT.v2.md` — the richer,
  already-appended copies), plus a README stating it is the cross-project source of truth.
- **Mirror:** claude-station keeps its `docs/prompts/WORKING_AGREEMENT*.md` at the SAME path
  as a committed mirror (so `templates.ts` read-through / FEAT-027 is untouched and a missing
  methodology checkout never breaks a session launch).
- **Sync:** `scripts/sync-methodology.mjs` (`npm run sync:methodology`) copies canonical →
  mirror; no-ops gracefully if the methodology repo is absent (portability). A drift check
  warns if mirror ≠ canonical. WA edits land in the canonical repo, then sync into consumers.
- **Deferred (trigger):** the full multi-consumer drift policy (external-project-A etc. pulling +
  push-back) is parked until a SECOND project actually consumes the WA.

## Verification (REQUIRED)
Prove the live WA injection is unchanged (composeInstructions still emits the full WA after
the hoist); sync copies canonical→mirror; sync no-ops (no crash) when the methodology repo is
absent; drift check flags a divergence. typecheck clean.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed to execute FEAT-039 gap 2 after the user chose the dedicated-repo option. Scoped off
  `templates.ts`/`app.js`/`index.ts` (FEAT-025 in flight) and off `package.json` (deferred to
  the orchestrator). Dispatched.

### 2026-08-04 — agent (light hoist implemented + verified)
**Understood:** `templates.ts` read-through (FEAT-027) resolves the WA body LIVE from
`docs/prompts/WORKING_AGREEMENT.md` + `.v2.md` at compose time (via `source:` +
`DEFAULT_SEED_SOURCES`). The whole raw file is the injected body (`.trim()`ed), so anything
prepended to those files becomes part of the injected prompt. To keep injection valid I must
never break those two paths' content — must NOT edit `templates.ts` (FEAT-025 holds it).

**Key design call — header must be byte-identical in mirror AND canonical.** Verification (b)
requires `mirror == canonical` byte-for-byte and the `--check` drift mode compares them
directly. A header only in the mirror would make sync (canonical→mirror) wipe it and make the
drift check always fire. So: added the banner to the mirror FIRST, then seeded canonical
VERBATIM from the (now-headered) mirror → the two are byte-identical, sync is a pure copy,
drift is a pure byte comparison, and the pointer note still ships. Simpler = more robust.

**Changed** (scope-clean — only the allowed paths):
- NEW local git repo `~/projects/methodology` (git init; commit `495fc75`): verbatim
  `WORKING_AGREEMENT.md` (v1) + `WORKING_AGREEMENT.v2.md` (v2) + a `README.md` declaring it the
  product-agnostic cross-project source of truth. This is a new, reversible local repo; no
  remote, no push.
- `docs/prompts/WORKING_AGREEMENT.md` + `.v2.md`: prepended a 4-line HTML-comment banner
  ("canonical source: ~/projects/methodology; edit there then `npm run sync:methodology`;
  everything below is byte-identical to canonical so FEAT-027 read-through is unaffected").
  Everything below the banner is byte-identical to the pre-change file.
- NEW `scripts/sync-methodology.mjs`: copies canonical (`$METHODOLOGY_DIR` default
  `~/projects/methodology/WORKING_AGREEMENT*.md`) → the two mirror paths. No-ops gracefully
  (clear message, exit 0) when the methodology dir is absent — the committed mirror is
  authoritative on its own (portability/dual-boot). `--check` mode reports drift with a
  first-differing-line diff and exits 1 (0 when in sync; 0 when repo absent). `--check` never
  writes.
- Did NOT touch `templates.ts` / `app.js` / `index.ts` / `package.json` (per scope). npm-script
  entries to add are reported to the orchestrator.

**Verified (observed values):**
- (a) `git -C ~/projects/methodology log --oneline` → `495fc75 Initial commit…`; `ls-files`
  = README.md, WORKING_AGREEMENT.md, WORKING_AGREEMENT.v2.md.
- (b) `node scripts/sync-methodology.mjs` with repo PRESENT → both files "unchanged";
  `cmp` mirror vs canonical → v1 EQUAL, v2 EQUAL; counts identical (v1 116L/6126B,
  v2 230L/13943B on both sides). Non-vacuous: appended a DIRTY line to the mirror → `--check`
  reported DRIFT (mirror 6143B vs canonical 6126B, first diff line 118) exit 1; `sync` then
  copied 1 and restored byte-equality.
- (c) repo ABSENT (temp `mv` of the dir): both `sync` and `--check` printed the "not found …
  nothing to sync" message and exited 0 (no crash). Restored; post-restore `--check` OK.
- (d) `--check` when identical → "OK — mirror == canonical (2 file(s) in sync)" exit 0; the
  1-line divergence in (b) proved it flags drift with exit 1.
- (e) MOST IMPORTANT: `npm run verify:template-readthrough` → 18/18 PASS (exit 0). Plus a
  direct `seedTemplates()`+`composeInstructions([working-agreement, working-agreement-v2])`
  probe: injected 20119 bytes; asserts TRUE for the banner AND the WA v1 short-form line, the
  WA v1 tail line ("round trips on *execution*, not on *intent*"), and the WA v2 heading →
  "FULL WA STILL INJECTS (with header) — PASS". Injection is unchanged (header is purely
  additive above the byte-identical body).
- `npm run typecheck` → exit 0, clean.

**package.json entries for the orchestrator to add** (scoped off package.json intentionally):
- `"sync:methodology": "node scripts/sync-methodology.mjs"`
- `"verify:methodology-sync": "node scripts/sync-methodology.mjs --check"`

**Status → VERIFIED.** No commit inside claude-station (working-tree changes left for the
orchestrator: the two banner-edited WA files, `scripts/sync-methodology.mjs`, this ticket).
The methodology repo's own initial commit is expected/fine. No remote touched.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
