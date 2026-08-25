# BUG-092 — cross-provider clean-room verify always returns INVALID: the run-recorder unix socket is blocked by the codex (openai) workspace-write sandbox

- **Status:** FIXED (self-verified; HIGH-STAKES — independent clean-room verify warranted)
- **Area:** scripts/independent-verify.mjs (recorder socket placement) + the openai dispatch sandbox
- **Reported:** 2026-08-14 (discovered running an independent-verify pass; the CROSS-PROVIDER path is the marquee ROUTING use and it silently cannot pass)

## Symptom
Running `independent-verify.mjs --provider openai` (author-provider anthropic → cross-provider,
the intended default) returns **INVALID** for every target, with the verifier reporting:
> "The recorder itself reported that its backing harness is unavailable, so that invocation produced
> no citable manifest."
No runs recorded → no `FIXER-TEST: run <id>` / `ADVERSARIAL: … run <id>` citations → the verdict
contract rejects it as INVALID. Not a code judgment — pure infra. (Confirmed twice, FEAT-076 + BUG-091,
2026-08-14.)

## Root cause (traced)
The evidence recorder is a **unix-domain socket server** (`net.createServer` / `server.listen(sockPath)`
in independent-verify.mjs ~264-288); the clean room's `vrun.mjs` is a thin client that
`net.connect(SOCK)` to it (~301). The GPT verifier is dispatched under codex **`sandbox
workspace-write`** (cwd = the clean-room dir), which permits writes to the workspace but blocks the
socket connection — the socket path is a temp dir OUTSIDE the workspace (`fs.mkdtempSync(os.tmpdir(),
'cleanroom-record-')` ~260). So `vrun.mjs` can't reach the recorder → "backing unavailable". The
anthropic verifier path is not sandboxed the same way, so it was never hit before.

## Options
1. **Place the recorder socket INSIDE the clean-room workspace dir** (the cwd the sandbox grants
   write to) instead of a separate `os.tmpdir()` dir, so the workspace-write sandbox permits the
   `connect`. Smallest change; keeps the socket design. (Verify AF_UNIX connect is allowed to a path
   under the writable workspace root, not just writes.)
2. If the sandbox blocks AF_UNIX regardless of path: fall back to a **file-based recorder** for the
   sandboxed provider (append-only record file under the workspace; the harness reads it after) — the
   provenance argument for the socket (~244-256) must be re-satisfied (the record must not be
   editable from the verifier's side, or edits must be detectable).
3. Widen the codex sandbox for verification (e.g. workspace-write + explicit socket allow, or
   `danger-full-access`) — LEAST preferred (reduces the isolation the clean room exists for).

Prefer (1); fall back to (2) only if AF_UNIX is blocked by policy not path.

## Verification (§C)
- Reproduce: `independent-verify.mjs --provider openai` against any small target → INVALID with the
  "backing harness unavailable" recorder error (must-FAIL: this is the current behaviour).
- After the fix: the same cross-provider run records ≥1 manifest and returns a WELL-FORMED verdict
  (HOLDS or BROKEN — a real judgment, not INVALID). Assert the recorder captured the run (manifest
  count ≥1) from inside the sandbox.
- Anti-regression: the anthropic (`--provider anthropic`) clean-room path still records + validates.
- **Risk bucket:** verification-tooling integrity (a broken clean-room step silently degrades every
  §C independent pass to no-signal). Moderate; correctness of the fix is checkable by the reproduce
  above.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Discovered while running the flagged independent-verify pass across FEAT-076/BUG-090/BUG-091. Root
  cause traced to the recorder unix socket living outside the codex workspace-write sandbox. Meanwhile
  retrying those verdicts via the anthropic clean-room path (not sandbox-blocked) to get a real
  signal; this ticket fixes the cross-provider path so the ROUTING-preferred decorrelated verify works.

### 2026-08-14 — worker (recorder transport fix)
**Empirical finding (Option 1 REFUTED, then falls to Option 2).** Ran `codex exec
--sandbox workspace-write` (real codex 0.147.0) with a node client connecting to
a unix socket. AF_UNIX `connect()` returns **EPERM even when the socket path is
INSIDE the writable workspace** (`sandbox: workspace-write [workdir, /tmp,
$TMPDIR]` — the path is writable, the connect is still refused). Both an
in-workspace and an out-of-workspace socket failed identically → this is a
**seccomp** block on the syscall, not a Landlock path block. So placing the
socket inside the workspace (the ticket's preferred Option 1) does NOT work.

**Fix (Option 2 — file spool, provenance preserved).** Replaced the unix-socket
recorder in `buildCleanroom()` with an in-workspace FILE SPOOL: the verifier's
`vrun.mjs` drops `{cmd}` into `.vrun/req/<nonce>.json` (workspace-write grants
that write, proven), the harness (outside the sandbox) executes the command
ITSELF and publishes the result to `.vrun/res/<nonce>.json` (atomic tmp+rename).
Execution is now async-spawn + a `.vrun/alive` heartbeat so a long command keeps
the recorder visibly alive and a dead recorder is detected fast (vrun exits 2,
never hangs, never forges around it).
- Provenance UNCHANGED: authority was never the transport, it is the harness's
  in-memory `entries`. The spool is verifier-writable, but a forged `.res` /
  hand-written `manifest.jsonl` names an id the harness never recorded, so
  `composeVerdict`/`manifestCheck` reject it as "a run that did not happen" —
  tampering is DETECTABLE, never silent. Residual identical to before (a real
  command can print desired text, bound into `RAN:`, visible on the verdict).

**Fix map:** `scripts/independent-verify.mjs` — dropped `node:net`; recorder is
now `reqDir/resDir` spool + `record()`/`handleRequest()` (async spawn) + heartbeat;
`room.server` → `room.recorder`; `--print-prompt` closes the recorder so a kept
room reports dead at once. `vrun.mjs` rewritten as a file-spool + liveness client.

**Proved:**
- REAL codex `workspace-write` dispatch records a run through the spool end-to-end
  (harness in-memory manifest holds the run; `codex exit=0`). Codified as
  `scripts/verify-bug-092-sandbox-recorder.mjs` leg (D), opt-in via
  `CLAUDE_STATION_VERIFY_CODEX=1` (ran green: 8/8).
- Default (no-provider) proof, always-on: `verify-bug-092-sandbox-recorder.mjs`
  7/7 — vrun is a file-spool client (no socket), spool is in-workspace, a
  cwd=workspace client records + reads back the harness id, harness memory is
  authoritative, and a dead recorder → exit 2 in ~23ms.
- Anti-regression: the anthropic clean-room path records + validates end-to-end
  through the new transport — `verify-independent-verification.mjs` 138/138 PASS
  (real recorded runs composed: e.g. `MANIFEST: c8246088022e … exit=0`); the
  3609cf7c on-disk-forgery ratchet still rules INVALID ("never recorded").
- `npm run typecheck` exit 0; leak-gate PASS.

**Could NOT test:** did not re-run a full cross-provider `--provider openai`
verdict against a real target end-to-end (would burn a full dispatch on a real
ticket); leg (D) proves the load-bearing hop (a sandboxed codex process records
through the spool), which was the exact failure. Independent clean-room verify
of this change is warranted (HIGH-STAKES: verification tooling).
