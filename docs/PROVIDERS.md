# Providers

Orchard runs agent sessions through pluggable runtimes (FEAT-037). Each provider bills to
its own **subscription** — Orchard never holds API keys, for any provider.

Each runtime declares an honest `capabilities` descriptor; the UI grays out what a runtime
cannot do instead of faking parity. (Sources for the Codex facts below: the FEAT-037 P2
research appendix, 2026-08-05, citing github.com/openai/codex and the official Codex docs;
wire shapes re-validated in P2c against the real binary's generated schema — codex-cli
0.146.0, `codex app-server generate-json-schema` — plus a live subscription session.)

## Claude (Anthropic) — default

- Install: `npm install -g @anthropic-ai/claude-code` (or the official installer).
- Connect: run `claude` once and sign in (Claude Pro/Max subscription). Credentials:
  `~/.claude/.credentials.json`.
- Detected when: the `claude` binary is on PATH and credentials exist.
- Capabilities: full — approvals, permission modes (incl. plan mode), per-turn USD cost
  (budget guardrail), model list, subagent panel, persisted transcript
  (detach/reattach/fork), reasoning effort.

## OpenAI Codex

- Requires a ChatGPT plan with Codex access: **Plus ($20/mo minimum)**, Pro, Business,
  Edu or Enterprise. **Free/Go plans do not include CLI access.**
- Install ONE of (official channels only):
  - `npm install -g @openai/codex`
  - `brew install --cask codex`
  - `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
- Connect the subscription: `codex login` (opens your browser; pick **"Sign in with
  ChatGPT"**). On a headless machine: `codex login --device-auth`. Do **NOT** use an API
  key (`codex login --with-api-key` / `CODEX_API_KEY`) — that silently switches billing
  from your subscription to pay-per-token API pricing.
- Credentials land in `~/.codex/auth.json` (or the OS keyring, per
  `cli_auth_credentials_store`). Treat it like a password; it auto-refreshes during use.
- Verify by hand: `codex login status`, then `codex` in any repo for a smoke turn.

### How Orchard detects it

`detectCodex()` (src/server/runtime/codex-runtime.ts), shaped for the runtime picker:

| State | Verdict shown |
|---|---|
| `codex` binary found **and** `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) exists | **connected** — runtime selectable |
| binary found, no `auth.json` | **installed, not signed in** — hint: run `codex login` ("Sign in with ChatGPT") |
| no binary | **not installed** — hint: install via the channels above |

The binary scan is **PATH plus well-known install dirs** — `~/.local/bin`,
`~/.npm-global/bin`, `~/bin`, `/usr/local/bin`, `/opt/homebrew/bin` — because a
systemd-launched Orchard inherits a minimal PATH that typically misses user installs
(observed live: `~/.local/bin/codex` works in the terminal but is invisible to the
service PATH). Launching resolves a bare `codex` through the same scan, so the picker
and the spawn can never disagree.

Keyring caveat: credentials stored in the OS keyring instead of `auth.json` are reported
as "not signed in" by the file check; `codex login status` is the authoritative answer.

### What's grayed out for Codex sessions, and why

The runtime speaks Codex's official `codex app-server` JSON-RPC interface — a real peer
to the Claude path (streaming, interrupts, resume/fork, **live approval prompts** for
commands and file changes). But some Orchard features honestly don't apply:

- **Cost budget (`maxBudgetUsd`)** — subscription usage is reported in **tokens**, never
  dollars; there is no per-turn USD figure to enforce a cap against
  (`structuredCost:false`).
- **Subagent / live-agent panel — WORKS since 2026-08-06** (`subagents:true`; the earlier
  "no subagent event stream" verdict was wrong for current codex-cli): Codex 0.145+ has
  native multi-agent, **enabled by default** (`codex features list` → `multi_agent stable
  true`; `multi_agent_v2` is a separate opt-in). The runtime maps the app-server collab
  wire (`subAgentActivity` items, `collabAgentToolCall` spawn/sendInput/resumeAgent/wait/
  closeAgent, sub-thread `thread/started` with `SubAgentSource.thread_spawn`) into the
  same task-frame dialect the agents panel already speaks, keyed by the sub-agent's
  thread id; nested (depth>1) agents are flattened into the panel with the parent noted
  in the description, not a tree UI. Agents always SETTLE (BUG-030 invariant): explicit
  terminals when the wire provides them, the turn boundary otherwise; an interrupted
  agent settles as killed/cut. Live-verified 2026-08-06 (real subscription, real
  dashboard): a spawned subagent rendered as a running agent row and settled completed
  (`docs/bugs/assets/FEAT-037-subagents-live-*.png`). **Token-multiplication caveat:**
  every subagent is its own thread burning your same subscription window — spawning N
  agents multiplies token consumption roughly N-fold, and Orchard can only show tokens,
  not dollars, so use delegation-heavy prompts deliberately.
- **Plan mode** — Codex has no plan mode; selecting it is refused with an explicit error
  rather than silently running a normal turn. Other permission modes are mapped
  (default/acceptEdits/bypassPermissions → Codex approval-policy × sandbox-mode) and
  apply from the **next turn**, not mid-turn.
- **Transcript history + reopen/resume — WORKS since P2b** (2026-08-05): the bridge
  writes an Orchard-owned transcript for engines that don't persist one in our shape
  (`dataDir()/transcripts/openai/<encodedDir>/<threadId>.jsonl`, Claude-store entry
  shapes), so Codex sessions appear in the sidebar (quiet `codex` tag), their history
  renders through the same transcript routes, and reopening resumes the same thread via
  `thread/resume` — live-verified with memory across a full close/reopen. Two honest
  remainders: **UI fork** is refused for Codex sessions (the fork's new thread would
  need its transcript seeded with ancestor history — follow-up), and **restart
  survival** (FEAT-015) stays off — the transcript recorder lives in the server
  process, so a CLI surviving a server restart would produce turns nobody records.
  Search and rename/tag/delete still cover the Claude store only.
- **Approval with amended input** — Codex approvals are approve/deny only; an approval
  that edits the tool input cannot round-trip the edit (a deny's message DOES round-trip
  as the rejection text).

Live-verified (P2c, 2026-08-05, real ChatGPT subscription): session start + streamed
turn, mid-turn interrupt, model list, `thread/resume` continuation with memory of the
earlier turn, a command-approval round-trip (`untrusted` policy → approval card → allow →
command ran), and provider-error attribution (bogus model → 400 relayed verbatim as an
'openai · model-unavailable' error card). Note Codex's own sandbox stays in force after
an approval: an allowed `curl` still failed DNS inside the network-restricted
workspace-write sandbox — approval ≠ sandbox escape.

### Limits caveat

Usage is metered by your ChatGPT plan in **rolling 5-hour windows** (message-count ranges
vary by plan and model; Plus is the $20 floor, Pro tiers scale it). Orchard surfaces
Codex's per-turn token usage but cannot show a dollar cost, and cannot predict when a
window will throttle you.
