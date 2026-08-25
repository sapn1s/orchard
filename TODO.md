# Claude Station — TODO / handoff

Written 2026-08-03. Continues work from a long prior session.

**Read first:** `HANDOVER.md` (what exists + verified limits), and
`docs/prompts/WORKING_AGREEMENT.md` + `.v2.md` (how the user wants work done —
verification is the deliverable, reproduce-then-fix, own mistakes in one line,
lead with a recommendation, don't auto-chain unrequested work).

---

## 0. Do these first (small, outstanding, low risk)

> **Status 2026-08-03:** 0.1 DONE (local repo, `main`, no remote). 0.2 DONE
> (cleared via PATCH, verified on disk). 0.3 DONE (`gh` authed as <gh-user>).
> 0.5 DONE — hash routing shipped and verified by `npm run verify:routing`
> (11 checks in a real headless Chromium: reload/new-tab/back/bogus-id/deep
> restore with forward gap). Sidebar `#newBtn` also swapped pencil→plus with a
> destination-naming tooltip (user request).

### 0.1 `git init` claude-station — **highest value item here**
The whole app is untracked loose files. Its only protection is hourly snapper
snapshots. Local init + initial commit; **no remote, no push** (the user does
not want unfinished work pushed). Add a sensible `.gitignore`
(`node_modules/`, `.attic/`, scratch dirs).

### 0.2 Clear the stale `plan` permission mode on `Example-App`
The registry still holds `settings.permissionMode: "plan"` for that project —
residue of a since-fixed bug where the plan toggle wrote a *persistent project
default*. Every session there silently cannot edit files until cleared.
`PATCH /api/projects/Example-App {permissionMode:'default'}`. **Confirm with
the user before changing their registry.**

### 0.3 `gh auth login`
`gh` is installed but not authenticated. Interactive browser flow — the **user**
must run it (`! gh auth login`). Blocks item 3.

---

## 0.5 URL state / routing — **bug, and it compounds everything else**

**Symptom:** reloading the page drops you into a *new session*. The URL never
changes, so nothing about what's open survives a refresh — project, session,
scroll position, or which sub-agent thread you were viewing.

**Why it matters more than it looks:**
- Every UI fix requires a hard reload to pick up, so the user loses their place
  each time — this was hit repeatedly during development.
- **Search deep-links (item 4) depend on it.** "Open this session at message
  N" is not expressible without routable state.
- Back/forward, opening a session in a second tab, and bookmarking a
  conversation are all impossible today.

**Build:** reflect state in the URL and restore from it on load. Suggested shape
(hash or History API — pick one and justify):
`#/project/<projectId>/session/<sessionId>?dir=<encodedDir>&i=<messageIndex>&agent=<agentId>`

- `dir` matters: duplicate session ids exist across dual-boot dirs (26 of them),
  and the server 409s `ambiguous-dir` rather than guessing — so the URL must
  carry it.
- Restoring should land at the remembered message index using the canonical
  absolute index space, then resume normal tail behaviour.
- Update the URL on navigation **without** spamming history — replace for scroll
  and thread switches, push for opening a different session.
- A URL pointing at a deleted/missing session must fail honestly (say so, fall
  back to the project) rather than silently starting a new session — that silent
  new-session behaviour *is* the current bug.

**Acceptance:** open a session, scroll, hard-reload → same session, same place.
Copy the URL into a new tab → same view. Browser back returns to the previous
session. A bogus session id in the URL shows an honest message.

---

## 1. Agent memories viewer — **agreed, build it**

**Why:** memories are auto-loaded into every session and accumulate silently.
`-workspace-external-project-A` already has **42 memory files** shaping every
conversation there, never reviewed. `CLAUDE.md` is *what the user told Claude*;
memories are *what Claude concluded* — the second drifts and nothing surfaces it.

**Scope — deliberately small.** List, read, delete. **Not** an editor (they're
markdown files; a real editor is better). The missing capability is *seeing what
is there and pruning it*.

**Placement:** settings drawer, next to Templates. Low-frequency — must not
occupy main UI.

**Location on disk:** `~/.claude/projects/<encodedDir>/memory/*.md`, with a
`MEMORY.md` index. Note memory dirs exist for Windows-origin projects too.

**Acceptance:** list real memories for a project; open one and read it; delete
one and prove it's gone from disk; deletion backed up first (same discipline as
session delete — see `paths.ts` `backupFileTo()`); empty state honest.

