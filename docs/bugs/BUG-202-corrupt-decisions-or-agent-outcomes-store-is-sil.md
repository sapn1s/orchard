```orchard-ticket
{
  "id": "BUG-202",
  "type": "bug",
  "title": "Corrupt decisions or agent-outcomes store is silently wiped on the next write",
  "summary": "The raised-decisions store (Needs-You rail cards) and the agent-outcomes ledger are each one shared JSON file mutated read-all/write-all, and the read treats a present-but-unreadable file like an absent one. So if either is torn or corrupted, the next appended record overwrites it as if empty and every prior record is silently lost. Same shape FEAT-126 fixed in requests.ts.",
  "impact_if_we_wait": "One corrupt store file (torn write, disk error, hand-edit) silently erases every decision card or death record the moment the next one is written, with no error. Bounded: it takes an already-unreadable file to trigger, and the concurrent variant is unreachable (one serialized writer).",
  "current_need": "Fixed in this lane; needs an independent clean-room verify (data-loss class) before VERIFIED.",
  "severity": "medium",
  "area": "server (src/server/decisions.ts, src/server/outcomes.ts)",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "node scripts/verify-bug-202-store-dataloss.mjs exits 0 (11/11), and its two DATA-LOSS legs FAIL against the pre-fix code",
    "A present-but-unreadable decisions.json / agent-outcomes.json is preserved (quarantined), never overwritten as if empty",
    "Existing valid stores read byte-identically and are never quarantined (real-file compat)"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-126",
      "relation": "see_also"
    },
    {
      "id": "ARCH-010",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ccde50b4-34c6-4152-bdf5-d703f9b80475",
      "verdict": "holds",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T10:54:50.681Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "clean-room independent-verify --working-tree; same-provider fallback, a second anthropic account (not the fixer's); openai window exhausted"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
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

# BUG-202 — Corrupt decisions or agent-outcomes store is silently wiped on the next write

## Symptom

Two server-owned JSON stores — the raised-decisions store (`decisions.json`,
the Needs-You rail's runtime cards) and the agent-outcomes store
(`agent-outcomes.json`, the "what died and why" ledger) — can be SILENTLY WIPED
of every prior record. If either file is ever present but unreadable (torn,
partially written, externally corrupted, or hand-edited to invalid JSON), the
next record that gets appended overwrites the file as if it had been empty, and
every decision card / death record already in it is destroyed with no error and
no trace.

This is the same read-all/write-all-one-shared-file defect FEAT-126's round-1
independent verify found in `requests.ts` and fixed there; that fixer flagged
these two stores in the `requests.ts` header as carrying the same latent shape.

## Repro

`node scripts/verify-bug-202-store-dataloss.mjs` reproduces it against the REAL
`src/server/decisions.ts` and `src/server/outcomes.ts` over a scratch data dir:

1. seed 3 records (raise 3 decisions / record 3 deaths) — store holds 3;
2. truncate the store file mid-record (a present-but-unreadable state);
3. append one more record (`decisions.raise` / `outcomes.record`).

Against the pre-fix code the store now contains ONLY the one new record — the
3 prior records are gone and nothing was preserved (the two DATA-LOSS legs FAIL).

## Expected

The invariant, one testable sentence: **a write for key K can never remove or
overwrite another key's data, and an unreadable store is never overwritten as if
empty.** A write that lands on a present-but-unreadable store must preserve the
existing bytes, not destroy them.

## Per-store verdict (what was reproduced, what is real)

Both stores share the identical shape: one shared JSON file, `readAll()` returns
`[]` for BOTH "no file yet" (ENOENT) AND "present but unreadable" (torn/corrupt),
and the unconditional-append writers (`decisions.raise`, `outcomes.record`) then
write over that `[]`.

- **Torn-read wipe (the real, always-present defect): VULNERABLE — both
  stores.** Reproduced (must-FAIL) and fixed. Does not depend on process count:
  any externally-corrupted store file is silently wiped on the next append.

- **Concurrent-writer lost update (the other half of the hypothesis): the shape
  is present but NOT REACHABLE — both stores.** A multi-process repro
  (`/tmp/repro-bug202-concurrent.mjs`) shows the read-all/write-all shape loses
  99/120 records when six OS processes write one store at once. BUT in this
  product there is exactly ONE writer of each store and it is serialized:

  - every caller (`src/server/index.ts`, `agent-bridge.ts`, `survival.ts`, and
    `dispatch-broker.ts`'s in-process `recordOutcome`) runs inside the single
    station server process;
  - the detached `session-host.mjs` broker and the spawned `dispatch.mjs` child
    do NOT import or write either store (only the server records outcomes/
    decisions from frames it receives);
  - every write function is fully synchronous — `readAll` → mutate → `writeAll`
    with no `await` between — so within the one process the operations cannot
    interleave and no stale read is possible.

  So the concurrent lost-update is not reachable, and the structural change
  `requests.ts` took for it (per-session files) is not applied here — see the
  Activity log for why, and the handoff for the one condition that would change
  this verdict.

## Context pack
- Files in play: `src/server/decisions.ts` (`readAll`, `raise`, `resolve`),
  `src/server/outcomes.ts` (`readAll`, `record`, and the mutating writers
  `attachProviderError` / `dismiss` / `takeBriefing`), `src/lib/paths.ts`
  (`writeAtomic`, already present — the atomic-write half was never the gap).
- Related: FEAT-126 (fixed the same shape in `requests.ts`; its header flags
  these two), ARCH-010 / docs/CONVENTIONS.md (fact declared once by its owner).
- Repro test: `node scripts/verify-bug-202-store-dataloss.mjs`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — filed + fixed in one lane (fixing, round 1, class=fix) — Opus 4.8

- **Understood.** FEAT-126's round-3 fixer flagged `decisions.ts` and
  `outcomes.ts` as carrying the `requests.ts` read-all/write-all-one-shared-file
  shape, with two failure modes: (a) concurrent-writer lost update and (b) a
  torn/unreadable read treated as empty, then overwritten. Verified the
  hypothesis per store before changing anything.

- **Reproduced FIRST (must-FAIL), against the current tree.** A REAL-module
  suite (`scripts/verify-bug-202-store-dataloss.mjs`) drives the real
  `decisions.ts` / `outcomes.ts` over a scratch data dir: seed 3 records, cut the
  file mid-record, append one. Pre-fix, both stores end holding ONLY the new
  record (the 3 priors destroyed, no bytes preserved) — the two DATA-LOSS legs
  FAIL. Non-vacuity is anchored to a FIXED baseline (not HEAD): the suite also
  runs a self-contained PRE-FIX SIMULATION of the old readAll/writeAll semantics
  and shows it wipes. Multi-process repro (`/tmp/repro-bug202-concurrent.mjs`):
  six OS processes writing one `agent-outcomes` store lost 99/120 records — the
  lost-update shape is real IF multiple writer processes exist.

- **Per-store verdict.**
  - **Torn-read wipe — BOTH VULNERABLE; fixed.** Real regardless of process
    count (external corruption is enough).
  - **Concurrent lost update — shape present, NOT REACHABLE; left as-is (proven,
    not fixed).** Every writer of each store runs in the ONE station server
    process (`index.ts`, `agent-bridge.ts`, `survival.ts`, and
    `dispatch-broker.ts`'s in-process `recordOutcome`); the detached
    `session-host.mjs` broker and the spawned `dispatch.mjs` child do NOT write
    either store; and every write fn is fully synchronous (`readAll`, mutate,
    `writeAll`, with no `await` between), so operations cannot interleave and no
    stale read is possible. This is the charter's "only ever written by one
    serialized writer" case, so the per-session-file restructure `requests.ts`
    took for concurrency is deliberately NOT applied here (it would also force a
    migration of the live 139 KB `agent-outcomes.json`, which
    ARCH-010/CONVENTIONS cautions against). See handoff for the one condition
    that flips this.

- **Invariant (one testable sentence).** A write for key K can never remove or
  overwrite another key's data, and an unreadable store is never overwritten as
  if empty.

- **Fix (confined to the two stores; public API unchanged).** In each of
  `decisions.ts` and `outcomes.ts`: a new `readStore()` returns `{records, ok}`,
  distinguishing ENOENT (`ok:true` — genuinely empty, safe to create) from
  present-but-unreadable (`ok:false` — torn/corrupt/wrong-shape). `readAll()`
  now delegates to it (read-side callers and the mutating writers degrade to `[]`
  exactly as before — and those writers, `resolve`/`attachProviderError`/
  `dismiss`/`takeBriefing`, are clobber-safe by construction because they
  `writeAll` only after matching a record). The unconditional-append writers
  (`decisions.raise`, `outcomes.record`) now, when the store is `!ok`, PRESERVE
  its bytes via `quarantineCorruptStore()` (atomic rename to
  `<file>.corrupt-<ts>`) before writing a fresh file — so the store self-heals
  and the corrupt bytes survive on disk for recovery, never "overwritten as if
  empty". Chose quarantine-then-continue over FEAT-126's refuse-and-block because
  decisions/outcomes do NOT re-emit the way requests do, so refusing forever
  would silently drop every new card/death. Atomic write (`writeAtomic`,
  temp+fsync+rename) was already present in `paths.ts` — that half was never the
  gap.

- **Migration.** None. The fix keeps the single-file on-disk layout, so the live
  real stores (`decisions.json` len 1, `agent-outcomes.json` len 200) read
  byte-identically and are never quarantined. Proven on a /tmp COPY of the real
  data dir (the real dir was never modified): `real-file compat` leg PASS
  (decisions=1, outcomes=200, list=200, 0 quarantines). The 4 verify scripts that
  poke the raw store files (`verify-bug-070-outcomes-rail`, `verify-feat-118-marks`,
  `verify-arch-016`, `verify-runtime-decision`) keep working — the shape is
  unchanged.

- **Verified.** `node scripts/verify-bug-202-store-dataloss.mjs` gives 11/11 PASS
  post-fix; the two DATA-LOSS legs FAIL against the pre-fix tree (captured by
  restoring `git show HEAD:` versions of both files, re-running, then restoring
  the fix). Anti-regression (ran against the fix, then confirmed IDENTICAL
  results against the pre-fix `HEAD` versions, so the residual failures are
  pre-existing and NOT caused by this change): `verify-arch-016` 38/0,
  `verify-decision-shape` 25/25; `verify-feat-118-marks` 13/17,
  `verify-bug-184-ledger-truthful-outcome` 27/1, `verify-runtime-decision` 5/2 —
  the failing legs in the last three are browser/DOM-render legs, identical
  before and after, unrelated to the store change (a valid store reads
  byte-identically under the fix). `npm run gate` gives PASS (exit 0; leak-gate,
  check-nul, typecheck). `npm run board:check` run below.

- **regressed-from:** none — this is the latent shape FEAT-126 flagged, not a
  regression a prior fix introduced.

- **Skeptic flag / high-stakes.** DATA-LOSS class. This lane's self-authored
  suite is not the last word — an independent clean-room verify is warranted
  before VERIFIED. Suggested independent cases the fixture may not cover: (1) cut
  the REAL `agent-outcomes.json` (200 records) at several byte offsets and grade
  each — a torn read of the real artifact, not a synthetic one; (2) confirm
  `quarantineCorruptStore` preserves bytes when the parse fails on a
  valid-JSON-but-wrong-shape file (object, not array); (3) re-establish, or
  refute, the single-serialized-writer claim — if ANY second process ever writes
  these stores (e.g. a future container-hosted or out-of-process recorder), the
  concurrent lost-update becomes reachable and per-key files would be required.

- **Left unstaged for the user (no git writes):** `src/server/decisions.ts`,
  `src/server/outcomes.ts`, `scripts/verify-bug-202-store-dataloss.mjs`, and this
  ticket (`docs/bugs/BUG-202-*.md` + the `INDEX.md` row the board tool placed).
  NOT marked VERIFIED.

- **Symptom of a deeper design flaw?** yes (already tracked) — the
  shared-single-file read-all/write-all store pattern is the recurring shape
  FEAT-126 named for arch-watch; this ticket closes the two instances it flagged
  for the reachable (torn-read) half. Not filing a new ARCH: FEAT-126 already
  carries the structural note.

### 2026-09-30 — round 6 (fixing, class=fix) — quarantine/read defects consolidated into a shared helper (FEAT-126 + BUG-202)

The FEAT-126 round-6 independent verify (run 8e8e3761) found three defects in the
requests-store quarantine/read path; the SAME code shape lived here in
`decisions.ts`/`outcomes.ts`, so per ARCH-010 the fix is made ONCE and all three
stores route through it. New owner: `src/server/store-io.ts`.

- **The three defects (present in all three stores' private copies):**
  1. quarantine renamed onto `<file>.corrupt-<timestamp>` with no existence check
     → a same-named earlier quarantine was silently OVERWRITTEN;
  2. two quarantines in the same millisecond collided → the FIRST preserved bytes
     were destroyed;
  3. the read was stat-then-unbounded (`decisions`/`outcomes` had NO cap at all;
     requests had a `statSync`-gated cap) → a file over the cap, or one that grew
     between the stat and the read, was read in full (no OOM/stall protection).
- **The fix (`src/server/store-io.ts`, ARCH-010 single owner).**
  `quarantine(file, label)` reserves a unique name atomically with `O_EXCL`
  (`Date.now()`+random, retry on the astronomically-rare collision) then moves the
  bytes onto it — never overwriting any existing quarantine, even in the same
  millisecond or from a concurrent process. `readCapped(file, max)` reads bounded
  by the fd (at most `max+1` bytes), with no separate `stat`, so there is no
  stat→read window and an over-cap file is reported `toobig` rather than read.
  `decisions.ts` and `outcomes.ts` now `import { quarantine, readCapped }` from it,
  gained a `MAX_STORE_BYTES = 16 MB` cap, and their private
  `quarantineCorruptStore` / raw `readFileSync` were DELETED (the now-unused `fs`
  import removed too). `requests.ts` routed through the same helper (4 MB cap).
- **Verified.** `scripts/verify-store-io.mjs` NEW — 7/7, must-FAIL via inline
  pre-fix simulations for each defect (old ISO-rename collides / same-ms collapses;
  old stat-then-read reads a file grown past the cap) and PASS on the helper.
  `scripts/verify-bug-202-store-dataloss.mjs` 15/15 (11 prior + 4 new: decisions &
  outcomes each — two same-ms corrupt events preserve BOTH quarantines; an
  oversized VALID-JSON store is refused fd-bounded, quarantined, self-heals).
  MUST-FAIL proven by swapping `store-io.ts` for a pre-round-6 baseline
  (`Date.now`-only quarantine name + unbounded read): the 4 new BUG-202 tests and
  the 2 new FEAT-126 tests all redden; restoring the helper → all green. FEAT-126
  store suite 41/41; anti-regression `verify-feat-153-board-grid` 35/35; `tsc` 0;
  `npm run gate` PASS.
- **Skeptic flag / high-stakes.** Data-loss; a shared helper now under all three
  stores. Independent clean-room re-verify warranted before VERIFIED.
- **Left unstaged (no git writes):** `src/server/store-io.ts` (new),
  `src/server/decisions.ts`, `src/server/outcomes.ts`,
  `scripts/verify-bug-202-store-dataloss.mjs`, `scripts/verify-store-io.mjs` (new),
  and this ticket. NOT marked VERIFIED.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run ccde50b4-34c6-4152-bdf5-d703f9b80475 — VERDICT: HOLDS — clean-room independent-verify --working-tree; same-provider fallback, a second anthropic account (not the fixer's); openai window exhausted. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — clean-room independent verify (round 6, verifying) — VERDICT: HOLDS (VALID) → VERIFIED

Verified the UNCOMMITTED round-6 fix TOGETHER with FEAT-126 (they share the new
`src/server/store-io.ts`) via `scripts/independent-verify.mjs --working-tree`.
Requirement framed as confirming a software fix is data-safe
(`/tmp/req-FEAT-126-BUG-202.txt`): the quarantine O_EXCL name reservation (no
empty reserved file left behind on a failed move; cross-process same-ms races
preserve BOTH sets of bytes under distinct names); `readCapped` at exactly the
cap and at cap+1 (boundary); a realistic store SHRINKING/TRUNCATING mid-read
(truncate at several offsets); and that all three stores (requests, decisions,
outcomes) TRULY route through `store-io.ts` with no private read/rename copy.

- **Command (exact):** `CLAUDE_CONFIG_DIR=<a second anthropic account, not the
  fixer's> node scripts/independent-verify.mjs --repo ~/projects/orchard
  --working-tree --requirement @/tmp/req-FEAT-126-BUG-202.txt --run "node
  scripts/verify-store-io.mjs && node scripts/verify-feat-126-requests-store.mjs
  && node scripts/verify-bug-202-store-dataloss.mjs" --test-file
  scripts/verify-store-io.mjs --test-file scripts/verify-feat-126-requests-store.mjs
  --test-file scripts/verify-bug-202-store-dataloss.mjs --provider anthropic
  --timeout-min 22 --verdict-out /tmp/verdict-FEAT-126-BUG-202.txt`. Exit 0
  (HOLDS, contract VALID).
- **Fixer suites re-run (HOLD):** `verify-store-io.mjs` 7/7, FEAT-126 store suite
  41/41, `verify-bug-202-store-dataloss.mjs` 15/15 (manifest cfedf63ead7c, exit 0).
- **Adversarial cases, all held (cases the fixtures do not cover):**
  quarantine failure-cleanup + O_EXCL boundary (a source that vanishes before the
  rename returns null, no stray 0-byte placeholder; a `rename` that throws — EXDEV
  injected — makes raise/record/upsert throw and leaves the corrupt bytes
  UNTOUCHED, never overwritten); a realistic decisions/outcomes store truncated at
  60 offsets → every cut quarantined byte-exact or (only a full read) all records
  kept, no partial records admitted; `readCapped` boundary — a file of exactly
  4 MiB kept, 4 MiB+1 quarantined with bytes intact; and the routing check — each
  of requests/decisions/outcomes imports `quarantine`/`readCapped` from
  `./store-io.ts` and has NO private `readFileSync`/`statSync`/`renameSync`/
  `openSync`/`.corrupt-<timestamp>` line.
- **Verifier UNTESTED (honest, recorded):** an 8-process concurrent `raise()` on
  ONE shared `decisions.json` lost ~207/240 records per round — the verifier did
  NOT count this as a finding (it is the shared-single-file lost-update shape, and
  it noted `index.ts` appears to hold a single-server lock per data dir but did not
  prove the lock stops two writers). This matches this ticket's own analysis: the
  concurrent lost-update shape is present but NOT REACHABLE in-product (one
  serialized in-process writer); the round-6 fix was never claimed to address it.
  Also untested: a real crash between O_EXCL create and rename (monkey-patched, not
  a real process kill); network/FUSE filesystems where O_EXCL/rename may not be
  atomic; the live HTTP/WS routes (direct module imports only).
- **Status:** VERIFIED. All three success criteria confirmed by an independent
  clean-room: the quarantine preserves bytes collision-safe, the capped read is
  fd-bounded at the boundary, a present-but-unreadable store is quarantined (never
  overwritten as if empty), and a valid store reads byte-identically and is never
  quarantined. The data-loss scope of this ticket is fully covered by this HOLDS.
- **Verified-by:** dispatch anthropic run ccde50b4-34c6-4152-bdf5-d703f9b80475
  (clean-room, `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: HOLDS
  (contract VALID). Same-provider fallback, a second anthropic account (different
  from the fixer's); openai window exhausted — decorrelation reduced
  (author-provider anthropic), noted per VERIFY.md #5. (Proof is the typed entry in
  the record's `verification[]`; this line is a pointer, not the proof.)
