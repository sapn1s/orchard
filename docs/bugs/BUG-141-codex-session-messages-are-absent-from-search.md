```orchard-ticket
{
  "id": "BUG-141",
  "type": "bug",
  "title": "Codex session messages are absent from search",
  "summary": "Sessions created in native Codex appear by title but their message bodies never appear in search. Search now consumes the same enumerated session files as the list and translates rollout records through the import schema.",
  "impact_if_we_wait": "People cannot retrieve native Codex conversations by what was said, despite seeing those sessions in Orchard. Claude sessions and title search remain available.",
  "current_need": "none — verified in the real UI; an independent clean-room pass is optional hardening",
  "severity": "high",
  "area": "session content search",
  "reported": "2026-08-24",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-24",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Body-only terms in two native Codex rollouts appear in all-project search.",
    "Codex search hits use the list identity and click to the exact rendered message.",
    "Single-project scope and tool-output visibility work for Codex hits.",
    "Claude content search remains intact.",
    "Partial native rollout reads do not crash or discard complete preceding lines."
  ],
  "code_refs": [
    {
      "path": "src/server/search.ts",
      "note": "rollout judging, target identity, and canonical locate"
    },
    {
      "path": "src/server/index.ts",
      "note": "search targets derived from enumerated sessions"
    },
    {
      "path": "src/server/codex-native.ts",
      "note": "shared rollout-to-transcript translation"
    },
    {
      "path": "scripts/verify-bug-141.mjs",
      "note": "real-store, partial-read, API, and browser verifier"
    }
  ],
  "related": [
    {
      "id": "FEAT-103",
      "relation": "see_also"
    },
    {
      "id": "FEAT-078",
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

# Codex session messages are absent from search

## Diagnosis

The session list merges Claude transcripts, Orchard-owned transcripts, and native Codex rollouts. Content search instead constructed paths only beneath the Claude store. Native Codex rows therefore remained searchable by title but their rollout bodies were never passed to ripgrep. A rollout uses response_item payloads rather than Claude user/assistant entries, so Claude's judge would discard every raw match.

## Evidence

Regressed-from: FEAT-103.

The user's native session is listed from the Codex date tree with its cwd-derived encoded directory and thread id. Running the rollout judge against the real August 11 file keeps six lines carrying the reported term: two user/assistant prose and four tool lines. The independent body needle 36a13956-58c2-445c-b16c-6d215f1a8ab5 is kept as prose in that same real rollout.

Defect 2 is a phantom. The failed search was pasted into the Claude session at 2026-08-24T19:02:31.184Z; every occurrence of the reported term in that file is the report itself or later diagnosis/tool output. The term did not predate the failed search.

The raw-match cap remains a possible common-term limitation, but no starvation case was established for this distinctive-term defect.

## Implementation notes

Search targets are derived directly from sessionsForProject rows and retain each row's file path, encoded directory, session id, format, and owning project. Native rollout judging reuses the exact translator used by import/open. Locate counts those translated entries with transcript.ts countable(), matching the transcript created on click. Root-level Codex history is excluded deliberately because listNativeCodexSessions never enumerates it as a session.

## Verification plan

Run the dedicated verifier on the two real read-only stores, then the existing search, FEAT-103, and native-Codex suites. Use an isolated ephemeral-port server with scratch data and Brave-CDP; inspect screenshots for the result and landing. Run the unpiped gate before a selective local commit.

## Risks

Native rollouts are concurrently appended. Search and locate parse line-by-line and ignore a malformed final partial line; the verifier truncates a real rollout at three points including mid-line.

## Activity log

### 2026-08-24 — worker
- **implementation:** Search now consumes the exact file-bearing rows returned by the session lister, including native Codex and Orchard-owned transcripts. Native matches reuse import translation, carry the list's deep-link identity, and locate in the imported transcript's canonical index space. Defect 2 was confirmed phantom from timestamps. Real store writes were never attempted.

### 2026-08-24 — worker
- **verification:** 2026-08-24 verification in the managed worker sandbox: the real-store BUG-141 verifier passed 5 checks before infrastructure stopped it: the independent Codex body needle produced correct list identity, locate was exact, and three truncations of the real rollout (20%, 60%, and 17 bytes before EOF, including partial final lines) remained searchable. The required server/browser phase could not start because localhost listen returned EPERM; the user's scratch dir was also read-only, so the partial copies used the repository's ignored scratch directory. Existing verify:search and verify:feat-103 were blocked by the same listen/scratch restrictions. verify:feat-078-native-codex passed its first 19 checks, including list scope, schema translation, import identity, and resume resolution, then its server phase hit listen EPERM. Typecheck passes. Raw ripgrep over both real read-only stores (1.7 GiB Claude + 186 MiB Codex, 4,809 jsonl files) measured 59 ms first run and 55, 56, 67 ms warm. No screenshot could be produced here.

### 2026-08-24 — worker
- **blocker:** Final worker status: dedicated verifier now proves both required real Codex examples before the browser boundary: the reported term yields three prose and three tool hits in the August 11 rollout; an independent second term yields three prose and three tool hits in the August 24 rollout. Together with identity, exact locate, and three partial-read cases, 7 checks pass and the suite then fails honestly on localhost listen EPERM. npm run gate was run unpiped and exited 1: check-nul and typecheck PASS, leak-gate cannot spawnSync git under this sandbox (EPERM despite git returning status/output). Per the gate's explicit “Do NOT commit” result, no files were staged and no commit was made. Symptom of a deeper design flaw? no — the lister/search source-of-truth split is removed by deriving search targets from listed session rows.

### 2026-08-24 — parent
- **verification:** Independent real-browser verification (parent lane, outside the worker sandbox). MUST-FAIL first: pre-fix server run from a detached worktree at a4aad56 — the reported term, all-projects, scanned 3 files, ZERO codex hits; rendered UI showed '4 in message contents', all from the phantom Claude orchestrator session, while the two rollouts holding 11+2 lines of it stayed invisible. That is the user's exact symptom. POST-FIX, real stores, brave-CDP headless: the reported term, tools-shown, returns 29 message hits across 4 sessions including the user's August 11 rollout (3 prose + 3 tool) and the Aug-24 one; tools-hidden shows the prose body line; clicking a codex result lands on the exact matching assistant message, not a wrong offset. A second independent codex-only needle chosen by the verifier (a different term, from different rollouts than the implementer's) returns correctly. Claude-store path not regressed: a claude-only needle returns its session and clicks through. history.jsonl produced no phantom session row. High-frequency term (3385 files) caps at 300 hits, truncated:true, 156 ms, and the UI says 'more exist - refine the query' honestly. Anti-regressions: verify:bug-141 13/13, verify:search 12/12, verify:feat-078-native-codex 36/36 (its 'real stores untouched' byte manifest also confirms read-only compliance). verify:feat-103 is 7 pass / 1 fail and the failure is NOT this change: its hardcoded needle 'Project Glasswing' has leaked into the live corpus (3 codex rollouts + 3 orchard subagents), so newer real sessions now correctly outrank its stale fixture SID — fixture contamination, not a product regression; that verifier needs a fresh unique needle. Leak-gate scrub before commit: verify-bug-141.mjs now derives the encoded dir from os.homedir() instead of hardcoding it. Risk bucket: regression-prone (session-content search + deep-link locate) — an independent clean-room pass is warranted.

### 2026-08-25 — privacy scrub (FEAT-049)
- **verification:** Sanctioned privacy scrub, not a narrative edit. This ticket and scripts/verify-bug-141.mjs carried a real client's name, a real product line and a German trade term lifted verbatim out of two of the user's Codex rollouts, plus those rollouts' absolute paths and session ids. None of it was a leak-gate token, so every gate run this week passed over it; it was found by enumerating what actually exists on this machine rather than by recalling a name. Prose now names the terms by role ('the reported term'), which preserves every count and claim. The verifier no longer names any file or word: it DISCOVERS two real rollouts under BUG141_CODEX_ROOT (default ~/.codex/sessions, largest-first) and DERIVES each needle by asking the product's own judge for a rare word it calls prose, so the suite keeps its real-artifact property and carries nobody's content; with fewer than two rollouts it skips loudly. All four terms are now leak-gate tokens (split-string, so the gate does not trip on its own list) and the class cannot come back silently.