---

## 2. Container OOM honesty — **agreed; a bug fix more than a feature**

**Do NOT build a resource panel.** Ambient CPU/RAM gauges are dashboard bloat.

**Do build two things:**
1. A quiet warning when a container approaches its memory limit.
2. **When a session dies from OOM, say so.** Today it surfaces as
   `exited with code 137`, which is baffling. Detect the OOM kill
   (`docker inspect` → `State.OOMKilled`) and report it in plain words with the
   limit that was hit.

**Why this user specifically:** Docker RAM pressure is why they migrated off
Windows, and they've been bitten by orphaned-exec RAM leaks before.

**Acceptance:** force an OOM in a throwaway container with a tiny `memoryMb`;
prove the UI explains it rather than showing 137.

---

## 3. Git / GitHub integration — **agreed**

**Implementation constraint (user's own reasoning, and it's right):** drive the
**`git` and `gh` CLIs already installed**. No npm SDK, no third-party GitHub MCP
server — avoids adding a supply-chain trust boundary.

**Build:**
- **Per-project git status** — branch, dirty count, ahead/behind. This is the
  high-frequency piece: it answers "is my work safe?" at a glance and pairs with
  snapshots as the recovery picture. Current real state for reference:
  `external-project-B` = branch `linux-uploader-support`, **22 dirty**, remote
  `<gh-user>/external-project-B`; `external-project-A` and `external-project-C` are **not repos** (came from
  Windows without `.git`); `claude-station` not a repo until item 0.1.
- **Actions**: commit, push, pull, create repo.
- **"Open terminal here"** — launches `kitty` in the project dir.

**Explicitly NOT an embedded terminal.** The app's premise is rendered chat, not
a terminal, and the user has kitty one keypress away (Super+Q) on a tiling WM. A
real terminal beats a worse fake one.

**Note:** the global command-guard hook already blocks destructive git
(`reset --hard`, `push --force`, `branch -D`), so agent-run git is covered.

---

## 4. Search — **agreed; design already settled by measurement**

**Measured on this machine:** store is **1.7 GB / 3,799 `.jsonl` files**;
`ripgrep 14.1.1` searches **all of it in 60–482 ms** (482 cold, ~60 warm).

**Therefore: no index.** Zero staleness (finds a message written seconds ago,
including in a session running in another terminal), nothing to invalidate.
Only build an index if rg is measured to be too slow — it isn't.

**Two tiers:**
1. **Titles** — already in memory from the session list → filters as you type.
2. **Contents** — ripgrep on Enter / short debounce.

**Scope:** all projects by default, toggle to current project. "Where did I
discuss X" usually can't be answered by project name.

**Deep-link to the exact message** — now possible: tail/forward/appended
messages share one canonical absolute `index` space (reconciled earlier). A hit
should open the session *at that message*, not the top of a 34,000-message
transcript.

**The hard part is presentation, not speed.** A raw `.jsonl` line is mostly
metadata (uuids, timestamps, tool payloads, base64). Extract the human-readable
text around the match, highlight the term, show who said it and when. Get this
wrong and it's as useless as the search being replaced.

**Open decision:** whether tool output is searchable. Lots of real content lives
there (file contents, command output) but so does the noise. Suggested: search
it, rank below prose, allow filtering it out.

---

## 5. Project-list recency — **agreed (small)**

Show **last-active recency on the project header** (e.g. "3 today" or a relative
timestamp). Answers "which did I work on recently" at a glance, **without
expanding anything**.

**Explicitly rejected, with reasons — don't rebuild these:**
- **Auto-expand projects with 24h activity** — if four projects were touched
  yesterday, four expand and the sidebar is back to the wall-of-sessions problem
  that was just fixed (was 1/6 projects visible; now 6/6). Expansion is the
  expensive operation; recency must not trigger it.
- **Archive / mark-inactive projects** — cheap to add (inverse of pin) but
  solves nothing at **8 projects**. Revisit around 20.
- **A triage workflow for "which of 10 sessions to keep"** — there is no loss to
  prevent. Sessions are permanent and search indexes all of them. The real fix
  is *rename at the moment you finish a session that mattered*, plus pin; both
  already exist.
