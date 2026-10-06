# Project conventions — claude-station

Project-specific working rules. Auto-injected into sessions launched for this
project (see src/server/templates.ts localConventionsSection). Grows by hand and
by relocation from the universal Working Agreement (`wa-consolidate --apply`, WA §L).

<!-- conventions-inject:start -->

## Whoever owns a fact writes it down; no reader works it out again (ARCH-010, 2026-08-25)

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

### A ticket's state is declared by the board — read it, don't reconstruct it (FEAT-149, 2026-09-23)

A direct corollary of ARCH-010 for the one fact the orchestrator cites most: a
ticket's status, round count, placement, dirty/committed state and latest
activity are **declared by the board**, and a reader runs `npm run board:status
-- <ID>` rather than reconstructing them from memory or from a lane's report.
The command is allowed under the orchestrator profile (node/npm only) and reads
through the board's own parser, so there is no second place able to hold a
different answer. Measured 2026-09-23: an orchestrator asserted one ticket's
review history four times from three contradictory lane reports and was wrong
each time, while the user read the real answer off their own board. Lane reports
are summaries written under their own framing and disagree by construction — the
board is the source, so check it.

### Independent verification is a TYPED entry with ONE writer — never a prose line (BUG-225, 2026-09-30)

Proof that a ticket was independently verified is a typed entry — `{provider, model,
run_id, verdict: holds|broken|invalid, author, recorded_at}` — in the ticket record's
`verification[]` (or, for a legacy prose ticket, the board's `verification-ledger.json`),
read by ONE function (`ticketVerifications`, scripts/lib/verification-source.mjs). Only a
HOLDS with no later BROKEN counts. Record it with the tool:

    node scripts/board-tool.mjs verified --id BUG-123 --provider anthropic \
      --model claude-opus-5 --run <dispatch run id> --verdict HOLDS

A hand-typed `Verified-by:` line counts for nothing, in any spelling. Lines written before
2026-09-30 are read from a frozen, hash-pinned snapshot
(`docs/bugs/verification-legacy.frozen.json`); `board:check` FAILs a dispatch-shaped
`Verified-by:` line typed after it, so the mistake is loud.

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

**Omit what you do not know. Never invent a value.** An absent field is reported
as `undeclared` and shows up in the coverage line; a wrong one silently poisons
every table it appears in. Two declarations that disagree are dropped entirely
rather than resolved, so do not paste a second one.

**Quoting the syntax is safe** — a `Dispatch:` line inside a fenced code block is
ignored, which is why the example above is indented instead of fenced.

## Testing — added 2026-08-18

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

## Container tests run in the standing Docker sandbox, never on the host daemon (FEAT-158, 2026-09-30)

The host daemon runs the user's live projects (BUG-216). Anything that creates, sweeps
or removes Docker objects runs in the one shared sandbox; do not build a private dind:

    npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"

`status` shows it, `reset` empties it (keeps images), `down` stops it (keeps the cache).
A destructive suite calls `assertIsolatedDocker()` (`scripts/lib/docker-sandbox.mjs`)
first: it refuses the host daemon, pins `DOCKER_HOST`, and takes the daemon's exclusive
lock, so lanes take turns (a waiter prints the holder; exit 3 on
`ORCHARD_DOCKER_LOCK_TIMEOUT`). A suite that must stay on the host (GPU, host `/proc`)
removes only what its own scratch server owns, via `scripts/lib/owned-docker.mjs`;
never a fixed-name `docker rm -f claude-station-<slug>`. Known limits (host `/tmp`
writable from the sandbox, lock rendezvous) are under "Docker sandbox detail" below.

**Which Docker a project's lanes use is a declared project setting (BUG-223).** Each
project declares `settings.laneDocker: 'sandbox' | 'host'` (Settings → Isolation & environment).
The live server reads it when it launches a direct session or a broker-dispatched lane. It never
scans the project's files at that point. A `sandbox` project's launch gets `DOCKER_HOST` at the
sandbox and `ORCHARD_LANE_DOCKER=<socket>`. A `host` project's launch gets
`ORCHARD_LANE_DOCKER=host`. Every descendant inherits `ORCHARD_LANE_DOCKER` as-is and never decides
again, and that includes scratch servers. An unusable value fails closed to an unreachable socket.
The initial value is set once, when the project is registered: `sandbox` if the project holds an
Orchard checkout or is empty, else `host`. Repointing a project at a directory that holds a
checkout moves it to `sandbox`. Nothing ever moves a project to `host` without the user. Rows older than the setting are classified once with
`npm run lane-docker:classify`, which backs up the registry first. An undeclared row runs on the
sandbox and logs a warning. The host is reached only through the logged opt-out:
`useHostDocker('<reason>')` (`scripts/lib/lane-docker.mjs`) in a suite, or
`eval "$(npm run -s sandbox:docker -- host-env '<reason>')"` in a shell. The live server's own
process and container sessions keep the host daemon.

## Restart checkpoint protocol (2026-09-30)

Snapshot every file before your first edit. On "CHECKPOINT NOW", follow "Restart
checkpoint protocol — detail" (below the injected region) and end with `CHECKPOINTED`.

## A Claude account dir is an overlay, not a copy — do not tidy it (FEAT-145, 2026-09-18)

**The invariant.** A Claude account dir is a **thin overlay over `~/.claude`
that differs in exactly ONE file, `.credentials.json`.** `projects` and
`settings.json` inside it are symlinks back into the real store. That is the
whole reason this design was chosen: there is still exactly one transcript
store, and not one reader anywhere in the codebase changed. An account is a
billing fact, not a history fact.

Under the ARCH-010 rule above, the id→dir fact is **declared by its owner in one
place** — `resolveAccountDir` / `resolveLaunchAccountDir` in
`src/server/claude-accounts.ts`. Nobody re-derives an account dir, and a `dir`
stored in the registry is recomputed from the id on read, so a hand-edited
registry cannot repoint an account at the real store. If you find yourself
composing an account path from parts, you are the second place able to hold a
different answer.

**`settings.json` stays symlinked; copying it is a data-loss trap dressed as
tidiness.** That file carries `cleanupPeriodDays: 36500`, the PreToolUse Bash
guard hook, the Stop response-format gate and `enabledPlugins`. A fresh config
dir defaults `cleanupPeriodDays` to **30**, so a copied settings file makes the
second account's CLI prune the shared transcripts the first account wrote. The
symlink is the only thing stopping that.

**`.claude.json` is deliberately NOT shared, and that is not an oversight.** It
caches `oauthAccount` — the account's own identity — and
`projects[<cwd>].hasTrustDialogAccepted`. Sharing it cross-contaminates identity
between plans. Verified against CLI 2.1.273: a fresh config dir hits no
onboarding wall and no trust wall for `-p` sessions, so there is nothing to gain
by sharing it and an identity mixup to lose.

**The CLI's own retention sweep skips a symlinked `projects`** — it `lstat`s the
path and bails unless `isDirectory()`. That is benign and load-bearing: the real
store is swept once, by the default account, under its own settings. Do not
"fix" it by chasing the symlink.

**`CLAUDE_CONFIG_DIR` must never be forwarded into a container.** Only the
credential file's host side moves — `desiredBinds()` binds that one file and
nothing else. The account dir's `projects` and `settings.json` are HOST-path
symlinks that dangle inside a container, so pointing the containerised CLI at
the account dir gives it a broken transcript path; pointing it at an unset dir
gives it a fresh one with `cleanupPeriodDays` back to 30. There is a comment on
`ENV_PASSTHROUGH` saying so; keep it there.

**Container account selection is project-scope only, never per-session.**
`desiredBinds()` is the container drift oracle, so a per-session account switch
recreates the container under every OTHER session on that project. This is the
same reason `mounts` is project-scope-only. Direct (non-containerised) projects
get the per-session override; container projects get an explicit refusal, never
a silent no-op.

**The store-isolation guard's rule, as a specification: a comparison failure may
only ARM the guard, never disarm it.** `assertSessionStoreIsolated` concludes
"isolated" only from a COMPLETED resolution; every unresolvable path takes the
real-store branch. Two false-negative disarms have already been found and closed
in that code — a dangling `projects` symlink whose leaf `realpathSync` reported
as ENOENT, and a non-ENOENT errno (`ELOOP`/`EACCES`) hitting the same
value-returning fallback. Both were "an error branch that returns a value
instead of refusing". This is why the guard walks the path component by
component and reads link **targets** with `readlinkSync` rather than delegating
to `realpathSync`: a dangling link's INTENT is what must be compared, and
`realpathSync` cannot report it. Do not simplify it back. `ENOENT` from `lstat`
is the only branch allowed to continue, because absence is a fact — nothing can
exist beneath a missing component.

**`claude auth status --json` exits 1 when logged out and still prints valid
JSON.** Parse `loggedIn`; never branch on the exit code. `email` **may or may
not be populated** — it was seen `null` on one account and a real address on
two others (CLI 2.1.273) — so nothing may branch on it being present or
absent. That is not why account labels are user-supplied: the real reason is
that a label is the user's own name for a subscription (e.g. "work" vs.
"personal"), and an email address — even when the CLI does report one — is not
a reliable identifier to build the UI around.

