# Project conventions — claude-station

Project-specific working rules. Auto-injected into sessions launched for this
project (see src/server/templates.ts localConventionsSection). Grows by hand and
by relocation from the universal Working Agreement (`wa-consolidate --apply`, WA §L).

## Whoever owns a fact writes it down; no reader works it out again (ARCH-010, 2026-08-25)

Half of every defect on this board — 58 of 119, and eight of the nine architecture
tickets — is one habit: **a fact a reader has to act on is never written down by
whoever owns it, so each reader works it out again from something that does not
carry it.** Is this process alive? Does this work outlive the turn? Which project
is this view showing? Where does this record end? Each answer existed somewhere
and was never stated, so every call site substituted whatever signal was to hand —
right for the cases its author imagined, quietly wrong for the rest, and
unfixable one reader at a time.

The user settled it as a class on 2026-08-25 (ARCH-010, option A) rather than
answering it once per subsystem. **The rule:** every fact a reader has to act on
is written down once, by whoever owns it, and is never worked out a second time
by anyone who reads it.

Applied to a design choice it eliminates options, which is the point — it is a
decision procedure, not a slogan:

- an option that leaves **a second place able to hold a different answer** is out;
- an option that replaces N derivations with **one shared helper that still
  derives** is out — that is the same defect with fewer copies, and the next
  reader can still not call the helper;
- an option that adds **a check counting the places that derive it** is out —
  it buys the fix in more checking machinery, which this project already has
  more of than product (98k lines against 54k), and ARCH-010 rejects it by name;
- an option that **patches each surface as someone finds it** is out — six repeat
  chains on this board are the evidence that discovery does not converge.

What survives is the option where the fact is stated at its source and read
everywhere else. That is the bar for calling an instance settled: *declared by
its owner, in one place, and a reader that needs it reads it rather than
reconstructing it.*

Two things this rule does **not** say. It does not say a fact must be stated
where it cannot go stale — moving disagreement-between-readers to
freshness-at-the-writer is a different failure and needs its own attention where
the fact can change while it is being read. And it does not license a migration
of existing records to make a fact declarable: if a change needs one, stop and
ask, because 194 archived originals matter more than any one ticket.

Worked examples on this board: `ARCH-002` (lifetime declared at dispatch, not
inferred), `ARCH-009` (the derived proof field was deleted, and `verification[]`
carries attributed entries instead), `FEAT-100` (the `Dispatch:` line below),
`ARCH-001` (one liveness authority in `src/server/liveness.ts`).

## Declare the dispatch — one line at the top of every charter (FEAT-100, 2026-08-21)

Put this as the **first line of the charter**, before anything else:

    Dispatch: ticket=BUG-123 phase=fixing round=2 class=fix

Four facts, all of which you already know before you write a word of the charter,
and none of which anything used to ask you for:

| key | values | what it answers |
|---|---|---|
| `ticket` | one id, or a comma-separated list | which ticket(s) this lane's cost and hours belong to |
| `phase` | `finding` \| `fixing` \| `verifying` | which step of the ticket's life this is — the split the user asked for. `fixing` covers building a feature, not only repairing a bug |
| `round` | a positive integer | which attempt this is, so the verification yield curve is counted rather than reconstructed |
| `class` | `trivial` \| `fix` \| `explore` \| `plan+review` \| `arch` \| `verify` | the class WA §I already requires you to choose — this is where "recorded in the charter" actually lands |

Why a line of prose rather than a field somewhere: the charter is already being
written and already becomes the lane's first transcript message, which
`npm run cost:collect` already reads. So this adds no store, no extra write and
no runtime cost — it records what is already in your head at the one moment it
is known.

**Omit what you do not know. Never invent a value.** An absent field is reported
as `undeclared` and shows up in the coverage line; a wrong one silently poisons
every table it appears in. Two declarations that disagree are dropped entirely
rather than resolved, so do not paste a second one.

**Quoting the syntax is safe** — a `Dispatch:` line inside a fenced code block is
ignored, which is why the example above is indented instead of fenced.

For a dispatch that goes through the CLI rather than an in-process agent, pass
the same four as flags and the line is composed for you, validated by
round-tripping through the reader's own grammar:

    node scripts/dispatch.mjs --provider openai --ticket BUG-123 --phase verifying \
      --round 2 --class verify --meta-out <file> …

Read it back with `npm run cost:collect` (coverage + the per-ticket
finding/fixing/verifying split) or `node scripts/cost-collect.mjs --ticket=BUG-123`
for one ticket lane by lane. Grammar and both directions live in one place,
`scripts/lib/cost-model.mjs`.

