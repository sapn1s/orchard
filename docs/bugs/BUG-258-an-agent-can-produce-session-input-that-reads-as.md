```orchard-ticket
{
  "id": "BUG-258",
  "type": "bug",
  "title": "An agent can produce session input that reads as the user's",
  "summary": "Every agent-bridge session is recorded as startedBy=user, whoever opened it, and the websocket start and send path checks only Host and Origin headers, which any non-browser client sets freely. So an agent can open or drive a session and its message lands as a user turn identical to one the user typed.",
  "impact_if_we_wait": "Anything that treats a transcript user turn or a user-provenance session as the user's own words can be fooled. FEAT-184 had to rule out transcript-sourced delegations for this reason. A future feature that trusts these records would inherit the forgery.",
  "current_need": "A fix lane: stamp who sent each session input (the caller-provenance check FEAT-164 built), and record startedBy from the real caller.",
  "severity": "medium",
  "area": "session provenance",
  "reported": "2026-10-14",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session opened through the API or websocket by an agent process is recorded as startedBy=agent, not user.",
    "Each websocket start/send records whether the caller is the user or an agent, so a relayed message is distinguishable from a typed one.",
    "A must-FAIL demo: an agent-process websocket client sending a user-shaped message is classified as agent."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-184",
      "relation": "see_also"
    },
    {
      "id": "FEAT-164",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
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

# BUG-258 — An agent can produce session input that reads as the user's

## Diagnosis

INVARIANT: input that reads as the user's (a user-provenance session, a user turn in its transcript) must have come from the user. It does not hold today.

1. `src/server/agent-bridge.ts` sets `this.#startedBy = opts.startedBy ?? 'user'` and records it at `system:init` with source `agent-bridge`. No caller passes anything else, so every bridge session is `startedBy=user`, including one an agent process opens through the server. The session-provenance store holds 108 `user|agent-bridge` records and 2891 agent `dispatch:*` records; nothing distinguishes a user-opened bridge session from an agent-opened one.
2. The websocket (`/ws`) `verifyClient` in `src/server/index.ts` checks only the Host and Origin headers (BUG-076). A non-browser client sets Origin freely. `start` and `send` on that socket then put the text into the session as a user turn.
3. `requireUserCaller` (`src/server/caller-provenance.ts`, FEAT-164) is applied to five routes only (path change, git panel, git-write grant, git policy, the git-write request answer). It is not applied to websocket start/send, session creation, or ticket answers.

## Evidence

Real transcript, user-provenance session 20ed61fc-8795-4e73-9317-798132edf77d, message 1b7500bb-348a-48db-a57c-23ede92d1327 (2026-10-13): `{type:user, promptSource:sdk, entrypoint:sdk-ts, content:"first gather data and do whatever u recc"}`. Nothing in that line or the session's provenance would differ if an agent had sent it over the websocket. User-role turns in user sessions also carry machine injections (board snapshot, [station] notes, task notifications): session 19d7373f has a launch board-snapshot user turn that contains "do whatever u recc". Found by the FEAT-184 lane (2026-10-14) while choosing a delegation source.

## Risks

The fix touches the websocket start/send path and session creation (session lifecycle), so it needs an independent verify round. A false agent classification must not block the user's own typing: FEAT-164's classifier fails closed for unknown loopback callers, which would be wrong for plain chat input. A send should be stamped, not refused.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — agent
- **Filed:** through the board tool; the record was validated before it was written.