## Scratch — long-lived or expensive scratch does not go in `/tmp` here

`/etc/tmpfiles.d/tmp.conf` on this machine carries `D! /tmp 1777 root root 10d`:
all of `/tmp` is wiped **on every boot**, and swept at 10 days besides. That is
correct system policy, it is not to be changed, and it makes `/tmp` the wrong
home for two things the tooling builds:

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

**Who this rule is addressed to (FEAT-096, 2026-08-25).** A DISPATCHED LANE, which
is what does content hunts. The orchestrating session cannot follow it: with the
orchestrator profile enabled — which it now is on every project — `rg`, `grep`,
`cat` and friends are refused for the main thread, and the refusal names
dispatching as the way through. That is not a conflict between the two rules, it is
the division of labour they both assume: the orchestrator dispatches the hunt, the
lane runs `rg` and reports. If you are the orchestrator and you find yourself
reaching for this rule, the rule you actually want is the working agreement's §I.

## Git — never put an identity on a commit command line (BUG-148, 2026-08-25)

`git -c user.email=… -c user.name=… commit`, `--author=…`, and `GIT_AUTHOR_EMAIL` /
`GIT_COMMITTER_EMAIL` all **outrank every config file, including this repo's local
`.git/config`.** That is by design, and it is why a correct `.git/config` cannot
protect you: the override wins precisely because you asked for it.

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