## Testing — added 2026-08-18

Both rules come from the same failure shape seen repeatedly here: a check that
passed while the thing it guarded was wrong.

### Test against the real artifact, not a constructed one

Where a real instance exists — a real ticket, a real transcript, the real board,
a real session store — test against that. A fixture encodes its author's
assumptions, so a test built from a mental model confirms the model instead of
testing it. Every fixture swapped for the real thing here found something: a
sidebar cap passed 14/14 on a minimal fixture and broke on a real busy day; a
card passed every DOM assertion because every fixture item was one line and real
ones wrap. Synthetic is acceptable only when no real instance exists — and then
say so explicitly in the log.

### Test the real artifact's invariant PROPERTIES, not values legitimate use changes

Testing against the real artifact (above) does NOT mean pinning today's values in
it. A ticket's recommendation letter, which lane a ticket sits in, how many items
are in a lane — these change every time someone uses the product, correctly. A
suite that asserts `ticketDecision(real ARCH-003).recommended === 'B'` reddens the
moment the user answers ARCH-003 or a lane overturns its premise and drops the
token — and a suite that goes red when the user simply uses the product trains
everyone to ignore it. (Real instance, 2026-08-18: answering ARCH-003/ARCH-004 in
the UI + a premise overturn reddened `verify:feat-090`, `verify:reachability` and
`verify:feat-082-digest`, none of which had a code defect.)

Assert the INVARIANT instead. Discover a qualifying real ticket at runtime rather
than naming one (a ticket that carries a decision exposes ≥2 keyed options; the
digest DOM must MIRROR the server's own lane classification, whatever it currently
is), and fail LOUDLY if the board contains no qualifying artifact at all — that
itself is worth knowing. When a specific value must be exercised (a valid
`Recommended:` key surviving, a bogus one dropped), DRIVE it onto real prose
(`scripts/lib/real-decisions.mjs`: `setRecommendation`) so the test owns the one
value it turns on while the surrounding prose stays real — or pin a snapshot of
real prose at a known revision (`scripts/fixtures/feat-088/`). Either way: real
prose, no coupling to today's live values. And don't buy green with vacuity — a
property assertion must still FAIL when the property is genuinely violated.

### A must-FAIL proof must not be anchored to a moving baseline

A must-FAIL proof — the demonstration that a test reddens against the pre-fix
code — is only real if its baseline cannot change. Anchor it to `HEAD`, "current",
"latest", or any revision that moves and it works exactly once: the moment the fix
is committed, that reference BECOMES the fixed state, the proof can never fail
again, and nothing reports the degradation from guard to decoration. (Real
instance, commit `ec58f17`: `verify-feat-090-followup.mjs` proved non-vacuity by
diffing against `git show HEAD:<file>`; committing the fix made HEAD the fixed
state. The remedy was to synthesize the pre-fix state directly.) Anchor instead to
something fixed: a synthesized pre-fix state, an explicitly constructed broken
variant, or a snapshot pinned at a named revision. The tell that a baseline moves:
it names the thing being changed. Same trap, general form — any check whose
reference point IS its subject is vacuous once the subject moves. And a check that
adapts when its subject changes must fail LOUDLY when nothing qualifies at all, not
pass quietly: a suite that finds no candidate and reports success proves nothing.

### If another process writes it, test partial and truncated reads

For anything that reads a file, socket, or store while something else is
writing it, the suite must include partially-written states: take the REAL
artifact, truncate it at several plausible points, and grade each one. A race is
a timing, not a shape, so no static fixture can express it however adversarial —
a turn-end hook that graded a half-flushed transcript survived 32 builder tests,
63 adversarial tests and an independent 52/52, all built from the final state;
truncating the real transcript at the incident points reproduced the live
failure at once.

### Before diagnosing a UI defect, check what build is actually running

This project deploys by restarting a systemd `--user` service, so the running
server can be HOURS behind the working tree — and a stale build presents exactly
like a code defect. Before you diagnose, compare the service's start time to the
commit time of the fix in question:

```
systemctl --user show claude-station -p ActiveEnterTimestamp
git log -1 --format=%ad <fix-commit>
```

If the service started BEFORE the fix landed, the running server does not contain
it — the finding is deploy lag, not a code defect; say so and stop rather than
re-fixing correct code. If it started after, the build is current and the defect
is real. State the finding either way. (Real instances, 2026-08-18, three in one
day: a visual review filed two blocking findings against a parser fix that had
landed two hours AFTER the server started; a user report of unrendered markdown
was already fixed but not deployed; both were settled only by this timestamp
comparison.) Corollary for charters: when dispatching a UI fix, name which
findings are believed to be deploy lag, so the worker VERIFIES the running build
rather than re-fixing code that is already correct.