- **A structured app-managed doc space for agent output** — the project repo
  already is that space (git-versioned, greppable, editor-friendly). A second
  location means two places to look. Revisit only if a concrete need appears.

---

## Known open issues

> **Status 2026-08-03:** items 1–5 all DONE and verified (`verify:search`,
> `verify:memories`, `verify:oom`, `verify:git`, recency in `/api/projects`).
> Dead fork suffix FIXED (forkInfo now returns forked/from — seen live in the
> verify suite's ack). Port collision FIXED: every harness probes a free port
> (env var still pins). System ripgrep 15.2.0 installed (`rg` was only a
> Claude Code shell function; spawn('rg') ENOENT'd).

- ~~**Dead code:** `app.js` renders a "forked from" suffix from `e.fork.forked` /
  `e.fork.from`, but `forkInfo()` returns neither field.~~ FIXED.
- ~~**Port collision:** a UI test stub squats on **4318**; a backend suite defaults
  there too. Running both collides — parameterise, and never bind a fixed port.~~ FIXED.
- **Unverified:** a real cross-project **fork** has never been executed
  end-to-end (costs a live turn; forking a large transcript once cost **$8.89**).
  Wire fields and armed state are verified. Try it on a *small* session first.
- **Unverified:** live-session **pin** 409 path (shares code with rename, not
  independently triggered); `startSnapshotStatus` ack path (proven by branch test
  against real source, not a live session).
- `sandbox` isolation remains unimplemented (501 by design). `bwrap` is installed.

---

## Process notes that actually matter

**The recurring bug class — five instances, all found by the user, none by any
suite:** *the interface asserting a state it had not reached.*
blank tool chips · a `+` button showing its parent row's path tooltip · a
"Choose a model" button that only opened settings · a toast announcing
"permissions skipped" when nothing changed · a question card that said
"ready — answer above" with no submit button.

Every one passed its tests, because the tests proved the *machinery* worked
(“a session launched with the override skips approvals”) rather than the *claim
the UI makes* (“clicking this does what it says”). **Test the transition a real
user takes, not just the endpoints.** The question-card bug is the cleanest
example: both end states were tested; the upgrade *between* them was not, and
that is the only path a user ever walks.

**`pkill -f` killed the user's running server five separate times**, plus one
agent killing another agent's server, plus self-kills of the invoking shell
(exit 144). Never match on a command substring or port. Scope cleanup by **pid**
or a unique env tag, and put the pattern in a **script file** so it never appears
in the caller's own command line.

**Agents sometimes leave the server stopped** after their work. Restart and
health-check before reporting anything as working.

**Never execute destructive commands to test a guard.** Evaluate them as text
(`guard.py explain` / `scan`, or pipe the hook payload). The tool only decides;
it never runs anything.

**Live model calls cost real money.** Use the cheapest model that exercises the
path; note `echo` is auto-approved even in `default` permission mode, so a
permission test must use a file **Write** or it passes vacuously.

---

## Environment facts (verified, don't re-derive)

- **Filesystem:** btrfs, with `/home` and `~/.local/share` on the SAME subvolume
  (no separate `@home`), which is what makes reflinks work between them. snapper
  timeline snapshots hourly with the cleanup timer enabled. 800 MiB reflink copy
  = **0 MiB** real growth, identical extents.
- **Command guard:** installed globally at `~/.claude/guard/`, wired as a
  `PreToolUse` hook (matcher `Bash`) in `~/.claude/settings.json`. ~21 ms/call.
  A timestamped backup of the settings file is written beside it. Escapes: `#SAFE:`
  first line, `GUARD_BYPASS=1`, `guard.py approve <hash>`.
  **Containers are NOT covered** (they mount only credentials + the project
  history dir). Deliberate: container isolation + hourly snapshots cover it, and
  an in-container hook would cost an LLM round-trip per trip.
- **Server:** `npm start` → `127.0.0.1:4317`. Suites: `verify` (80/80),
  `verify:ui`, `verify:live`, `verify:container`, `verify:browser`,
  `verify:snapshots`, `verify:decisions`, `verify:sessions`.
- **Design language:** greyscale with a faint green bias; exactly **one** moss
  accent (means "alive"); mono for machine values; serif for Claude's prose;
  hairlines; no new colours. Reuse existing patterns: popovers, arm-then-confirm,
  typed-name confirm, and **ack-before-claiming**.
</content>
</invoke>