## Publishing — this is an ordinary git repo now; there is no mirror (2026-08-25)

**How to publish: `git commit`, then `git push`. That is the whole procedure.**
No mirror script, no scratch build tree, no scrub step, no force push.

`main` tracks `origin/main` on the public GitHub repo already configured as
`origin` (`git remote -v`), and the two are equal. Leave that remote as it is —
it is the only one you need. The published history begins at a single root commit,
`609db5e "Orchard — initial public release"`, whose tree is byte-identical to
the working tree the 369-commit local history had produced. On 2026-08-25 local
`main` was collapsed onto that commit, so local and published now share one
history and a plain `git push` is an ordinary fast-forward.

**Never push the preserved branch.** It is exactly the leaking history. In
practice that means: push `main` and ordinary feature branches; never
`git push --all`, never `git push origin local-history-before-collapse-*`, and
never `--force` to `main` in the routine path.

`scripts/publish-public-mirror.sh` and the mirror-era verify scripts are
**historical**. They existed to rebuild a clean tree because local history could
not be published; that problem is solved and running them again would recreate
the split this removed. Do not reach for them, and do not write a replacement.

Because every commit on `main` is now directly publishable, `npm run gate` before
committing is no longer a formality — it is the only thing standing between a new
leak and the public repo.

## Relocated from the universal Working Agreement — 2026-08-10

### From WA §I "I. Orchestrate multi-item work; keep your own context lean"

- **Separate process, not a subagent.** An orchestrator's in-process subagents inherit
  that session's instructions, board snapshot and framing — contaminated by construction.
  Verification goes out through the project's dispatch CLI (Orchard:
  `scripts/independent-verify.mjs`, which wraps `scripts/dispatch.mjs`).

<!-- conventions-inject:end -->

## Docker sandbox detail: guard, lock and known limits (FEAT-158)

The host Docker daemon runs the user's live projects. BUG-216 is what happens when
a test removes things there. Anything that creates, sweeps or removes containers,
networks, volumes or images runs in the one shared sandbox:

    npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"

`up` is idempotent: about 2 s warm, about 22 s cold, with Orchard's base and the
fixture images already loaded. `status` shows what is in it. `reset` removes its
containers, networks and volumes and keeps images and build cache. `down` stops it
and keeps the cache. Do not build a private docker-in-docker.

A destructive suite calls `assertIsolatedDocker()` from `scripts/lib/docker-sandbox.mjs`
first. It compares daemon IDs and refuses unless the daemon is provably not the
host's. "The host" is every well-known host socket addressed directly plus the
default context, so a persisted `docker context use` cannot disguise it. A new
destructive suite must call it too.