## Booting a scratch server — the isolation knob is `CLAUDE_STATION_DATA` (BUG-117)

Three directories, three variables, and only one of them decides which session
hosts a booting server will adopt — and reap:

- `CLAUDE_STATION_DATA` — the data dir (registry, templates, **`session-hosts/`**).
  Default `$XDG_DATA_HOME/claude-station`. **This is the isolation knob.**
- `CLAUDE_PROJECTS_DIR` — the transcript store. Default `~/.claude/projects`.
  Leave it unset and your scratch server reads the user's real transcripts.
- `CLAUDE_STATION_SCRATCH_DIR` — the scratch PROJECT's working dir. Unrelated.

`STATION_DATA_DIR` does not exist. Neither does any other spelling. A server
now REFUSES to start (exit 78) when a data-dir-shaped variable is set while
`CLAUDE_STATION_DATA` is not, and boot-time adoption now reaps only hosts this
server is entitled to — but build the env through
`scripts/lib/station-boot.mjs` (`isolatedServerEnv({ PORT, CLAUDE_STATION_DATA })`)
so the mistake is caught before the server ever runs.

Kill only by pid, only what you started. Hosts from an isolated server are named
`claude-station-host-t-*.scope`, so that glob — and only that glob — is safe to
aim at test leftovers; `claude-station-host-*` includes the user's live session.

**Copying a real host record into a fixture? Rewrite every path inside it.** A
`session-hosts/<key>.json` carries absolute `status` and `sock` paths in its own
body, and the cleanup path deletes what the record NAMES. Copy the user's live
record into a scratch dir, scrub only the pids, and a scan of your scratch dir
deletes the live host's files in the real dir — the isolation knob was set
correctly and did not save you, because the escape travelled in the data. That
happened on 2026-08-25 and cost the live session its socket inode.
`cleanupHostFiles` now confines deletion to the directory it scanned, so the
product is safe; your fixture still is not, because a record naming real paths
will mislead anything else that reads it. Rewrite `status`, `sock`, `errlog` and
the `.ctl.json` twins to your scratch dir, then scrub pids.

## Scratch — long-lived or expensive scratch does not go in `/tmp` here

`/etc/tmpfiles.d/tmp.conf` on this machine carries `D! /tmp 1777 root root 10d`:
all of `/tmp` is wiped **on every boot**, and swept at 10 days besides. That is
correct system policy, it is not to be changed, and it makes `/tmp` the wrong
home for two things the tooling builds:

- **Expensive** scratch. A clean room (`scripts/independent-verify.mjs`) exports
  the tree and copies this project's 374 MB / ~10,900-file `node_modules`.
- **Long-lived** scratch. A room kept with `--keep-cleanroom`, and the record dir
  holding `manifest.jsonl` + `<id>.out`, are the artifacts a verdict CITES — read
  when the ticket is closed, possibly days and one boot later.

Use `scripts/lib/scratch.mjs`: `mkdtempScratch(prefix)` instead of
`fs.mkdtempSync(path.join(os.tmpdir(), prefix))`. It resolves
`$CLAUDE_STATION_TMPDIR` → `$XDG_STATE_HOME/claude-station/scratch` →
`~/.local/state/claude-station/scratch`, and only then `$TMPDIR` / the system
temp dir, which it flags as `degraded` so a fallback is visible rather than
silent. (`$CLAUDE_STATION_TMPDIR` is tooling scratch; the pre-existing
`CLAUDE_STATION_SCRATCH_DIR` is a different thing — the scratch PROJECT's working
directory, `src/lib/paths.ts`.)

**Short-lived scratch stays on `/tmp`, deliberately.** A few JSON files written,
read and `rm`'d inside one `finally` block seconds later is exactly what `/tmp`
is for, and moving it to a persistent root only accumulates litter nothing
sweeps. The test for which side a directory falls on: *would losing it cost more
than re-running the thing that made it?* On that test only the clean room
qualifies today — the ~155 other `os.tmpdir()` call sites under `scripts/` are
per-run scratch data dirs removed in `finally`, and were left alone.