**The sandbox is shared, and a lock makes that safe.** The guard, `reset`, `down` and a
restarting `up` each take an exclusive lock on the target daemon. The lock is a kernel
`flock` on `.orchard-docker.lock` beside the daemon's socket, so every lane that reaches
the daemon shares it, whatever its `XDG_STATE_HOME`. A second lane waits, printing who
holds the lock, and exits 3 with `TIMED OUT` after `ORCHARD_DOCKER_LOCK_TIMEOUT` seconds
(default 1800). The lock is held until the holder and every child it started have exited.
That includes `kill -9` of the holder: the lock is not freed while its server child is
still working, and no stale lock is left once they are gone. A suite's own children
re-enter its lock. Lanes therefore take turns in the one warm daemon; they do not run in
it concurrently.

**A suite that stays on the host removes only what it owns.** Some container suites
cannot run in the sandbox (GPU/CDI, host `/proc`). Their cleanup goes through
`scripts/lib/owned-docker.mjs`, which removes a container or image only if it carries
this run's scratch data-dir owner key (the BUG-216 `claude-station.owner` label). A
fixed-name `docker rm -f claude-station-<slug>` removes another instance's container of
the same name, so do not write one.

**Known limit: host `/tmp` and scratch are writable from the sandbox.** They are mounted
at the same paths so that bind mounts resolve. The guard protects the daemon, not those
files. A container in the sandbox can read and write them just as the test itself can,
including any unix socket that lives there (an ssh-agent or tmux socket under `/tmp`).
The guard also does not defend against a hostile `docker` binary on `PATH` or a lying
socket proxy, which could answer `info` from one daemon and act on another. When the
host socket is masked (a jailed lane), `HOST_DOCKER_ID` is trusted as the host's id, so
take it from `sandbox:docker env`, never type it by hand. `DOCKER_HOST` must be exactly
`unix:///<absolute path>` or `tcp://host:port`; the guard pins a unix path to its real path
and writes that back into `DOCKER_HOST`. The lock is shared only by lanes that reach the
socket's directory: a lane that bind-mounts the socket FILE alone elsewhere, or reaches the
daemon over `tcp://`, gets a different lock. A worker that detaches itself from the suite's
process tree (`setsid`, a double fork) is not waited for. The socket is a file in a dir you
own, so replacing it after a suite's guard has checked it redirects that suite; `reset` is
not affected (it checks the daemon id and removes over one connection). The CLI's other host
paths are path-based too: a same-uid process that swaps the run dir for a symlink between `up`'s
check and dockerd's bind moves the socket there, and `down --purge` removes the volume by name
after a last label check (Docker has no conditional delete). Likewise `owned-docker.mjs`
removes images by tag after listing them by owner label, so a tag re-pointed in between goes,
and a suite's own per-run image tags (which carry no owner label) are removed by name.
A scratch server (explicit `CLAUDE_STATION_DATA`) adopts no unlabelled container, network or
volume; only the shared instance keeps its pre-label objects (`mayActOn`, instance-owner.ts).

## Restart checkpoint protocol — detail (standard text for every long lane's charter)

An Orchard restart deploys whatever is in the working tree. A lane caught mid-edit
ships half-finished hunks, and the restart also kills the lane's own turn. So every
charter for a lane that may outlive one restart window carries this text verbatim:

> **Before your first edit:** copy the pre-lane version of every file you will touch
> to `$scratch/<lane>/pre/` (use `scripts/lib/scratch.mjs`, never `/tmp`). Add each
> new file to the list the moment you decide to touch it.
>
> **On "CHECKPOINT NOW"** (from the orchestrator), stop editing and, in order:
> 1. Stop every child you started, by process group (`kill -- -<pgid>`), never
>    `pkill` and never a process you did not start.
> 2. Release the Docker sandbox lock by letting those children exit. Do not delete
>    the lock file.
> 3. Save the WIP under `$scratch/<lane>/wip-<timestamp>/`: `git diff -- <your files>`
>    as a patch, plus full copies of every file you touched (new files included).
> 4. Restore only YOUR hunks. For a file only you touched, copy back its `pre/` copy.
>    For a file other lanes also changed, reverse-apply only your hunks
>    (`git apply -R` of your own patch). Never run `git checkout`/`git stash`/
>    `git restore` on the tree: they take other lanes' changes too.
> 5. Run `npm run gate` unpiped and read its exit status.
> 6. Append to your ticket's Activity log: the WIP path, the files restored, the
>    gate result, and what remains.
> 7. End your turn with the single word `CHECKPOINTED`.
>
> **On resume:** re-apply your saved patch over the CURRENT tree (`git apply --3way`),
> not over your `pre/` copies, so changes other lanes landed during the restart are
> kept. Resolve conflicts by hand, then re-run your must-FAIL proof before going on.
> Nothing you verified before the checkpoint counts as verified after it.

## Background, history & evidence (not injected into sessions — read this file in full for these)

Half of every defect on this board — 58 of 119, and eight of the nine architecture
tickets — is one habit: **a fact a reader has to act on is never written down by
whoever owns it, so each reader works it out again from something that does not
carry it.** Is this process alive? Does this work outlive the turn? Which project
is this view showing? Where does this record end? Each answer existed somewhere
and was never stated, so every call site substituted whatever signal was to hand —
right for the cases its author imagined, quietly wrong for the rest, and
unfixable one reader at a time.

Worked examples on this board: `ARCH-002` (lifetime declared at dispatch, not
inferred), `ARCH-009` (the derived proof field was deleted, and `verification[]`
carries attributed entries instead), `FEAT-100` (the `Dispatch:` line below),
`ARCH-001` (one liveness authority in `src/server/liveness.ts`), `FEAT-145`
(one account-id→dir authority; see the account-dir overlay section below).

Why a line of prose rather than a field somewhere: the charter is already being
written and already becomes the lane's first transcript message, which
`npm run cost:collect` already reads. So this adds no store, no extra write and
no runtime cost — it records what is already in your head at the one moment it
is known.

For a dispatch that goes through the CLI rather than an in-process agent, pass
the same four as flags and the line is composed for you, validated by
round-tripping through the reader's own grammar:

    node scripts/dispatch.mjs --provider openai --ticket BUG-123 --phase verifying \
      --round 2 --class verify --meta-out <file> …

Read it back with `npm run cost:collect` (coverage + the per-ticket
finding/fixing/verifying split) or `node scripts/cost-collect.mjs --ticket=BUG-123`
for one ticket lane by lane. Grammar and both directions live in one place,
`scripts/lib/cost-model.mjs`.

Both rules come from the same failure shape seen repeatedly here: a check that
passed while the thing it guarded was wrong.

Everything in this section looks like a bug in isolation. Each item is here
because a reader who "fixed" it would split the transcript store, prune the
user's history, or silently disarm a data-loss guard.

- **Expensive** scratch. A clean room (`scripts/independent-verify.mjs`) exports
  the tree and copies this project's 374 MB / ~10,900-file `node_modules`.
- **Long-lived** scratch. A room kept with `--keep-cleanroom`, and the record dir
  holding `manifest.jsonl` + `<id>.out`, are the artifacts a verdict CITES — read
  when the ticket is closed, possibly days and one boot later.

Deliberately **not** age-swept: a sweeper here would re-invent what we just
escaped, and could delete a directory a still-running process is using. Kept
rooms are yours to remove; every caller prints the path it used.

Proof: `node scripts/verify-scratch-root.mjs` (28/28).

Three commits here carry the user's personal address in both author and committer
fields, the most recent on 2026-08-25 — days after global config was corrected —
and every one of them was an agent explicitly passing `-c user.email=` on the
command line. None of them had read `git config` first. The address came from the
agent's own context: the Claude Code harness injects a `userEmail` line (the
**account** email) into the system prompt of every session and subagent, so an
agent reaching for "the identity to commit under" finds a personal address sitting
right there and helpfully supplies it — overriding the repo identity that exists
specifically to keep that address out of the history.

**Why it was collapsed, so nobody helpfully restores it.** Those 369 commits
contain real, unremovable leaks — at a commit from that same day the leak gate
fails with 12 hits across 3 files, including two real Codex session paths and a
client's product terms. The leaks are in the *history*, which no later commit
can fix. Collapsing is what makes local match published and is the only thing
stopping that history being pushed later by someone treating this as a normal
repo. If you find yourself about to publish "the full history", this paragraph
is the answer to why you must not.

**The old history is preserved, not lost:** local branch
`local-history-before-collapse-20260825` (369 commits, tip `9e74119`), plus the
bundle and `.git` copy under `~/scratch/orchard-backup-20260825/`, plus remote
branch `backup-before-publish-20260825`. Do not delete any of these.