**The scratch root must be on the same filesystem as the repo.** `cp -a
--reflink=auto` does not fail across a filesystem boundary — it silently does a
full byte copy and exits 0, so the only symptom is that the copy got expensive.
Measured here on the real `node_modules`: reflink **456 ms and ~0 MB of disk**,
the same copy forced real **689 ms and 349 MB**. Note `du` cannot see this — it
sums allocated blocks and reports a perfect reflink copy as the full 373 MB;
the instrument that works is filesystem free space, after `sync -f`. So the
boundary is preflighted (`checkSameFilesystem`, the same shape
`src/server/snapshots.ts` uses: both devices, both filesystem types, what is
lost, and the knob that fixes it) and **reported** — unlike the snapshot store it
does not throw, because a snapshot on the wrong filesystem permanently consumes
the project's full size while a clean room is a throwaway that is merely slow.

Deliberately **not** age-swept: a sweeper here would re-invent what we just
escaped, and could delete a directory a still-running process is using. Kept
rooms are yours to remove; every caller prints the path it used.

Proof: `node scripts/verify-scratch-root.mjs` (28/28).

## Relocated from the universal Working Agreement — 2026-08-05

### From WA §B "B. Check what already exists before proposing to build or install"

- `/home` has automatic btrfs snapshots — an existing recovery layer.

### From WA §I "I. Orchestrate multi-item work; keep your own context lean"

- **Serena (symbol/LSP) is attached** — this repo's server files run 1,500–2,100 lines.

### From WA §I "I. Orchestrate multi-item work; keep your own context lean"

- **`ast-grep` is on PATH** — use it for structural / multi-site pattern hunts
  (`-p '<pattern>'`, dry-run `-r` for rewrites). Caveat: an over-tight pattern
  silently misses — sanity-check hit-count against a loose `rg` baseline.

## Tooling — search content with `rg`, never the Bash `grep` shim (BUG-103)

The Bash tool's `grep` is a `ugrep` shim run with `-I` (skip binary). On a file it
classifies as binary it **skips the whole file and prints nothing — no match, no
warning, exit non-error** — so an empty result is INDISTINGUISHABLE from a genuine
absence. A single NUL byte is enough to trip the classifier: `src/server/agent-bridge.ts`
(the largest, most bug-dense file here) carries one at line 2704, so
`grep -c parent_tool_use_id src/server/agent-bridge.ts` prints empty while
`/usr/bin/grep -c` and `rg -c` both return `6`. This produced a confident false
negative — BUG-096 concluded "no parent linkage in `src/server/`" and built three
failed fixes on that hole (see ARCH-003).

**Rule:** for any content hunt, use `rg` (unaffected; the house tool, beside `ast-grep`
above). If you must use the shim `grep`, confirm a suspicious empty result against
`rg` or `/usr/bin/grep -a` before concluding "absent" — a silent empty is a tool
skip until proven otherwise. See BUG-103 for the reproduction and remedies.

## Git — never put an identity on a commit command line (BUG-148, 2026-08-25)

`git -c user.email=… -c user.name=… commit`, `--author=…`, and `GIT_AUTHOR_EMAIL` /
`GIT_COMMITTER_EMAIL` all **outrank every config file, including this repo's local
`.git/config`.** That is by design, and it is why a correct `.git/config` cannot
protect you: the override wins precisely because you asked for it.

Three commits here carry the user's personal address in both author and committer
fields, the most recent on 2026-08-25 — days after global config was corrected —
and every one of them was an agent explicitly passing `-c user.email=` on the
command line. None of them had read `git config` first. The address came from the
agent's own context: the Claude Code harness injects a `userEmail` line (the
**account** email) into the system prompt of every session and subagent, so an
agent reaching for "the identity to commit under" finds a personal address sitting
right there and helpfully supplies it — overriding the repo identity that exists
specifically to keep that address out of the history.

**Rule:** when committing to a REAL repo, pass no identity at all — `git commit`
with no `-c user.*`, no `--author`, no `GIT_*` identity env. The repo's configured
identity is the answer, and it is already correct. The `userEmail` in your context
is the user's Anthropic account, not this repo's committer; it is never the right
value to type into a git command.

Scratch and fixture repos built by a verify script are the **only** exception, and
they must use an obviously-synthetic address (`t@t`, `verify@example.invalid`) —
never the user's. Stamping a real identity onto a throwaway fixture is what taught
later agents the habit in the first place.

Author metadata cannot be corrected by any ordinary commit, only by rewriting
history, so this rule is cheap to follow and expensive to break.

## Relocated from the universal Working Agreement — 2026-08-10

### From WA §I "I. Orchestrate multi-item work; keep your own context lean"

- **Separate process, not a subagent.** An orchestrator's in-process subagents inherit
  that session's instructions, board snapshot and framing — contaminated by construction.
  Verification goes out through the project's dispatch CLI (Orchard:
  `scripts/independent-verify.mjs`, which wraps `scripts/dispatch.mjs`).
